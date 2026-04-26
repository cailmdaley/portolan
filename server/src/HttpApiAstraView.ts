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
 *
 * Paper PDFs follow the same shape via `/papers/{originId}/{cacheKey}/paper.pdf`:
 * for remote origins, `materializeRemotePaperIndex` mirrors the meta.json
 * sidecars from `~/.cache/astra/papers` so the bundle's `papers` map
 * reflects the remote's cache state, and the actual PDF bytes are
 * SSH-cat'd on demand into a per-origin local mirror by
 * `materializeRemotePaperPdf` when the user opens an evidence row.
 */
import { execFile, spawn } from 'child_process';
import { extname, dirname, basename, resolve, join } from 'path';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { promisify } from 'util';
import type { ServerResponse } from 'http';
import {
  buildBundle,
  collectPaperMetadata,
  resolvePaperCacheDir,
  type Bundle,
} from 'lightcone-ui-core';
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
 *
 * The same token is also surfaced to clients via `/astra-mtime/...` and
 * the `mtime` field on `/astra-bundle/...` JSON, so the vellum-native
 * astra renderer can detect external edits on window-focus and re-fetch
 * — see `vellum-reader/vellum-native-astra-renderer` open question
 * "Bundle staleness".
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

/**
 * Per-origin local mirror of the remote ASTRA paper cache *index* — meta.json
 * files only, no PDFs. Created so `collectPaperMetadata` can run against the
 * remote's cache state without us forking its filesystem-touching internals.
 *
 * `collectPaperMetadata` requires both `meta.json` AND `paper.pdf` to exist
 * before declaring `cached: true`, so after pulling the meta.jsons we drop
 * empty placeholder `paper.pdf` files alongside them. Actual PDF bytes are
 * fetched on demand by `streamRemotePaperPdf` when the user clicks an
 * evidence row — the bulk of the cache stays remote, only metadata is
 * mirrored here.
 *
 * Cache: per-origin, refreshed every time the bundle is built (meta.jsons
 * are tiny and lightcone-ui's `astra papers fetch` may add new entries
 * between bundle builds; staleness here would silently mis-render
 * evidence rows as "not cached").
 */
const PAPER_MIRROR_BASE = join(MIRROR_BASE, 'papers');

/** Per-origin local cache dir for paper.pdf bytes streamed on demand. */
function paperPdfMirrorPath(originId: string, cacheKey: string): string {
  return join(PAPER_MIRROR_BASE, originId, 'pdf', cacheKey, 'paper.pdf');
}

/** Per-origin local cache dir for the meta.json index (re-tarred each build). */
function paperIndexMirrorDir(originId: string): string {
  return join(PAPER_MIRROR_BASE, originId, 'index');
}

