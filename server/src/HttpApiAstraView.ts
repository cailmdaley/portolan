/**
 * HttpApiAstraView — serve the lightcone-ui-core paper view for an
 * astra.yaml file from anywhere portolan can reach.
 *
 * The paper view is a self-contained HTML+JS template shipped by
 * `lightcone-ui-core/templates`. Three pieces:
 *
 *   - `paper-view.html`  — the shell. Reads `window.__BUNDLE__` /
 *                          `window.__CSV__` at load time.
 *   - `paper-viewer.js`  — the renderer module that consumes the bundle.
 *   - `vellum.css`       — styling.
 *
 * Rendering pipeline (mirrors lightcone-ui's CLI and VS Code extension):
 *
 *   1. Resolve the astra.yaml path → its project root (parent dir).
 *   2. `buildBundle(projectRoot, universe)` produces `{ bundle, csvs }`
 *      with output paths still project-relative (e.g.
 *      `results/baseline/fig1.png`).
 *   3. Rewrite those project-relative paths to portolan's
 *      `/project-file/{originId}{absProjectRoot}/...` so the iframe can
 *      fetch artifacts through the same channel that already streams remote
 *      and local files.
 *   4. Inject the bundle as a `<script>` into `<head>`, point the CSS link
 *      at the sidecar `/astra/asset/vellum.css`, and rewrite the
 *      `./paper-viewer.js` import to the same sidecar mount.
 *
 * Remote astra.yaml works by mirroring the project tree to a temp local
 * directory via `ssh tar` so `buildBundle` can walk it. The bundle paths
 * are then rewritten back to the *remote* absolute path so the iframe
 * fetches artifacts through `/project-file/{remoteOriginId}{remoteAbs}/...`
 * — the existing remote streaming channel. The mirror is cached per
 * (originId, remotePath) and refreshed when astra.yaml's remote mtime
 * changes.
 */
import { execFile, spawn } from 'child_process';
import { extname, dirname, basename, resolve, join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { promisify } from 'util';
import type { ServerResponse } from 'http';
import { buildBundle, resolvePaperCacheDir, type Bundle } from 'lightcone-ui-core';
import { templatesDir, templatePath } from 'lightcone-ui-core/templates';
import type { Origin } from './OriginManager.js';
import { shellEscape } from './ShellPathUtils.js';

const execFileAsync = promisify(execFile);

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface HttpApiAstraViewDeps {
  originLookup: OriginLookup;
}

const ASSET_MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
};

const ALLOWED_ASSETS = new Set(['paper-viewer.js', 'vellum.css']);

/**
 * Heuristic predicate used by routing code: does this path point at an
 * astra.yaml? Matches the canonical city-root file plus any nested
 * `*.astra.yaml` so future per-analysis files just work.
 */
export function isAstraPath(filePath: string): boolean {
  if (!filePath) return false;
  const clean = filePath.split('?')[0].split('#')[0];
  return /(?:^|\/)astra\.ya?ml$/i.test(clean) || /\.astra\.ya?ml$/i.test(clean);
}

/** Escape `</` so JSON cannot break out of its containing `<script>`. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tiny YAML colouriser for the source view. Tokenises the escaped text
 * line by line so substitutions can't recurse into markup we just
 * inserted (a single sequential-replace pass kept matching its own
 * `class="y-str"` attributes). Keys, quoted strings, comments, and the
 * `---` document marker are enough to make the file scannable.
 */
function highlightYaml(source: string): string {
  const lines = escapeHtml(source).split('\n');
  return lines.map(highlightYamlLine).join('\n');
}

function highlightYamlLine(line: string): string {
  // Document marker — whole line.
  if (/^(---|\.\.\.)$/.test(line)) return `<span class="y-marker">${line}</span>`;
  // Split off trailing comment (if any) before tokenising the body so
  // the regex pass below doesn't recurse into `<span class="…">`
  // attributes we'd otherwise inject. Keys + comments are enough; we
  // dropped string-literal colouring for the same reason.
  const commentIdx = findUnquoted(line, '#');
  let body = line;
  let comment = '';
  if (commentIdx >= 0) {
    body = line.slice(0, commentIdx);
    comment = `<span class="y-comm">${line.slice(commentIdx)}</span>`;
  }
  body = body.replace(
    /^([ \t-]*)([A-Za-z_$][\w-]*)(:)(\s|$)/,
    (_m, indent, key, colon, trail) =>
      `${indent}<span class="y-key">${key}</span>${colon}${trail}`,
  );
  return body + comment;
}

