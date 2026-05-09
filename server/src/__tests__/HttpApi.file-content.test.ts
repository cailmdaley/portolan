import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRawRequest } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import { httpRequest, stubOriginLookup, stubPersistenceLookup } from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-file-content');

const stubCityLookup = {
  getCityById: () => null,
};

async function rawRequest(
  api: HttpApi,
  path: string,
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await api.handleRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}${path}`;

      fetch(url)
        .then(async (res) => {
          const body = new Uint8Array(await res.arrayBuffer());
          server.close();
          resolve({ status: res.status, headers: res.headers, body });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

/**
 * Like `rawRequest` but speaks raw HTTP/1.1 so the request line preserves
 * percent-encoded `..` segments. fetch (undici) normalizes the URL before
 * sending, which makes path-traversal payloads collapse client-side and
 * never exercise the server-side guard. Used by the `/static/.felt`
 * traversal tests.
 */
async function rawHttpRequest(
  api: HttpApi,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const handled = await api.handleRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const req = httpRawRequest(
        { host: '127.0.0.1', port, method: 'GET', path },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            server.close();
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headers[k] = v;
              else if (Array.isArray(v)) headers[k] = v.join(', ');
            }
            resolve({
              status: res.statusCode || 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
        },
      );
      req.on('error', (error) => {
        server.close();
        reject(error);
      });
      req.end();
    });
  });
}

describe('HttpApi — /file-content endpoint', () => {
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('streams raw binary content for local files', async () => {
    const pngPath = join(TEST_DIR, 'sample.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    writeFileSync(pngPath, pngBytes);

    const res = await rawRequest(api, `/file-content?path=${encodeURIComponent(pngPath)}&raw=true`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(Buffer.from(res.body)).toEqual(pngBytes);
  });

  it('returns 404 for missing raw binary files', async () => {
    const missingPath = join(TEST_DIR, 'missing.png');

    const res = await rawRequest(api, `/file-content?path=${encodeURIComponent(missingPath)}&raw=true`);

    expect(res.status).toBe(404);
    expect(new TextDecoder().decode(res.body).toLowerCase()).toContain('not found');
  });

  it('keeps binary=true data-url mode for compatibility', async () => {
    const pngPath = join(TEST_DIR, 'compat.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    writeFileSync(pngPath, pngBytes);

    const res = await httpRequest(api, 'GET', `/file-content?path=${encodeURIComponent(pngPath)}&binary=true`);

    expect(res.status).toBe(200);
    expect(res.data.type).toBe('image');
    expect(res.data.path).toBe(pngPath);
    expect(res.data.url).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);
  });

  it('parses dollar math in markdown into KaTeX-backed mdast nodes', async () => {
    const mdPath = join(TEST_DIR, 'math.md');
    writeFileSync(mdPath, String.raw`Inline $C_\ell$ and display:

$$
\alpha + \beta
$$
`);

    const res = await httpRequest(api, 'GET', `/file-content?path=${encodeURIComponent(mdPath)}`);

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.data.mdast);
    expect(serialized).toContain('"type":"inlineMath"');
    expect(serialized).toContain('"type":"math"');
    expect(serialized).toContain('katex');
    expect(serialized).toContain('katex-mathml');
    expect(serialized).toContain('katex-html');
  });

  it('streams project files with content types inferred from extension', async () => {
    const htmlPath = join(TEST_DIR, 'slides deck', 'index.html');
    mkdirSync(join(TEST_DIR, 'slides deck'), { recursive: true });
    writeFileSync(htmlPath, '<!doctype html><link rel="stylesheet" href="slides.css">');

    const encodedPath = htmlPath.split('/').map(encodeURIComponent).join('/');
    const res = await rawRequest(api, `/project-file/local${encodedPath}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(new TextDecoder().decode(res.body)).toContain('slides.css');
  });

  it('injects the HTML location bridge into project HTML files', async () => {
    const htmlPath = join(TEST_DIR, 'deck.html');
    writeFileSync(htmlPath, '<!doctype html><html><head><title>Deck</title></head><body>slides</body></html>');

    const encodedPath = htmlPath.split('/').map(encodeURIComponent).join('/');
    const res = await rawRequest(api, `/project-file/local${encodedPath}?_portolan_frame=test-frame`);
    const body = new TextDecoder().decode(res.body);

    expect(res.status).toBe(200);
    expect(body).toContain('portolan-html-location');
    expect(body).toContain("window.parent.postMessage");
  });

  it('returns 404 for missing project files', async () => {
    const missingPath = join(TEST_DIR, 'missing', 'index.html');
    const encodedPath = missingPath.split('/').map(encodeURIComponent).join('/');

    const res = await rawRequest(api, `/project-file/local${encodedPath}`);

    expect(res.status).toBe(404);
    expect(new TextDecoder().decode(res.body)).toContain('File not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /static/.felt/<rest> — fiber-embedded image asset route
//
// Restored after commit 5755034 (tapestry retirement) deleted the static
// viewer Vite config that incidentally served this prefix. The route resolves
// `/static/.felt/<rest>` to `<feltRoot>/<rest>` and streams the file via
// the same binary streamer `/project-file/local/...` uses. See the
// constitution at vellum-reader/constitution-restore-static-felt-route and
// the gotcha at gotchas/static-felt-route-fragility.
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpApi — /static/.felt/<rest> asset route', () => {
  const FELT_ROOT = join(TEST_DIR, 'felt-root');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_ROOT, { recursive: true });
    api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
      { feltRoot: FELT_ROOT },
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('streams a PNG asset under .felt/ with image content-type', async () => {
    const dir = join(FELT_ROOT, 'vellum-reader', 'living-interface', 'mockups');
    mkdirSync(dir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    writeFileSync(join(dir, 'kanban-reference.png'), pngBytes);

    const res = await rawRequest(
      api,
      '/static/.felt/vellum-reader/living-interface/mockups/kanban-reference.png',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(res.body)).toEqual(pngBytes);
  });

  it('streams an SVG asset with image/svg+xml content-type', async () => {
    const dir = join(FELT_ROOT, 'vellum-reader', 'aesthetic', 'evidence');
    mkdirSync(dir, { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    writeFileSync(join(dir, 'palette.svg'), svg);

    const res = await rawRequest(
      api,
      '/static/.felt/vellum-reader/aesthetic/evidence/palette.svg',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(new TextDecoder().decode(res.body)).toContain('<rect/>');
  });

  it('returns 404 for a missing asset', async () => {
    const res = await rawRequest(
      api,
      '/static/.felt/vellum-reader/aesthetic/evidence/missing.svg',
    );
    expect(res.status).toBe(404);
    expect(new TextDecoder().decode(res.body)).toContain('File not found');
  });

  it('collapses raw `..` segments before they reach the handler', async () => {
    // Both undici (fetch) client-side and node's `new URL()` server-side
    // collapse raw `..` (and `%2e%2e`) path segments during normalization.
    // The static-felt route prefix is therefore stripped on the way in and
    // the request lands as `/etc/passwd`, falling through every route to
    // the test server's 404 fallback. This is the safest outcome — the
    // asset handler never gets a chance to resolve a traversal target —
    // so the test asserts "no /etc/passwd contents leaked" rather than a
    // specific 4xx code.
    const res = await rawHttpRequest(
      api,
      '/static/.felt/%2e%2e/%2e%2e/etc/passwd',
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(new TextDecoder().decode(res.body)).not.toContain('root:');
  });

  it('rejects encoded-slash traversal that survives URL normalization', async () => {
    // Encoding the slash (`%2f`) keeps a `..` segment intact through the
    // URL parser — `pathname` stays `/static/.felt/foo%2f..%2fbar`. The
    // handler's `decodeURIComponent` + segment check is what catches
    // this payload; without it, `path.resolve` would happily escape the
    // felt root.
    const dir = join(FELT_ROOT, 'sibling');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(TEST_DIR, 'leaked.txt'), 'sensitive');

    const res = await rawHttpRequest(
      api,
      '/static/.felt/sibling%2f..%2f..%2fleaked.txt',
    );
    expect(res.status).toBe(400);
    expect(new TextDecoder().decode(res.body)).toContain('Invalid path');
  });

  it('rejects an empty rest path', async () => {
    const res = await rawRequest(api, '/static/.felt/');
    expect(res.status).toBe(400);
  });

  it('rejects an absolute path injection via encoded leading slash', async () => {
    // `%2fetc/passwd` decodes to `/etc/passwd`; the leading-slash check
    // refuses rather than absolute-path-resolving outside the root.
    const res = await rawHttpRequest(api, '/static/.felt/%2fetc/passwd');
    expect(res.status).toBe(400);
  });
});
