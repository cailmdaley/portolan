/**
 * HttpApiFilesSearch — cross-project file API (search + tree).
 *
 * Stage E of constitution-portolan-navigation-layer. Mirrors the shape of
 * `HttpApiGlobalSearch` but for *files* instead of fibers: the Find
 * dashboard's Files column uses two endpoints over the same multi-host
 * fan-out:
 *
 *   - `/global-files-search?q=…` — flat ranked list across every pinned
 *     local city. Used when the search input is non-empty; results merge
 *     with `/global-search` fiber hits in `FindHost` to render the
 *     constitution's "Fibers + Files collapse into one ranked list."
 *
 *   - directory listings — already served via the WebSocket protocol's
 *     `listDirectory` / `directoryListing` round-trip (WorkspaceBrowser).
 *     The Files column reuses that protocol for lazy node-expansion;
 *     this HTTP endpoint is the search complement, not a tree replacement.
 *
 * Search strategy: ask the Rust `portolan-index` helper for a persistent
 * SQLite/FTS-backed candidate set per pinned local city. The TypeScript route
 * keeps the HTTP wire contract and final fzy ranking, but the expensive
 * filesystem walk and cross-process persistence now belong to the Rust
 * substrate. Tests can still inject the older walk-shaped seam for focused
 * cache behavior.
 *
 * Remote-origin file search is a follow-up: snapshot stores carry fiber
 * ids but not the underlying filesystem layout, and a per-keystroke SSH
 * fan-out is too expensive. The constitution's Scope §"In" restricts this
 * stage to local hosts; remote files surface only via per-city HUD or the
 * agent's own listing channels.
 */