/**
 * Find the first occurrence of `ch` in `s` that's not inside a quoted
 * string. Used to split a YAML line on `#` (comment marker) without
 * mistaking a literal `#` inside a quoted scalar for a comment.
 */
function findUnquoted(s: string, ch: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === ch) return i;
  }
  return -1;
}

/**
 * Rewrite output paths in a bundle from project-relative to a portolan
 * `/project-file/{originId}{absRoot}/<rel>` URL. The renderer treats these
 * as absolute hrefs so no `<base>` tag is needed; the iframe origin is
 * portolan's HTTP server, which the path resolves against.
 */
function rewriteBundlePaths(
  bundle: Bundle,
  csvs: Record<string, string>,
  originId: string,
  absRoot: string,
): { bundle: Bundle; csvs: Record<string, string> } {
  const encodedRoot = absRoot
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  const mount = `/project-file/${encodeURIComponent(originId)}${encodedRoot}`;

  const rewrite = (p: string | null | undefined): string | null | undefined => {
    if (!p) return p;
    const clean = p.replace(/^\.\/+/, '').replace(/^\/+/, '');
    // Encode each segment so spaces and other special chars survive the
    // round-trip through portolan's project-file route.
    const encoded = clean
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${mount}/${encoded}`;
  };

  // Deep-clone so the in-memory bundle stays immutable; the rewrite mutates
  // the copy. Plain JSON shape, so JSON round-trip is safe.
  const next: Bundle = JSON.parse(JSON.stringify(bundle));
  for (const out of Object.values(next.outputs)) {
    if (out.resolved_path) out.resolved_path = rewrite(out.resolved_path) ?? null;
  }
  const nextCsvs: Record<string, string> = {};
  for (const [k, v] of Object.entries(csvs)) nextCsvs[rewrite(k) ?? k] = v;
  return { bundle: next, csvs: nextCsvs };
}

/**
 * Inject the bundle and rewrite asset URLs in paper-view.html. The
 * template references `vellum.css` and `./paper-viewer.js` as siblings;
 * we point them at portolan's `/astra/asset/...` sidecar mount so the
 * iframe loads them out of the lightcone-ui-core templates dir.
 */
function renderPaperViewHtml(template: string, bundle: Bundle, csvs: Record<string, string>): string {
  const bundleScript =
    `<script>\n` +
    `window.__BUNDLE__ = ${safeJson(bundle)};\n` +
    `window.__CSV__ = ${safeJson(csvs)};\n` +
    `</script>`;

  let html = template;

  html = html.replace(
    /<link rel="stylesheet" href="vellum\.css">/,
    `<link rel="stylesheet" href="/astra/asset/vellum.css">`,
  );
  html = html.replace(
    /<script type="module" src="\.\/paper-viewer\.js"><\/script>/,
    `<script type="module" src="/astra/asset/paper-viewer.js"></script>`,
  );

  html = html.replace(/<head>/, `<head>\n${bundleScript}`);
  return html;
}

function stubHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'EB Garamond', Georgia, serif; max-width: 640px; margin: 8vh auto; padding: 0 24px; color: #2E2A26; background: #EDE8E0; line-height: 1.6; }
  h1 { font-variant: small-caps; letter-spacing: 0.04em; font-weight: 600; }
  code, pre { font-family: 'JetBrains Mono', monospace; font-size: 0.9em; background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 3px; }
  pre { padding: 12px; overflow-x: auto; }
  .hint { color: #7A7368; font-size: 0.95em; margin-top: 1.5em; }
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

/**
 * Per-process cache for remote project mirrors. Key: hash(originId,
 * remoteRoot). Value: local mirror path + the remote astra.yaml mtime
 * we materialised against. A stale mtime forces a re-tar.
 */
interface RemoteMirror {
  localRoot: string;
  remoteAstraMtime: string;
}
const REMOTE_MIRROR_CACHE = new Map<string, RemoteMirror>();
const MIRROR_BASE = join(tmpdir(), 'portolan-astra-mirror');

/** Stable cache key for a remote project root. */
function mirrorKey(originId: string, remoteRoot: string): string {
  return createHash('sha256').update(`${originId}\0${remoteRoot}`).digest('hex').slice(0, 16);
}

/**
 * Stat the remote astra.yaml mtime as a cache invalidation token. We
 * use the file mtime (epoch nanoseconds via stat -c) rather than rsync's
 * own delta because the rest of the project changes on the same beat
 * (universes, results) — re-tarring on astra.yaml mtime change is good
 * enough and a lot cheaper than a full diff.
 */
async function fetchRemoteAstraMtime(sshHost: string, astraPath: string): Promise<string> {
  // -c for GNU stat (Linux); -f on BSD. Try GNU first; the agents we
  // ship to are all Linux. Fall back to default %y format if -c fails.
  const cmd = `stat -c %Y ${shellEscape(astraPath)} 2>/dev/null || stat -f %m ${shellEscape(astraPath)}`;
  const { stdout } = await execFileAsync('ssh', [sshHost, cmd], {
    timeout: 10000,
    maxBuffer: 1024,
  });
  return stdout.trim();
}

/**
 * SSH-tar the remote project root into a local mirror directory.
 * Excludes a few obviously-irrelevant paths (`.claude`, `paper` symlink
 * outside the project, `.git`) to keep the tar small. The local mirror
 * is wiped before write to avoid stale files from a previous version.
 */
async function tarRemoteToLocal(
  sshHost: string,
  remoteRoot: string,
  localRoot: string,
): Promise<void> {
  // Wipe + recreate target.
  if (existsSync(localRoot)) rmSync(localRoot, { recursive: true, force: true });
  mkdirSync(localRoot, { recursive: true });

  const excludes = ['--exclude=.claude', '--exclude=.git', '--exclude=paper'];
  // -h dereferences symlinks (so `paper -> /elsewhere` would be followed
  // if not excluded); we DON'T want that for `paper`, hence the exclude
  // above. For other normal files we want a plain tar. -P keeps the
  // archive entry names absolute-relative-to-cwd, but combined with
  // `-C` on the receiving side this rehomes correctly.
  const remoteCmd = `tar cf - ${excludes.join(' ')} -C ${shellEscape(remoteRoot)} .`;

  await new Promise<void>((resolveTar, reject) => {
    const ssh = spawn('ssh', [sshHost, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const untar = spawn('tar', ['xf', '-', '-C', localRoot], { stdio: ['pipe', 'inherit', 'inherit'] });
    ssh.stdout!.pipe(untar.stdin!);

    let sshStderr = '';
    ssh.stderr!.on('data', (b) => { sshStderr += b.toString(); });

    let sshExit: number | null = null;
    let untarExit: number | null = null;

    const finish = () => {
      if (sshExit === null || untarExit === null) return;
      if (sshExit !== 0) {
        reject(new Error(`ssh tar exited ${sshExit}: ${sshStderr.trim()}`));
        return;
      }
      if (untarExit !== 0) {
        reject(new Error(`local untar exited ${untarExit}`));
        return;
      }
      resolveTar();
    };
    ssh.on('exit', (code) => { sshExit = code ?? 1; finish(); });
    untar.on('exit', (code) => { untarExit = code ?? 1; finish(); });
    ssh.on('error', (err) => reject(new Error(`ssh spawn: ${err.message}`)));
    untar.on('error', (err) => reject(new Error(`untar spawn: ${err.message}`)));
  });
}

/**
 * Ensure a local mirror of the remote project root exists and is
 * up-to-date relative to the remote astra.yaml mtime. Returns the
 * local root path that buildBundle can be pointed at. Cached per
 * (originId, remoteRoot); cache hit avoids the SSH tar entirely.
 */
async function materializeRemoteSpec(
  sshHost: string,
  originId: string,
  remoteRoot: string,
  remoteAstraPath: string,
): Promise<string> {
  const key = mirrorKey(originId, remoteRoot);
  const localRoot = join(MIRROR_BASE, key);
  const remoteMtime = await fetchRemoteAstraMtime(sshHost, remoteAstraPath);
  const cached = REMOTE_MIRROR_CACHE.get(key);
  if (cached && cached.localRoot === localRoot && cached.remoteAstraMtime === remoteMtime && existsSync(localRoot)) {
    return localRoot;
  }
  await tarRemoteToLocal(sshHost, remoteRoot, localRoot);
  REMOTE_MIRROR_CACHE.set(key, { localRoot, remoteAstraMtime: remoteMtime });
  return localRoot;
}

export class HttpApiAstraView {
  private originLookup: OriginLookup;

  constructor(deps: HttpApiAstraViewDeps) {
    this.originLookup = deps.originLookup;
  }

  /**
   * Serve the rendered paper view for an astra.yaml at the given path.
   * URL shape: `/astra-paper-view/{originId}{absPath}[?universe=baseline][&as=paper|source]`.
   * `as=source` returns a syntax-styled view of the raw YAML so the pin
   * chrome can flip between the rich paper view and the underlying file
   * without leaving the iframe.
   */
  async handlePaperView(url: URL, res: ServerResponse): Promise<void> {
    const prefix = '/astra-paper-view/';
    const rest = url.pathname.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) {
      this.sendError(res, 400, 'Missing file path');
      return;
    }
    const originId = decodeURIComponent(rest.slice(0, slashIdx));
    const filePath = decodeURIComponent(rest.slice(slashIdx));
    const universe = url.searchParams.get('universe') ?? 'baseline';
    const mode = url.searchParams.get('as') ?? 'paper';

    if (!filePath.startsWith('/') || filePath.includes('..')) {
      this.sendError(res, 400, 'Invalid path');
      return;
    }
    if (!isAstraPath(filePath)) {
      this.sendError(res, 400, 'Not an astra.yaml path');
      return;
    }

    if (mode === 'source') {
      await this.handleSourceView(originId, filePath, res);
      return;
    }

    // Project root from the perspective of buildBundle (where it walks
    // the filesystem) vs. the perspective of the iframe (where it
    // fetches artifacts via /project-file). For local origins these are
    // the same path; for remote, the build runs against a local mirror
    // but the iframe URLs need to point at the *remote* path so
    // /project-file streams the originals.
    const remoteRoot = resolve(dirname(filePath));
    let buildRoot: string;

    if (originId && originId !== 'local') {
      const origin = this.originLookup.getOrigin(originId);
      if (!origin?.sshHost) {
        this.sendError(res, 404, 'Remote origin not connected');
        return;
      }
      try {
        buildRoot = await materializeRemoteSpec(origin.sshHost, originId, remoteRoot, filePath);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        console.error('[astra-paper-view] remote materialise failed:', message);
        const body =
          `<p>Failed to mirror the remote project tree from <code>${escapeHtml(origin.sshHost)}</code>:</p>` +
          `<pre>${escapeHtml(message)}</pre>` +
          `<p class="hint">Check that the host is reachable and that the path exists. Falls back to running <code>lc-ui</code> on the remote host directly.</p>`;
        res.writeHead(502, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(stubHtml('Astra paper view — remote mirror failed', body));
        return;
      }
    } else {
      if (!existsSync(filePath)) {
        this.sendError(res, 404, `astra.yaml not found at ${filePath}`);
        return;
      }
      buildRoot = remoteRoot;
    }

    let bundle: Bundle;
    let csvs: Record<string, string>;
    try {
      const built = buildBundle(buildRoot, universe);
      bundle = built.bundle;
      csvs = built.csvs;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error('[astra-paper-view] buildBundle failed:', message);
      const body =
        `<p><code>buildBundle</code> threw building the paper view for ` +
        `<code>${escapeHtml(filePath)}</code> (universe <code>${escapeHtml(universe)}</code>):</p>` +
        `<pre>${escapeHtml(message)}</pre>`;
      res.writeHead(500, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(stubHtml('Astra paper view — build failed', body));
      return;
    }

    // Always rewrite using the *remote* root so /project-file URLs land
    // on the right host. For local origins remoteRoot === buildRoot so
    // this is a no-op rename.
    const rewritten = rewriteBundlePaths(bundle, csvs, originId || 'local', remoteRoot);

    let template: string;
    try {
      template = readFileSync(templatePath('paper-view.html'), 'utf-8');
    } catch (err: any) {
      console.error('[astra-paper-view] template read failed:', err?.message ?? err);
      this.sendError(res, 500, 'paper-view template missing');
      return;
    }

    const html = renderPaperViewHtml(template, rewritten.bundle, rewritten.csvs);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  /**
   * Source view: serve the raw astra.yaml as a styled HTML page so the
   * iframe can show the YAML body without leaving the same surface. We
   * keep this lightweight — no syntax-highlighting library, just CSS
   * that mimics the JetBrains Mono / parchment palette portolan uses
   * elsewhere. For remote, read over SSH.
   */
  private async handleSourceView(originId: string, filePath: string, res: ServerResponse): Promise<void> {
    let content = '';
    try {
      if (originId && originId !== 'local') {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          this.sendError(res, 404, 'Remote origin not connected');
          return;
        }
        const { stdout } = await execFileAsync(
          'ssh',
          [origin.sshHost, `cat ${shellEscape(filePath)}`],
          { maxBuffer: 5 * 1024 * 1024, timeout: 10000 },
        );
        content = stdout;
      } else {
        if (!existsSync(filePath)) {
          this.sendError(res, 404, `astra.yaml not found at ${filePath}`);
          return;
        }
        content = readFileSync(filePath, 'utf-8');
      }
    } catch (err: any) {
      this.sendError(res, 500, `Failed to read astra.yaml: ${err?.message ?? err}`);
      return;
    }

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(basename(filePath))}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 13px; line-height: 1.55; color: #2E2A26; background: #EDE8E0; }
  pre { margin: 0; padding: 16px 24px; white-space: pre; tab-size: 2; overflow: auto; height: 100%; box-sizing: border-box; }
  /* Subtle YAML-ish colouring: keys get a bit of weight, comments fade. */
  .y-key   { color: #6E5837; font-weight: 600; }
  .y-str   { color: #4A6C3F; }
  .y-comm  { color: #A39580; font-style: italic; }
  .y-marker{ color: #9A7B35; }
</style></head><body><pre>${highlightYaml(content)}</pre></body></html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  /**
   * Serve a cached paper PDF for the paper-viewer evidence modal. The
   * lightcone-ui paper-viewer.js fetches `/papers/{cacheKey}/paper.pdf`
   * (see paper-viewer.js → `loadPdf`); portolan mounts that URL space
   * onto the local ASTRA paper cache (`resolvePaperCacheDir()` →
   * `~/.cache/astra/papers` by default, `ASTRA_PAPER_CACHE_DIR` override).
   *
   * Only `paper.pdf` is allowed under each cacheKey, and the cacheKey
   * must be a single path segment matching `[A-Za-z0-9._-]+` — DOIs with
   * `/` are stored as `_`-substituted directory names, no nested paths.
   * 404 (not 500) when the cache file is missing so paper-viewer's
   * "Paper not in cache" branch fires cleanly.
   */
  async handlePaperPdf(url: URL, res: ServerResponse): Promise<void> {
    const prefix = '/papers/';
    const rest = url.pathname.slice(prefix.length);
    // Expect exactly `<cacheKey>/paper.pdf`.
    const m = rest.match(/^([A-Za-z0-9._-]+)\/paper\.pdf$/);
    if (!m) {
      this.sendError(res, 404, 'Unknown paper cache path');
      return;
    }
    const cacheKey = decodeURIComponent(m[1]);
    const cacheDir = resolvePaperCacheDir();
    const filePath = join(cacheDir, cacheKey, 'paper.pdf');
    // Defensive: re-resolve the join and confirm we stayed inside cacheDir.
    const resolved = resolve(filePath);
    if (!resolved.startsWith(resolve(cacheDir) + '/')) {
      this.sendError(res, 400, 'Paper path escapes cache dir');
      return;
    }
    if (!existsSync(resolved)) {
      this.sendError(res, 404, 'Paper not in cache');
      return;
    }
    try {
      const data = readFileSync(resolved);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': String(data.length),
        // Paper PDFs are immutable per cacheKey (DOI-keyed), so
        // long-cache. The browser revalidates only on cacheKey change.
        'Cache-Control': 'public, max-age=86400, immutable',
      });
      res.end(data);
    } catch (err: any) {
      console.error('[paper-pdf] read failed:', err?.message ?? err);
      this.sendError(res, 500, 'paper read failed');
    }
  }

  /** Helper to surface the paper cache dir in /debug-runtime. */
  paperCacheDir(): string {
    return resolvePaperCacheDir();
  }

  /**
   * Serve a single template asset (paper-viewer.js, vellum.css). URL shape:
   * `/astra/asset/{file}`. The file must be on the explicit allowlist —
   * we don't want this to become an arbitrary static-file route.
   */
  async handleAsset(url: URL, res: ServerResponse): Promise<void> {
    const prefix = '/astra/asset/';
    const file = url.pathname.slice(prefix.length);
    if (!ALLOWED_ASSETS.has(file)) {
      this.sendError(res, 404, 'Unknown asset');
      return;
    }
    const ext = extname(file).toLowerCase();
    const mime = ASSET_MIME[ext] ?? 'application/octet-stream';
    const filePath = templatePath(file as 'paper-viewer.js' | 'vellum.css');
    if (!existsSync(filePath)) {
      this.sendError(res, 404, `asset ${basename(file)} not found in templates`);
      return;
    }
    try {
      const data = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Access-Control-Allow-Origin': '*',
        // Templates change rarely; let the browser cache for a session.
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    } catch (err: any) {
      console.error('[astra-asset] read failed:', err?.message ?? err);
      this.sendError(res, 500, 'asset read failed');
    }
  }

  /** Helper to surface the templates dir in /debug-runtime. */
  templatesDir(): string {
    return templatesDir();
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(message);
  }
}
