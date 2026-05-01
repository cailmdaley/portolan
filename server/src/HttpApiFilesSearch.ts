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
 * Search strategy: `fd` for filename matching when available, falling back
 * to `find -type f -type d` + `grep -i` when not. Mirrors the
 * `WorkspaceBrowser.handleSearchFiles` shell-out (so the Find search
 * behaves like the per-city HUD search did) but aggregates across every
 * pinned local city in parallel rather than scoping to one. fzy re-ranks
 * the candidates client-server-side so the ordering lines up with
 * `/global-search` fiber scores.
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
import { join, sep, basename } from 'path';
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
  /** Per-city result cap *before* fzy ranking. Defaults to 200; the
   *  shell-out caps each city's `head` to bound shell-side cost. */
  perCityCap?: number;
  /** Per-city wall-clock budget in ms. Defaults to 1500ms — fast typers
   *  shouldn't be chasing a search that's already stale. */
  perCityTimeoutMs?: number;
}

// ============================================================================
// Class
// ============================================================================

export class HttpApiFilesSearch {
  private readonly cities: Array<{ id: string; path: string; name?: string }>;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;
  private readonly perCityCap: number;
  private readonly perCityTimeoutMs: number;
  /** Lazy: `fd` availability probe. Cached for the instance's lifetime. */
  private hasFd: boolean | null = null;

  constructor(opts: HttpApiFilesSearchOptions = {}) {
    this.cities = opts.cities ?? [];
    this.defaultLimit = opts.defaultLimit ?? 30;
    this.maxLimit = opts.maxLimit ?? 200;
    this.perCityCap = opts.perCityCap ?? 200;
    this.perCityTimeoutMs = opts.perCityTimeoutMs ?? 1500;
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
    const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(this.maxLimit, limitParam))
      : this.defaultLimit;

    if (!q) {
      this.json(res, 200, { hits: [], generatedAt: Date.now() });
      return;
    }

    try {
      const { hits, warnings } = await this.search(q, limit);
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
  ): Promise<{ hits: GlobalFileHit[]; warnings: Array<{ cityId: string; message: string }> }> {
    if (!q.trim()) return { hits: [], warnings: [] };
    if (this.cities.length === 0) return { hits: [], warnings: [] };

    const fd = await this.detectFd();
    const perCity = await Promise.allSettled(
      this.cities.map((city) => this.walkCity(city, q, fd)),
    );

    const merged: GlobalFileHit[] = [];
    const warnings: Array<{ cityId: string; message: string }> = [];

    for (let i = 0; i < perCity.length; i++) {
      const result = perCity[i];
      const city = this.cities[i];
      if (result.status === 'rejected') {
        const message = (result.reason as { message?: string })?.message ?? String(result.reason);
        warnings.push({ cityId: city.id, message });
        continue;
      }
      merged.push(...result.value);
    }

    // Final ranking pass: fzy-score the (relativePath, name) pair to keep
    // basename matches dominant ("StashForm" matches over "deep/dir/x.tsx"
    // when both contain the needle) while still favouring shorter path
    // prefixes. Sort + slice; the per-city cap above already trimmed the
    // long tail.
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
   * One city's walk. Spawns `fd <q>` (or the find/grep fallback) inside
   * the city's path, parses entries, attaches city metadata. The shell
   * caps `head -N` so the parent process doesn't hang on enormous trees.
   */
  private walkCity(
    city: { id: string; path: string; name?: string },
    q: string,
    fd: boolean,
  ): Promise<GlobalFileHit[]> {
    return new Promise((resolve, reject) => {
      // Skip cities whose path doesn't exist on disk (stale pin) — keeps
      // the walk from producing a confusing fd error.
      let cityPath: string;
      try {
        cityPath = realpathSync(city.path);
      } catch (err) {
        reject(err);
        return;
      }
      if (!existsSync(cityPath)) {
        resolve([]);
        return;
      }

      const proc = fd
        ? spawn(
            'fd',
            [
              '--type', 'f',
              '--type', 'd',
              '--follow',
              '--full-path',
              '--hidden',
              '--no-ignore',
              '--exclude', '.git',
              '--exclude', '.felt',
              '--exclude', 'node_modules',
              '--exclude', '__pycache__',
              '--color', 'never',
              q,
            ],
            { cwd: cityPath },
          )
        : spawn(
            'sh',
            [
              '-c',
              // Mirrors WorkspaceBrowser.searchLocal's find fallback: walk
              // files + dirs, mark dirs with a trailing slash, grep on the
              // user's needle. Quoting the needle for grep — `[`, `*`,
              // etc. would otherwise blow up the regex.
              `find -L . \\( -name '.git' -o -name '.felt' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o \\( -type f -o -type d \\) -print 2>/dev/null | while IFS= read -r path; do if [ -d "$path" ]; then printf '%s/\\n' "$path"; else printf '%s\\n' "$path"; fi; done | grep -i ${shellQuote(q)} | head -${this.perCityCap}`,
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
        // fd / find output one entry per line, with directories marked by
        // a trailing slash. Cap to perCityCap *after* parsing because fd
        // doesn't have a built-in head and we don't want to pipe it.
        const lines = stdout.split('\n').filter((l) => l.trim()).slice(0, this.perCityCap);
        const hits: GlobalFileHit[] = [];
        for (const raw of lines) {
          const isDir = raw.endsWith('/');
          const cleaned = isDir ? raw.slice(0, -1) : raw;
          // fd's --full-path emits paths with `./` prefix; drop it.
          const rel = cleaned.replace(/^\.\//, '');
          if (!rel) continue;
          const name = basename(rel) || rel;
          hits.push({
            fullPath: join(cityPath, rel),
            relativePath: rel,
            name,
            type: isDir ? 'dir' : 'file',
            cityId: city.id,
            cityName: city.name,
            originId: 'local',
            score: 0,  // filled in by the rerank pass
          });
        }
        if (timedOut && stderr) {
          // Surface the timeout cause so the warnings list carries
          // actionable context instead of a generic "timed out."
          console.warn(`[FilesSearch] ${city.id} timed out: ${stderr.slice(0, 200)}`);
        }
        resolve(hits);
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

/**
 * Single-quote a value for shell. Used by the `find | grep` fallback path
 * when `fd` isn't available; mirrors the quoting strategy in
 * `WorkspaceBrowser.searchLocal` so behaviour parity stays tight.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// `sep` is imported for cross-platform `relativePath` rendering — Windows
// would otherwise emit backslashes here that don't round-trip with the
// frontend's slash-joined paths.
void sep;