import type { ServerResponse } from 'http';
import { realpathSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { score as fzyScore, hasMatch } from 'fzy.js';
import { searchCityIndexWithRust, walkCityIndexWithRust } from './RustFileIndexer.js';

// ============================================================================
// Wire types
// ============================================================================

export interface GlobalFileHit {
  /** Absolute path on disk; click-through resolves through this. */
  fullPath: string;
  /** Path relative to the owning city's root (no leading `./`). */
  relativePath: string;
  /** Filename / dirname only — what the row leads with. */
  name: string;
  /** `dir` or `file` — drives the kind badge in the merged results list. */
  type: 'dir' | 'file';
  /** Pinned local city that owns this hit. Always set (no remote files). */
  cityId: string;
  /** City display name; included so the frontend doesn't have to re-resolve. */
  cityName?: string;
  /** Origin label — always `local` today. Reserved for the remote-files
   *  follow-up so the wire shape doesn't churn. */
  originId: string;
  /** Composite fzy score (filename-weighted; full path contributes a
   *  damped tail). Higher is better. */
  score: number;
}

export interface GlobalFilesSearchResponse {
  hits: GlobalFileHit[];
  generatedAt: number;
  /** Per-city diagnostic so the frontend can surface a graceful empty
   *  state when one city's walk fails or times out without dropping the
   *  whole response. */
  warnings?: Array<{ cityId: string; message: string }>;
}

// ============================================================================
// Options
// ============================================================================

interface HttpApiFilesSearchOptions {
  /** Pinned local cities (id + path + name). Without this the fan-out has
   *  nothing to walk — the endpoint returns an empty hit list rather than
   *  crashing; the frontend already renders an "no connected cities"
   *  empty state for that branch. */
  cities?: Array<{ id: string; path: string; name?: string }>;
  /** Default cap for `?limit=`. Defaults to 30 — same as the fiber
   *  search so a combined ranked list doesn't get half-dominated by the
   *  cheaper-to-walk axis. */
  defaultLimit?: number;
  /** Hard cap for `?limit=`. */
  maxLimit?: number;
  /** Per-city wall-clock budget in ms. Defaults to 1500ms — fast typers
   *  shouldn't be chasing a search that's already stale. */
  perCityTimeoutMs?: number;
  /** Bound concurrent city index refreshes. Defaults to 4. */
  maxConcurrentCitySearches?: number;
  /** TTL for each per-city candidate index. Defaults to 30s. */
  indexTtlMs?: number;
  /** Hard cap for indexed candidates per city. Defaults to 20k. */
  maxIndexedEntriesPerCity?: number;
  /** File-walk substrate. Defaults to the Rust `portolan-index` helper. */
  walkCityIndex?: CityIndexWalker;
  /** Query substrate. Defaults to the Rust SQLite/FTS `portolan-index` helper. */
  searchCityIndex?: CityIndexSearcher;
  /** Diagnostic label for the active substrate. */
  indexerKind?: string;
}

// ============================================================================
// Class
// ============================================================================

interface CityFileIndex {
  cityId: string;
  cityName?: string;
  cityPath: string;
  entries: GlobalFileHit[];
  builtAt: number;
  expiresAt: number;
  durationMs: number;
  refreshCount: number;
  visitedDirs?: number;
  ignoredDirs?: number;
  unreadableDirs?: number;
  truncated: boolean;
  timedOut: boolean;
  warnings: string[];
  indexerKind: string;
  mode: 'candidate-cache' | 'persistent-search';
  query?: string;
  indexRefreshed?: boolean;
  indexAgeMs?: number;
  databasePath?: string;
}

export interface FileWalkEntry {
  relativePath: string;
  type: 'dir' | 'file';
}

export interface FileWalkResult {
  entries: FileWalkEntry[];
  timedOut: boolean;
  stderr: string;
  visitedDirs?: number;
  ignoredDirs?: number;
  unreadableDirs?: number;
  truncated: boolean;
  indexRefreshed?: boolean;
  indexAgeMs?: number;
  databasePath?: string;
}

export type CityIndexWalker = (
  cityPath: string,
  maxEntries: number,
  timeoutMs: number,
) => Promise<FileWalkResult>;

export type CityIndexSearcher = (
  cityPath: string,
  query: string,
  limit: number,
  maxEntries: number,
  refreshTtlMs: number,
  timeoutMs: number,
) => Promise<FileWalkResult>;

export interface FilesSearchDiagnostics {
  ttlMs: number;
  maxIndexedEntriesPerCity: number;
  cachedCities: number;
  inFlight: number;
  totalEntries: number;
  mode: 'candidate-cache' | 'persistent-search';
  cities: Array<{
    cityId: string;
    cityName?: string;
    path: string;
    entries: number;
    visitedDirs?: number;
    ignoredDirs?: number;
    unreadableDirs?: number;
    builtAt: number;
    expiresInMs: number;
    durationMs: number;
    refreshCount: number;
    truncated: boolean;
    timedOut: boolean;
    warnings: string[];
    indexerKind: string;
    mode: 'candidate-cache' | 'persistent-search';
    query?: string;
    indexRefreshed?: boolean;
    indexAgeMs?: number;
    databasePath?: string;
  }>;
}

export class HttpApiFilesSearch {
  private readonly cities: Array<{ id: string; path: string; name?: string }>;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;
  private readonly perCityTimeoutMs: number;
  private readonly maxConcurrentCitySearches: number;
  private readonly indexTtlMs: number;
  private readonly maxIndexedEntriesPerCity: number;
  private readonly walkCityIndexImpl: CityIndexWalker;
  private readonly searchCityIndexImpl: CityIndexSearcher | undefined;
  private readonly indexerKind: string;
  private readonly cityIndexes = new Map<string, CityFileIndex>();
  private readonly cityIndexInFlight = new Map<string, Promise<CityFileIndex>>();

  constructor(opts: HttpApiFilesSearchOptions = {}) {
    this.cities = opts.cities ?? [];
    this.defaultLimit = opts.defaultLimit ?? 30;
    this.maxLimit = opts.maxLimit ?? 200;
    this.perCityTimeoutMs = opts.perCityTimeoutMs ?? 1500;
    this.maxConcurrentCitySearches = opts.maxConcurrentCitySearches ?? 4;
    this.indexTtlMs = opts.indexTtlMs ?? 30_000;
    this.maxIndexedEntriesPerCity = opts.maxIndexedEntriesPerCity ?? 20_000;
    this.walkCityIndexImpl = opts.walkCityIndex ?? walkCityIndexWithRust;
    this.searchCityIndexImpl =
      opts.searchCityIndex ?? (opts.walkCityIndex ? undefined : searchCityIndexWithRust);
    this.indexerKind = opts.indexerKind ?? (this.searchCityIndexImpl ? 'rust-sqlite' : 'rust');
  }

  /**
   * GET /global-files-search?q=…
   *
   * Empty query short-circuits to no hits; the empty-state body of the
   * Files column comes from per-city directory listings (WS), not this
   * endpoint, so an empty query has no work to do.
   */
  async handleSearch(url: URL, res: ServerResponse): Promise<void> {
    const q = (url.searchParams.get('q') ?? '').trim();
    const cityId = (url.searchParams.get('cityId') ?? '').trim() || undefined;
    const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(this.maxLimit, limitParam))
      : this.defaultLimit;

    if (!q) {
      this.json(res, 200, { hits: [], generatedAt: Date.now() });
      return;
    }

    try {
      const { hits, warnings } = await this.search(q, limit, cityId);
      const body: GlobalFilesSearchResponse = {
        hits,
        generatedAt: Date.now(),
      };
      if (warnings.length > 0) body.warnings = warnings;
      this.json(res, 200, body);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      console.error('[FilesSearch] failed:', msg);
      this.json(res, 500, { error: msg });
    }
  }

  /**
   * Public for testing — fan-out walk per city, fzy-rank the merged set,
   * return the top N. Per-city walks are concurrent with `Promise.all` so
   * the wall-clock is bounded by the slowest city, not the sum.
   *
   * Returns warnings alongside hits so the frontend can render a graceful
   * empty state ("no matches; <city> timed out") instead of throwing on a
   * single laggy felt host.
   */
  async search(
    q: string,
    limit: number,
    cityId?: string,
  ): Promise<{ hits: GlobalFileHit[]; warnings: Array<{ cityId: string; message: string }> }> {
    if (!q.trim()) return { hits: [], warnings: [] };
    const cities = cityId
      ? this.cities.filter((city) => city.id === cityId)
      : this.cities;
    if (cities.length === 0) return { hits: [], warnings: [] };

    if (this.searchCityIndexImpl) {
      return this.searchPersistent(q, limit, cities);
    }

    const perCity = await mapSettledWithConcurrency(
      cities,
      Math.max(1, this.maxConcurrentCitySearches),
      (city) => this.getCityIndex(city),
    );

    const merged: GlobalFileHit[] = [];
    const warnings: Array<{ cityId: string; message: string }> = [];

    for (let i = 0; i < perCity.length; i++) {
      const result = perCity[i];
      const city = cities[i];
      if (result.status === 'rejected') {
        const message = (result.reason as { message?: string })?.message ?? String(result.reason);
        warnings.push({ cityId: city.id, message });
        continue;
      }
      for (const message of result.value.warnings) {
        warnings.push({ cityId: city.id, message });
      }
      for (const hit of result.value.entries) {
        if (hasMatch(q, hit.name) || hasMatch(q, hit.relativePath)) {
          merged.push(hit);
        }
      }
    }

    // Final ranking pass: fzy-score the (relativePath, name) pair to keep
    // basename matches dominant ("StashForm" matches over "deep/dir/x.tsx"
    // when both contain the needle) while still favouring shorter path
    // prefixes. Sort + slice; the per-city index cap above already trimmed
    // the long tail.
    const ranked = merged
      .map((hit) => ({ hit, s: rerankScore(hit, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s);

    const hits = ranked.slice(0, limit).map((entry) => ({
      ...entry.hit,
      score: entry.s,
    }));

    return { hits, warnings };
  }

  /**
   * Runtime view for /debug-runtime. Operators can see whether Find is using
   * one bounded candidate set per city or rebuilding repeatedly.
   */
  getDiagnostics(): FilesSearchDiagnostics {
    const now = Date.now();
    const cities = [...this.cityIndexes.values()].map((entry) => ({
      cityId: entry.cityId,
      cityName: entry.cityName,
      path: entry.cityPath,
      entries: entry.entries.length,
      builtAt: entry.builtAt,
      expiresInMs: Math.max(0, entry.expiresAt - now),
      durationMs: entry.durationMs,
      refreshCount: entry.refreshCount,
      visitedDirs: entry.visitedDirs,
      ignoredDirs: entry.ignoredDirs,
      unreadableDirs: entry.unreadableDirs,
      truncated: entry.truncated,
      timedOut: entry.timedOut,
      warnings: entry.warnings,
      indexerKind: entry.indexerKind,
      mode: entry.mode,
      query: entry.query,
      indexRefreshed: entry.indexRefreshed,
      indexAgeMs: entry.indexAgeMs,
      databasePath: entry.databasePath,
    }));
    return {
      ttlMs: this.indexTtlMs,
      maxIndexedEntriesPerCity: this.maxIndexedEntriesPerCity,
      cachedCities: cities.length,
      inFlight: this.cityIndexInFlight.size,
      totalEntries: cities.reduce((sum, city) => sum + city.entries, 0),
      mode: this.searchCityIndexImpl ? 'persistent-search' : 'candidate-cache',
      cities,
    };
  }

  private async searchPersistent(
    q: string,
    limit: number,
    cities: Array<{ id: string; path: string; name?: string }>,
  ): Promise<{ hits: GlobalFileHit[]; warnings: Array<{ cityId: string; message: string }> }> {
    const candidateLimit = Math.min(
      this.maxIndexedEntriesPerCity,
      Math.max(limit * 8, Math.min(200, this.maxIndexedEntriesPerCity)),
    );
    const perCity = await mapSettledWithConcurrency(
      cities,
      Math.max(1, this.maxConcurrentCitySearches),
      (city) => this.getPersistentCityIndex(city, q, candidateLimit),
    );

    const merged: GlobalFileHit[] = [];
    const warnings: Array<{ cityId: string; message: string }> = [];

    for (let i = 0; i < perCity.length; i++) {
      const result = perCity[i];
      const city = cities[i];
      if (result.status === 'rejected') {
        const message = (result.reason as { message?: string })?.message ?? String(result.reason);
        warnings.push({ cityId: city.id, message });
        continue;
      }
      for (const message of result.value.warnings) {
        warnings.push({ cityId: city.id, message });
      }
      for (const hit of result.value.entries) {
        if (hasMatch(q, hit.name) || hasMatch(q, hit.relativePath)) {
          merged.push(hit);
        }
      }
    }

    const ranked = merged
      .map((hit) => ({ hit, s: rerankScore(hit, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s);

    const hits = ranked.slice(0, limit).map((entry) => ({
      ...entry.hit,
      score: entry.s,
    }));

    return { hits, warnings };
  }

  private async getPersistentCityIndex(
    city: { id: string; path: string; name?: string },
    q: string,
    candidateLimit: number,
  ): Promise<CityFileIndex> {
    const key = citySearchKey(city, q, candidateLimit);
    const now = Date.now();
    const cached = this.cityIndexes.get(key);
    if (cached && cached.expiresAt > now) return cached;

    const inFlight = this.cityIndexInFlight.get(key);
    if (inFlight) return inFlight;

    const pending = this.buildPersistentCityIndex(
      city,
      q,
      candidateLimit,
      cached?.refreshCount ?? 0,
    )
      .then((entry) => {
        this.cityIndexes.set(key, entry);
        return entry;
      })
      .catch((err: unknown) => {
        if (!cached) throw err;
        const message = (err as { message?: string })?.message ?? String(err);
        return {
          ...cached,
          warnings: [`persistent index search failed; showing stale entries: ${message}`],
        };
      })
      .finally(() => {
        if (this.cityIndexInFlight.get(key) === pending) {
          this.cityIndexInFlight.delete(key);
        }
      });
    this.cityIndexInFlight.set(key, pending);
    return pending;
  }

  private async buildPersistentCityIndex(
    city: { id: string; path: string; name?: string },
    q: string,
    candidateLimit: number,
    priorRefreshCount: number,
  ): Promise<CityFileIndex> {
    const startedAt = Date.now();
    const cityPath = realpathSync(city.path);
    if (!existsSync(cityPath)) {
      return this.recordPersistentCityIndex(city, cityPath, q, [], startedAt, {
        entries: [],
        truncated: false,
        timedOut: false,
        stderr: '',
      }, priorRefreshCount);
    }
    const search = await this.searchCityIndexImpl!(
      cityPath,
      q,
      candidateLimit,
      this.maxIndexedEntriesPerCity + 1,
      this.indexTtlMs,
      this.perCityTimeoutMs,
    );
    return this.recordPersistentCityIndex(city, cityPath, q, search.entries, startedAt, search, priorRefreshCount);
  }

  private async getCityIndex(city: { id: string; path: string; name?: string }): Promise<CityFileIndex> {
    const key = cityIndexKey(city);
    const now = Date.now();
    const cached = this.cityIndexes.get(key);
    if (cached && cached.expiresAt > now) return cached;

    const inFlight = this.cityIndexInFlight.get(key);
    if (inFlight) return inFlight;

    const pending = this.buildCityIndex(city, cached?.refreshCount ?? 0)
      .then((entry) => {
        this.cityIndexes.set(key, entry);
        return entry;
      })
      .catch((err: unknown) => {
        if (!cached) throw err;
        const message = (err as { message?: string })?.message ?? String(err);
        return {
          ...cached,
          warnings: [`index refresh failed; showing stale entries: ${message}`],
        };
      })
      .finally(() => {
        if (this.cityIndexInFlight.get(key) === pending) {
          this.cityIndexInFlight.delete(key);
        }
      });
    this.cityIndexInFlight.set(key, pending);
    return pending;
  }

  private async buildCityIndex(
    city: { id: string; path: string; name?: string },
    priorRefreshCount: number,
  ): Promise<CityFileIndex> {
    const startedAt = Date.now();
    let cityPath: string;
    try {
      cityPath = realpathSync(city.path);
    } catch (err) {
      throw err;
    }
    if (!existsSync(cityPath)) {
      return {
        cityId: city.id,
        cityName: city.name,
        cityPath,
        entries: [],
        builtAt: Date.now(),
        expiresAt: Date.now() + this.indexTtlMs,
        durationMs: Date.now() - startedAt,
        refreshCount: priorRefreshCount + 1,
        truncated: false,
        timedOut: false,
        warnings: [],
        indexerKind: this.indexerKind,
        mode: 'candidate-cache',
      };
    }

    const walk = await this.walkCityIndexImpl(
      cityPath,
      this.maxIndexedEntriesPerCity + 1,
      this.perCityTimeoutMs,
    );
    const truncated = walk.truncated || walk.entries.length > this.maxIndexedEntriesPerCity;
    const walkEntries = walk.entries.slice(0, this.maxIndexedEntriesPerCity);
    const seen = new Set<string>();
    const entries: GlobalFileHit[] = [];

    for (const entry of walkEntries) {
      const rel = entry.relativePath.replace(/^\.\//, '');
      if (!rel || rel === '.') continue;
      const dedupeKey = `${entry.type}:${rel}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const name = basename(rel) || rel;
      entries.push({
        fullPath: join(cityPath, rel),
        relativePath: rel,
        name,
        type: entry.type,
        cityId: city.id,
        cityName: city.name,
        originId: 'local',
        score: 0,
      });
    }

    const warnings: string[] = [];
    if (walk.timedOut) {
      const stderr = walk.stderr.trim();
      warnings.push(
        stderr
          ? `index refresh timed out before returning entries: ${stderr.slice(0, 160)}`
          : 'index refresh timed out before returning entries',
      );
    }
    if ((walk.unreadableDirs ?? 0) > 0) {
      warnings.push(`search skipped ${walk.unreadableDirs} unreadable directories`);
    }
    if (truncated) {
      warnings.push(`index truncated at ${this.maxIndexedEntriesPerCity} entries`);
    }

    const builtAt = Date.now();
    return {
      cityId: city.id,
      cityName: city.name,
      cityPath,
      entries,
      builtAt,
      expiresAt: builtAt + this.indexTtlMs,
      durationMs: builtAt - startedAt,
      refreshCount: priorRefreshCount + 1,
      unreadableDirs: walk.unreadableDirs,
      truncated,
      timedOut: walk.timedOut,
      visitedDirs: walk.visitedDirs,
      ignoredDirs: walk.ignoredDirs,
      warnings,
      indexerKind: this.indexerKind,
      mode: 'candidate-cache',
    };
  }

  private recordPersistentCityIndex(
    city: { id: string; path: string; name?: string },
    cityPath: string,
    query: string,
    walkEntries: FileWalkEntry[],
    startedAt: number,
    search: FileWalkResult,
    priorRefreshCount: number,
  ): CityFileIndex {
    const seen = new Set<string>();
    const entries: GlobalFileHit[] = [];

    for (const entry of walkEntries) {
      const rel = entry.relativePath.replace(/^\.\//, '');
      if (!rel || rel === '.') continue;
      const dedupeKey = `${entry.type}:${rel}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const name = basename(rel) || rel;
      entries.push({
        fullPath: join(cityPath, rel),
        relativePath: rel,
        name,
        type: entry.type,
        cityId: city.id,
        cityName: city.name,
        originId: 'local',
        score: 0,
      });
    }

    const warnings: string[] = [];
    if (search.timedOut) {
      const stderr = search.stderr.trim();
      warnings.push(
        stderr
          ? `persistent index search timed out before returning entries: ${stderr.slice(0, 160)}`
          : 'persistent index search timed out before returning entries',
      );
    }
    if ((search.unreadableDirs ?? 0) > 0) {
      warnings.push(`search skipped ${search.unreadableDirs} unreadable directories`);
    }
    if (search.truncated) {
      warnings.push(`persistent index truncated at ${this.maxIndexedEntriesPerCity} entries`);
    }

    const builtAt = Date.now();
    const refreshCount =
      search.indexRefreshed === false ? priorRefreshCount : priorRefreshCount + 1;
    const expiresAt =
      typeof search.indexAgeMs === 'number'
        ? builtAt + Math.max(0, this.indexTtlMs - search.indexAgeMs)
        : builtAt + this.indexTtlMs;
    const entry: CityFileIndex = {
      cityId: city.id,
      cityName: city.name,
      cityPath,
      entries,
      builtAt,
      expiresAt,
      durationMs: builtAt - startedAt,
      refreshCount,
      truncated: search.truncated,
      timedOut: search.timedOut,
      unreadableDirs: search.unreadableDirs,
      visitedDirs: search.visitedDirs,
      ignoredDirs: search.ignoredDirs,
      warnings,
      indexerKind: this.indexerKind,
      mode: 'persistent-search',
      query,
      indexRefreshed: search.indexRefreshed,
      indexAgeMs: search.indexAgeMs,
      databasePath: search.databasePath,
    };
    return entry;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }
}

// ============================================================================
// Internals
// ============================================================================

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = {
            status: 'fulfilled',
            value: await mapper(items[index], index),
          };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * fzy-score a hit against the query. Filename gets full weight; the relative
 * path adds a damped tail so two files named `StashForm.tsx` in different
 * directories rank by directory path. Returns 0 on no-match so the caller
 * can filter additively.
 */
function rerankScore(hit: GlobalFileHit, needle: string): number {
  let total = 0;
  if (hasMatch(needle, hit.name)) {
    const s = fzyScore(needle, hit.name);
    total += Number.isFinite(s) ? Math.max(0, (s + 0.5) * 50) : 100;
  }
  if (hasMatch(needle, hit.relativePath)) {
    const s = fzyScore(needle, hit.relativePath);
    total += Number.isFinite(s) ? Math.max(0, (s + 0.5) * 25) : 50;
  }
  return total;
}

function cityIndexKey(city: { id: string; path: string }): string {
  return `${city.id}\0${city.path}`;
}

function citySearchKey(city: { id: string; path: string }, query: string, limit: number): string {
  return `${cityIndexKey(city)}\0${query}\0${limit}`;
}