async function tarRemotePaperIndex(sshHost: string, localDir: string): Promise<void> {
  if (existsSync(localDir)) rmSync(localDir, { recursive: true, force: true });
  mkdirSync(localDir, { recursive: true });

  // Resolve `~` on the remote (don't rely on local shell expansion).
  // Skip *.pdf so we only ship meta.jsons (and any other small sidecars).
  // Wrap in `if [ -d ... ]` so a remote with no cache dir yet returns 0 with
  // empty stdout instead of "tar: no such file" → non-zero exit → 502.
  const remoteCmd =
    'CACHE="$HOME/.cache/astra/papers"; ' +
    'if [ -d "$CACHE" ]; then ' +
    '  tar cf - --exclude="*.pdf" -C "$CACHE" . ; ' +
    'fi';

  await new Promise<void>((resolveTar, reject) => {
    const ssh = spawn('ssh', [sshHost, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const untar = spawn('tar', ['xf', '-', '-C', localDir], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    ssh.stdout!.pipe(untar.stdin!);

    let sshStderr = '';
    ssh.stderr!.on('data', (b) => {
      sshStderr += b.toString();
    });

    let sshExit: number | null = null;
    let untarExit: number | null = null;
    const finish = () => {
      if (sshExit === null || untarExit === null) return;
      if (sshExit !== 0) {
        reject(new Error(`ssh tar (paper index) exited ${sshExit}: ${sshStderr.trim()}`));
        return;
      }
      // The remote may legitimately have no paper cache yet; in that case the
      // remoteCmd emits an empty stream and untar reports "Unexpected EOF" /
      // exit 2. Treat that as success — the empty mirror dir means
      // "no remote-cached papers" rather than a hard failure.
      if (untarExit !== 0 && readdirSync(localDir).length > 0) {
        reject(new Error(`local untar (paper index) exited ${untarExit}`));
        return;
      }
      resolveTar();
    };
    ssh.on('exit', (code) => {
      sshExit = code ?? 1;
      finish();
    });
    untar.on('exit', (code) => {
      untarExit = code ?? 1;
      finish();
    });
    ssh.on('error', (err) => reject(new Error(`ssh spawn (paper index): ${err.message}`)));
    untar.on('error', (err) => reject(new Error(`untar spawn (paper index): ${err.message}`)));
  });

  // For each cache entry that has a meta.json, drop a zero-byte paper.pdf
  // placeholder so collectPaperMetadata's existence check passes. The real
  // bytes get streamed on demand via streamRemotePaperPdf.
  for (const entry of readdirSync(localDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(localDir, entry.name);
    if (existsSync(join(dir, 'meta.json')) && !existsSync(join(dir, 'paper.pdf'))) {
      writeFileSync(join(dir, 'paper.pdf'), '');
    }
  }
}

/**
 * Materialise the remote paper-cache index (meta.json files only, plus
 * placeholder paper.pdf files) into a local mirror dir. Returns the path,
 * which can be passed to `collectPaperMetadata` so the bundle's `papers`
 * map reflects the remote's actual cache state.
 *
 * On SSH failure or an empty remote cache, returns the (possibly empty)
 * mirror dir rather than throwing — a remote with no paper cache yet is a
 * real, non-error state and the bundle should still build.
 */
async function materializeRemotePaperIndex(sshHost: string, originId: string): Promise<string> {
  const dir = paperIndexMirrorDir(originId);
  try {
    await tarRemotePaperIndex(sshHost, dir);
  } catch (err: any) {
    console.error(
      `[astra-bundle] remote paper-index materialise failed for ${originId}:`,
      err?.message ?? err,
    );
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Fetch the remote `~/.cache/astra/papers/<cacheKey>/paper.pdf` bytes and
 * cache locally. Returns the local file path, or null if the remote file
 * doesn't exist.
 *
 * Paper PDFs are immutable per cacheKey (DOI-keyed, never republished
 * under the same key), so the local cache is permanent — checked via
 * `existsSync` before any SSH work. This is the primary design tradeoff:
 * we burn local disk to avoid re-streaming a multi-MB PDF on every
 * modal open.
 */
async function materializeRemotePaperPdf(
  sshHost: string,
  originId: string,
  cacheKey: string,
): Promise<string | null> {
  const localPath = paperPdfMirrorPath(originId, cacheKey);
  if (existsSync(localPath)) return localPath;

  // SSH-cat the remote PDF into the local file. Streamed via spawn so a
  // large PDF doesn't allocate a giant Node Buffer first. shellEscape on
  // cacheKey is belt-and-suspenders — handlePaperPdf already validates it
  // against `[A-Za-z0-9._-]+` before we get here.
  mkdirSync(dirname(localPath), { recursive: true });
  const remotePath = `$HOME/.cache/astra/papers/${cacheKey}/paper.pdf`;
  const remoteCmd =
    `if [ -f ${shellEscape(remotePath)} ]; then ` +
    `cat ${shellEscape(remotePath)}; ` +
    `else exit 7; ` +  // distinguishable exit code for "not on remote"
    `fi`;

  return new Promise<string | null>((resolveOut, reject) => {
    const ssh = spawn('ssh', [sshHost, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Stream stdout to disk; collect stderr for the error message.
    const out = createWriteStream(localPath);
    ssh.stdout!.pipe(out);

    let sshStderr = '';
    ssh.stderr!.on('data', (b) => {
      sshStderr += b.toString();
    });

    let sshExit: number | null = null;
    let outClosed = false;
    const finish = () => {
      if (sshExit === null || !outClosed) return;
      if (sshExit === 7) {
        // Remote doesn't have it. Drop the empty file we created.
        try {
          rmSync(localPath, { force: true });
        } catch {}
        resolveOut(null);
        return;
      }
      if (sshExit !== 0) {
        try {
          rmSync(localPath, { force: true });
        } catch {}
        reject(new Error(`ssh cat (paper pdf) exited ${sshExit}: ${sshStderr.trim()}`));
        return;
      }
      resolveOut(localPath);
    };
    ssh.on('exit', (code) => {
      sshExit = code ?? 1;
      finish();
    });
    out.on('close', () => {
      outClosed = true;
      finish();
    });
    ssh.on('error', (err) => reject(new Error(`ssh spawn (paper pdf): ${err.message}`)));
    out.on('error', (err) => reject(new Error(`local write (paper pdf): ${err.message}`)));
  });
}

/**
 * Result of resolving an astra path into a built, path-rewritten bundle.
 * Discriminated so the two endpoints (paper-view html, raw bundle JSON)
 * can branch on outcome and pick their own body shape — the html path
 * still wants stub HTML on failure for the iframe to display, while the
 * JSON path emits text/plain with the same status codes.
 */
type BundleBuildResult =
  | { kind: 'ok'; bundle: Bundle; csvs: Record<string, string>; remoteRoot: string }
  | { kind: 'error'; status: number; tag: string; message: string };

/**
 * Cheap stat token for an astra.yaml — local or remote. Returned as an
 * opaque string the client can equality-compare across requests for the
 * same path; format differs between local (`mtimeMs` as decimal) and
 * remote (`stat -c %Y` seconds), but consistency-per-path is all the
 * staleness check needs. Returns null when the file is missing or the
 * remote stat call fails — callers translate to 404.
 *
 * Used by both `handleBundle` (so the bundle response carries its own
 * mtime, no second round-trip on first load) and `handleMtime` (a
 * standalone endpoint for cheap focus-event polling that skips the
 * buildBundle pipeline entirely).
 */
async function fetchAstraMtimeToken(
  originId: string,
  filePath: string,
  origin: { sshHost?: string } | null | undefined,
): Promise<string | null> {
  if (originId && originId !== 'local') {
    if (!origin?.sshHost) return null;
    try {
      const token = (await fetchRemoteAstraMtime(origin.sshHost, filePath)).trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
  if (!existsSync(filePath)) return null;
  try {
    return String(statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Parse `/astra-{paper-view,bundle,mtime}/{originId}{absPath}` into pieces.
 * Returns null if the path is malformed; the caller emits a 400.
 */
function parseAstraUrl(url: URL, prefix: string): { originId: string; filePath: string } | null {
  const rest = url.pathname.slice(prefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx < 0) return null;
  const originId = decodeURIComponent(rest.slice(0, slashIdx));
  const filePath = decodeURIComponent(rest.slice(slashIdx));
  return { originId, filePath };
}

export class HttpApiAstraView {
  private originLookup: OriginLookup;

  constructor(deps: HttpApiAstraViewDeps) {
    this.originLookup = deps.originLookup;
  }

  /**
   * Shared core for both `/astra-paper-view` and `/astra-bundle`. Validates
   * the path, resolves the project root (local or SSH-mirrored), runs
   * `buildBundle`, and rewrites artifact paths to portolan `/project-file`
   * URLs. Returns the rewritten bundle + csvs on success, or a structured
   * error the caller can surface in its preferred body shape.
   *
   * The two endpoints share *exactly* this pipeline — diverging only in
   * how they encode the result (paper-view.html template vs. JSON) and
   * the error body (stub HTML vs. text/plain). Keeping the resolution
   * here means the bundle a JSON consumer sees is the same one the
   * iframe pdfjs / paper-viewer.js sees, modulo presentation.
   */
  private async resolveAndBuildBundle(
    originId: string,
    filePath: string,
    universe: string,
    logTag: string,
  ): Promise<BundleBuildResult> {
    if (!filePath.startsWith('/') || filePath.includes('..')) {
      return { kind: 'error', status: 400, tag: 'invalid-path', message: 'Invalid path' };
    }
    if (!isAstraPath(filePath)) {
      return { kind: 'error', status: 400, tag: 'not-astra', message: 'Not an astra.yaml path' };
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
        return { kind: 'error', status: 404, tag: 'remote-disconnected', message: 'Remote origin not connected' };
      }
      try {
        buildRoot = await materializeRemoteSpec(origin.sshHost, originId, remoteRoot, filePath);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        console.error(`[${logTag}] remote materialise failed:`, message);
        return {
          kind: 'error',
          status: 502,
          tag: 'remote-materialise',
          message: `Failed to mirror the remote project tree from ${origin.sshHost}: ${message}`,
        };
      }
    } else {
      if (!existsSync(filePath)) {
        return { kind: 'error', status: 404, tag: 'not-found', message: `astra.yaml not found at ${filePath}` };
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
      console.error(`[${logTag}] buildBundle failed:`, message);
      return {
        kind: 'error',
        status: 500,
        tag: 'build-failed',
        message: `buildBundle threw for ${filePath} (universe ${universe}): ${message}`,
      };
    }

    // Remote: re-resolve `bundle.papers` using a local mirror of the remote
    // paper-cache index. Without this, `cached` reflects the *server's*
    // paper cache only — so a paper sitting at `~/.cache/astra/papers/...`
    // on the remote host but missing locally renders as "not in cache" and
    // the modal's PDF pane stays disabled. With it, the bundle marks the
    // paper cached and the URL we hand back (`/papers/{originId}/...`)
    // routes through `streamRemotePaperPdf` on click.
    //
    // Strategy: prefer a `cached: true` from either side. When local says
    // cached, keep local (the server already has the bytes — no SSH needed
    // for the modal). When local says uncached but remote says cached,
    // adopt the remote metadata (title/authors/version come from the
    // remote meta.json that we just mirrored).
    if (originId && originId !== 'local') {
      const origin = this.originLookup.getOrigin(originId);
      if (origin?.sshHost) {
        const remoteIndex = await materializeRemotePaperIndex(origin.sshHost, originId);
        const dois = Object.keys(bundle.papers);
        if (dois.length > 0 && existsSync(remoteIndex)) {
          const remotePapers = collectPaperMetadata(dois, remoteIndex);
          for (const doi of dois) {
            const local = bundle.papers[doi];
            const remote = remotePapers[doi];
            if (!local.cached && remote && remote.cached) {
              bundle.papers[doi] = remote;
            }
          }
        }
      }
    }

    // Always rewrite using the *remote* root so /project-file URLs land
    // on the right host. For local origins remoteRoot === buildRoot so
    // this is a no-op rename.
    const rewritten = rewriteBundlePaths(bundle, csvs, originId || 'local', remoteRoot);
    return { kind: 'ok', bundle: rewritten.bundle, csvs: rewritten.csvs, remoteRoot };
  }

  /**
   * Serve the rendered paper view for an astra.yaml at the given path.
   * URL shape: `/astra-paper-view/{originId}{absPath}[?universe=baseline][&as=paper|source]`.
   * `as=source` returns a syntax-styled view of the raw YAML so the pin
   * chrome can flip between the rich paper view and the underlying file
   * without leaving the iframe.
   */
  async handlePaperView(url: URL, res: ServerResponse): Promise<void> {
    const parsed = parseAstraUrl(url, '/astra-paper-view/');
    if (!parsed) {
      this.sendError(res, 400, 'Missing file path');
      return;
    }
    const { originId, filePath } = parsed;
    const universe = url.searchParams.get('universe') ?? 'baseline';
    const mode = url.searchParams.get('as') ?? 'paper';

    if (mode === 'source') {
      await this.handleSourceView(originId, filePath, res);
      return;
    }

    const built = await this.resolveAndBuildBundle(originId, filePath, universe, 'astra-paper-view');
    if (built.kind === 'error') {
      // Stub-html bodies for the iframe; the iframe loads our error page
      // and the user sees a coherent "build failed" / "remote unreachable"
      // panel instead of a network error toast.
      if (built.status === 502) {
        const body =
          `<p>Failed to mirror the remote project tree:</p>` +
          `<pre>${escapeHtml(built.message)}</pre>` +
          `<p class="hint">Check that the host is reachable and that the path exists.</p>`;
        res.writeHead(502, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(stubHtml('Astra paper view — remote mirror failed', body));
        return;
      }
      if (built.status === 500 && built.tag === 'build-failed') {
        const body = `<pre>${escapeHtml(built.message)}</pre>`;
        res.writeHead(500, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(stubHtml('Astra paper view — build failed', body));
        return;
      }
      this.sendError(res, built.status, built.message);
      return;
    }

    let template: string;
    try {
      template = readFileSync(templatePath('paper-view.html'), 'utf-8');
    } catch (err: any) {
      console.error('[astra-paper-view] template read failed:', err?.message ?? err);
      this.sendError(res, 500, 'paper-view template missing');
      return;
    }

    const html = renderPaperViewHtml(template, built.bundle, built.csvs);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  /**
   * Serve the raw, path-rewritten Bundle as JSON. URL shape:
   * `/astra-bundle/{originId}{absPath}[?universe=baseline]`.
   *
   * Same `buildBundle` pipeline as `handlePaperView`, same
   * `/project-file/...` rewrites — the only difference is the response
   * shape: `{ bundle, csvs }` JSON instead of paper-view.html.
   *
   * Vellum's native astra renderer (vellum-reader/vellum-native-astra-renderer
   * constitution) consumes this so it can run its own React rendering
   * over the same data lightcone-ui's iframe paper view does, with the
   * iframe path as the canonical reference. Switching ladder rungs in
   * the renderer is a presentation switch over a stable bundle, not a
   * re-fetch — but the bundle itself comes from here.
   */
  async handleBundle(url: URL, res: ServerResponse): Promise<void> {
    const parsed = parseAstraUrl(url, '/astra-bundle/');
    if (!parsed) {
      this.sendError(res, 400, 'Missing file path');
      return;
    }
    const { originId, filePath } = parsed;
    const universe = url.searchParams.get('universe') ?? 'baseline';

    const built = await this.resolveAndBuildBundle(originId, filePath, universe, 'astra-bundle');
    if (built.kind === 'error') {
      this.sendError(res, built.status, built.message);
      return;
    }

    // Stat the astra.yaml mtime alongside the build so the client gets a
    // staleness token in the same response. For remote, this is an extra
    // SSH stat — but that's the same call materializeRemoteSpec already
    // ran during the build, and the cost is dwarfed by the buildBundle
    // pipeline itself. Returning null is fine; the client just falls back
    // to the iframe-style "always re-fetch on cacheBust" behaviour.
    const origin = this.originLookup.getOrigin(originId);
    const mtime = await fetchAstraMtimeToken(originId, filePath, origin);

    const body = safeJson({ bundle: built.bundle, csvs: built.csvs, mtime });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // The bundle is a function of (astra.yaml mtime, project tree, universe).
      // Vellum re-fetches on focus/cache-bust per the constitution; mtime
      // reuse on the SSH mirror handles that for free. No-store keeps the
      // browser from staling the response under the user.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  /**
   * Cheap mtime probe for an astra.yaml. URL shape:
   * `/astra-mtime/{originId}{absPath}`.
   *
   * Returns `{ mtime: <token> }` where `<token>` is a string that compares
   * equal iff astra.yaml hasn't changed on disk. Local: `statSync.mtimeMs`.
   * Remote: SSH `stat -c %Y` (seconds). The format differs between
   * local/remote, but a given path always uses the same scheme — equality
   * comparison is meaningful.
   *
   * Used by the vellum-native astra renderer's focus-staleness check
   * (`vellum-reader/vellum-native-astra-renderer` open question "Bundle
   * staleness"). The renderer fetches the bundle once via `/astra-bundle`,
   * stores the included `mtime`, and on window-focus polls this endpoint —
   * skipping the buildBundle pipeline entirely. If the token differs, it
   * bumps an internal cache-bust counter that re-fetches the bundle.
   *
   * 404 when the file is missing (or remote stat returns nothing).
   */
  async handleMtime(url: URL, res: ServerResponse): Promise<void> {
    const parsed = parseAstraUrl(url, '/astra-mtime/');
    if (!parsed) {
      this.sendError(res, 400, 'Missing file path');
      return;
    }
    const { originId, filePath } = parsed;
    if (!filePath.startsWith('/') || filePath.includes('..')) {
      this.sendError(res, 400, 'Invalid path');
      return;
    }
    if (!isAstraPath(filePath)) {
      this.sendError(res, 400, 'Not an astra.yaml path');
      return;
    }

    const origin = this.originLookup.getOrigin(originId);
    if (originId && originId !== 'local' && !origin?.sshHost) {
      this.sendError(res, 404, 'Remote origin not connected');
      return;
    }

    const mtime = await fetchAstraMtimeToken(originId, filePath, origin);
    if (mtime == null) {
      this.sendError(res, 404, `astra.yaml not found at ${filePath}`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(safeJson({ mtime }));
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
   * Serve a cached paper PDF for the paper-viewer evidence modal.
   *
   * URL forms (origin-aware first, legacy second — both supported):
   *   - `/papers/{originId}/{cacheKey}/paper.pdf`   (preferred)
   *   - `/papers/{cacheKey}/paper.pdf`              (legacy → originId='local')
   *
   * For `originId === 'local'` (or the legacy form), reads from the
   * server-local ASTRA paper cache (`resolvePaperCacheDir()` →
   * `~/.cache/astra/papers` by default, `ASTRA_PAPER_CACHE_DIR` override).
   *
   * For a remote origin, SSH-fetches the PDF from the remote host's
   * `~/.cache/astra/papers/{cacheKey}/paper.pdf` into a local mirror
   * (`materializeRemotePaperPdf`) on first request, then serves from the
   * mirror. PDFs are immutable per cacheKey (DOI-keyed) so the local
   * mirror is permanent — second request hits the local file directly.
   *
   * cacheKey must be a single path segment matching `[A-Za-z0-9._-]+` —
   * DOIs with `/` are stored as `_`-substituted directory names, no
   * nested paths. 404 (not 500) when the cache file is missing so
   * paper-viewer's "Paper not in cache" branch fires cleanly.
   */
  async handlePaperPdf(url: URL, res: ServerResponse): Promise<void> {
    const prefix = '/papers/';
    const rest = url.pathname.slice(prefix.length);

    // Try origin-aware shape first: `<originId>/<cacheKey>/paper.pdf`.
    // Then fall back to legacy: `<cacheKey>/paper.pdf` (originId='local').
    let originId = 'local';
    let cacheKey: string;
    const originAware = rest.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/paper\.pdf$/);
    if (originAware) {
      originId = decodeURIComponent(originAware[1]);
      cacheKey = decodeURIComponent(originAware[2]);
    } else {
      const legacy = rest.match(/^([A-Za-z0-9._-]+)\/paper\.pdf$/);
      if (!legacy) {
        this.sendError(res, 404, 'Unknown paper cache path');
        return;
      }
      cacheKey = decodeURIComponent(legacy[1]);
    }

    if (originId && originId !== 'local') {
      await this.servePaperPdfRemote(originId, cacheKey, res);
      return;
    }

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

  /**
   * Serve a remote-origin paper PDF: ensure the local mirror exists
   * (SSH-cat from the remote host on first call) and stream it back.
   * Pulled out of `handlePaperPdf` for readability — the local-cache
   * path stays the dominant branch, this one carries the SSH side.
   */
  private async servePaperPdfRemote(
    originId: string,
    cacheKey: string,
    res: ServerResponse,
  ): Promise<void> {
    const origin = this.originLookup.getOrigin(originId);
    if (!origin?.sshHost) {
      this.sendError(res, 404, `Remote origin ${originId} not connected`);
      return;
    }
    let localPath: string | null;
    try {
      localPath = await materializeRemotePaperPdf(origin.sshHost, originId, cacheKey);
    } catch (err: any) {
      console.error('[paper-pdf] remote fetch failed:', err?.message ?? err);
      this.sendError(res, 502, `Remote paper fetch failed: ${err?.message ?? err}`);
      return;
    }
    if (!localPath) {
      this.sendError(res, 404, 'Paper not in remote cache');
      return;
    }
    try {
      const data = readFileSync(localPath);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=86400, immutable',
      });
      res.end(data);
    } catch (err: any) {
      console.error('[paper-pdf] mirrored read failed:', err?.message ?? err);
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
