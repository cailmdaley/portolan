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
 * Search strategy: build one short-lived candidate index per pinned local
 * city, using `fd` when available and falling back to `find`. Queries then
 * fzy-rank the cached candidates in process. This keeps Find's per-keystroke
 * and multi-window traffic from spawning a fresh filesystem walk in every
 * tab while preserving the same filename/path score model as
 * `/global-search`.
 *
 * Remote-origin file search is a follow-up: snapshot stores carry fiber
 * ids but not the underlying filesystem layout, and a per-keystroke SSH
 * fan-out is too expensive. The constitution's Scope §"In" restricts this
 * stage to local hosts; remote files surface only via per-city HUD or the
 * agent's own listing channels.
 */

import type { ServerResponse } from 'http';
import { spawn } from 'child_process';
import { realpathSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { score as fzyScore, hasMatch } from 'fzy.js';

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
  /** Bound concurrent `fd`/`find` processes. Defaults to 4. */
  maxConcurrentCitySearches?: number;
  /** TTL for each per-city candidate index. Defaults to 30s. */
  indexTtlMs?: number;
  /** Hard cap for indexed candidates per city. Defaults to 20k. */
  maxIndexedEntriesPerCity?: number;
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
  truncated: boolean;
  timedOut: boolean;
  warnings: string[];
}

interface FileWalkResult {
  lines: string[];
  timedOut: boolean;
  stderr: string;
}

export interface FilesSearchDiagnostics {
  ttlMs: number;
  maxIndexedEntriesPerCity: number;
  cachedCities: number;
  inFlight: number;
  totalEntries: number;
  cities: Array<{
    cityId: string;
    cityName?: string;
    path: string;
    entries: number;
    builtAt: number;
    expiresInMs: number;
    durationMs: number;
    refreshCount: number;
    truncated: boolean;
    timedOut: boolean;
    warnings: string[];
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
  /** Lazy: `fd` availability probe. Cached for the instance's lifetime. */
  private hasFd: boolean | null = null;
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
      truncated: entry.truncated,
      timedOut: entry.timedOut,
      warnings: entry.warnings,
    }));
    return {
      ttlMs: this.indexTtlMs,
      maxIndexedEntriesPerCity: this.maxIndexedEntriesPerCity,
      cachedCities: cities.length,
      inFlight: this.cityIndexInFlight.size,
      totalEntries: cities.reduce((sum, city) => sum + city.entries, 0),
      cities,
    };
  }

  private async getCityIndex(city: { id: string; path: string; name?: string }): Promise<CityFileIndex> {
    const key = cityIndexKey(city);
    const now = Date.now();
    const cached = this.cityIndexes.get(key);
    if (cached && cached.expiresAt > now) return cached;

    const inFlight = this.cityIndexInFlight.get(key);
    if (inFlight) return inFlight;

    const pending = this.detectFd()
      .then((fd) => this.buildCityIndex(city, fd, cached?.refreshCount ?? 0))
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
    fd: boolean,
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
      };
    }

    const walk = await this.walkCityIndex(cityPath, fd);
    const truncated = walk.lines.length > this.maxIndexedEntriesPerCity;
    const lines = walk.lines.slice(0, this.maxIndexedEntriesPerCity);
    const seen = new Set<string>();
    const entries: GlobalFileHit[] = [];

    for (const raw of lines) {
      const isDir = raw.endsWith('/');
      const cleaned = isDir ? raw.slice(0, -1) : raw;
      const rel = cleaned.replace(/^\.\//, '');
      if (!rel || rel === '.') continue;
      const dedupeKey = `${isDir ? 'dir' : 'file'}:${rel}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const name = basename(rel) || rel;
      entries.push({
        fullPath: join(cityPath, rel),
        relativePath: rel,
        name,
        type: isDir ? 'dir' : 'file',
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
          ? `index refresh timed out; showing partial entries: ${stderr.slice(0, 160)}`
          : 'index refresh timed out; showing partial entries',
      );
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
      truncated,
      timedOut: walk.timedOut,
      warnings,
    };
  }

  /**
   * One city's candidate refresh. Spawns an unfiltered file/dir walk inside
   * the city's path; query matching happens later against the cached entries.
   */
  private walkCityIndex(cityPath: string, fd: boolean): Promise<FileWalkResult> {
    return new Promise((resolve, reject) => {
      const cap = this.maxIndexedEntriesPerCity + 1;
      const proc = fd
        ? spawn(
            'sh',
            [
              '-c',
              `((fd --min-depth 1 --type d --follow --full-path --hidden --no-ignore --max-results ${cap} --threads 1 --exclude .git --exclude .felt --exclude node_modules --exclude __pycache__ --color never . | sed 's|^\\./||;s|$|/|' && fd --min-depth 1 --type f --follow --full-path --hidden --no-ignore --max-results ${cap} --threads 1 --exclude .git --exclude .felt --exclude node_modules --exclude __pycache__ --color never . | sed 's|^\\./||') 2>/dev/null || true) | head -n ${cap}`,
            ],
            { cwd: cityPath },
          )
        : spawn(
            'sh',
            [
              '-c',
              `find -L . -mindepth 1 \\( -name '.git' -o -name '.felt' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o \\( -type f -o -type d \\) -print 2>/dev/null | while IFS= read -r path; do if [ -d "$path" ]; then printf '%s/\\n' "$path"; else printf '%s\\n' "$path"; fi; done | head -n ${cap}`,
            ],
            { cwd: cityPath },
          );

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, this.perCityTimeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', () => {
        clearTimeout(timer);
        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        resolve({ lines, timedOut, stderr });
      });
    });
  }

  private async detectFd(): Promise<boolean> {
    if (this.hasFd !== null) return this.hasFd;
    return new Promise<boolean>((resolve) => {
      const proc = spawn('fd', ['--version']);
      proc.on('error', () => {
        this.hasFd = false;
        resolve(false);
      });
      proc.on('close', (code) => {
        this.hasFd = code === 0;
        resolve(this.hasFd);
      });
    });
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
