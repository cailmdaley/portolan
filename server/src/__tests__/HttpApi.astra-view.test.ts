import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import { isAstraPath } from '../HttpApiAstraView.js';
import { stubPersistenceLookup } from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-astra-view');

const stubCityLookup = {
  getCityById: () => null,
  getCities: () => [],
};

const stubOriginLookup = {
  getOrigin: (id: string) => (id && id !== 'local' ? { sshHost: 'fake.example.com' } : null),
};

async function rawRequest(api: HttpApi, path: string): Promise<{
  status: number;
  headers: Headers;
  body: string;
}> {
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
          const body = await res.text();
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

describe('isAstraPath', () => {
  it('matches canonical astra.yaml filenames', () => {
    expect(isAstraPath('/proj/astra.yaml')).toBe(true);
    expect(isAstraPath('/proj/astra.yml')).toBe(true);
    expect(isAstraPath('/proj/foo.astra.yaml')).toBe(true);
    expect(isAstraPath('astra.yaml')).toBe(true);
  });
  it('rejects non-astra yamls', () => {
    expect(isAstraPath('/proj/config.yaml')).toBe(false);
    expect(isAstraPath('/proj/astray.yaml')).toBe(false);
    expect(isAstraPath('')).toBe(false);
  });
});

describe('HttpApi — /astra-paper-view endpoint', () => {
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

  it('renders an html paper view for a local astra.yaml', async () => {
    const astraPath = join(TEST_DIR, 'astra.yaml');
    writeFileSync(
      astraPath,
      [
        '$schema: https://astra-spec.org/v1/analysis.schema.json',
        'version: "1.0"',
        'name: Test Analysis',
      ].join('\n'),
    );
    const encodedPath = astraPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');

    const res = await rawRequest(api, `/astra-paper-view/local${encodedPath}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.body).toContain('window.__BUNDLE__');
    expect(res.body).toContain('window.__CSV__');
    // Asset URLs should be rewritten to portolan's sidecar mount.
    expect(res.body).toContain('/astra/asset/vellum.css');
    expect(res.body).toContain('/astra/asset/paper-viewer.js');
    // The bundle should include the analysis title.
    expect(res.body).toContain('Test Analysis');
  });

  it('renders ?as=source as a styled YAML view', async () => {
    const astraPath = join(TEST_DIR, 'astra.yaml');
    writeFileSync(
      astraPath,
      [
        '# ASTRA spec',
        'name: Test',
        'version: "1.0"',
        'tags:',
        '  - foo',
      ].join('\n'),
    );
    const encodedPath = astraPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');

    const res = await rawRequest(api, `/astra-paper-view/local${encodedPath}?as=source`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // Source view doesn't include the bundle/__BUNDLE__ injection.
    expect(res.body).not.toContain('window.__BUNDLE__');
    // Comments and keys should be tagged for styling.
    expect(res.body).toContain('class="y-comm"');
    expect(res.body).toContain('class="y-key"');
    // Body content is preserved.
    expect(res.body).toContain('Test');
  });

  it('returns 400 for non-astra paths', async () => {
    const txtPath = join(TEST_DIR, 'notes.md');
    writeFileSync(txtPath, '# Hi\n');
    const encodedPath = txtPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');

    const res = await rawRequest(api, `/astra-paper-view/local${encodedPath}`);
    expect(res.status).toBe(400);
    expect(res.body.toLowerCase()).toContain('not an astra');
  });

  it('returns 404 for missing local astra.yaml', async () => {
    const missing = join(TEST_DIR, 'nope', 'astra.yaml');
    const encodedPath = missing
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    const res = await rawRequest(api, `/astra-paper-view/local${encodedPath}`);
    expect(res.status).toBe(404);
    expect(res.body.toLowerCase()).toContain('not found');
  });

  it('attempts SSH materialisation for remote astra.yaml (502 on unreachable host)', async () => {
    // The stubOriginLookup returns sshHost: 'fake.example.com' for any
    // non-local id; the SSH spawn will fail to connect, which the handler
    // surfaces as a 502 stub. (A real test of the success path needs a
    // live SSH host; that's a manual e2e against candide.)
    const remotePath = '/some/remote/lightcone-spec/astra.yaml';
    const encodedPath = remotePath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    const res = await rawRequest(api, `/astra-paper-view/remote-fake${encodedPath}`);
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.body.toLowerCase()).toContain('failed to mirror');
  }, 30000);

  it('serves vellum.css and paper-viewer.js from /astra/asset', async () => {
    const css = await rawRequest(api, '/astra/asset/vellum.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.body.length).toBeGreaterThan(0);

    const js = await rawRequest(api, '/astra/asset/paper-viewer.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.body.length).toBeGreaterThan(0);
  });

  it('rejects unknown asset names', async () => {
    const res = await rawRequest(api, '/astra/asset/secret.txt');
    expect(res.status).toBe(404);
  });
});

describe('HttpApi — /astra-bundle endpoint', () => {
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

  it('returns the JSON bundle for a local astra.yaml', async () => {
    const astraPath = join(TEST_DIR, 'astra.yaml');
    writeFileSync(
      astraPath,
      [
        '$schema: https://astra-spec.org/v1/analysis.schema.json',
        'version: "1.0"',
        'name: Bundle Test Analysis',
      ].join('\n'),
    );
    const encodedPath = astraPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');

    const res = await rawRequest(api, `/astra-bundle/local${encodedPath}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const parsed = JSON.parse(res.body) as { bundle: unknown; csvs: unknown };
    expect(parsed).toHaveProperty('bundle');
    expect(parsed).toHaveProperty('csvs');
    // The bundle's analysis name should round-trip through buildBundle.
    expect(JSON.stringify(parsed.bundle)).toContain('Bundle Test Analysis');
  });

  it('returns 400 for non-astra paths', async () => {
    const txtPath = join(TEST_DIR, 'notes.md');
    writeFileSync(txtPath, '# Hi\n');
    const encodedPath = txtPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');

    const res = await rawRequest(api, `/astra-bundle/local${encodedPath}`);
    expect(res.status).toBe(400);
    expect(res.body.toLowerCase()).toContain('not an astra');
  });

  it('returns 404 for missing local astra.yaml', async () => {
    const missing = join(TEST_DIR, 'nope', 'astra.yaml');
    const encodedPath = missing
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    const res = await rawRequest(api, `/astra-bundle/local${encodedPath}`);
    expect(res.status).toBe(404);
    expect(res.body.toLowerCase()).toContain('not found');
  });

  it('returns 502 for unreachable remote origin', async () => {
    // Same fail mode as /astra-paper-view but with a text/plain body
    // (JSON consumers don't want a stub-html error). The status code
    // and the SSH-tar failure semantics are identical.
    const remotePath = '/some/remote/lightcone-spec/astra.yaml';
    const encodedPath = remotePath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    const res = await rawRequest(api, `/astra-bundle/remote-fake${encodedPath}`);
    expect(res.status).toBe(502);
    expect(res.body.toLowerCase()).toContain('failed to mirror');
  }, 30000);

  it('rewrites bundle output paths to portolan project-file URLs', async () => {
    // Author a project with one figure output so the bundle has a
    // `resolved_path` slot that the rewrite pass should retarget at
    // /project-file/local/<absRoot>/<relPath>.
    const astraPath = join(TEST_DIR, 'astra.yaml');
    const figRel = 'results/baseline/fig1.png';
    writeFileSync(
      astraPath,
      [
        '$schema: https://astra-spec.org/v1/analysis.schema.json',
        'version: "1.0"',
        'name: Path Rewrite Test',
        'outputs:',
        '  - id: fig1',
        '    type: figure',
        '    description: A figure',
      ].join('\n'),
    );
    // Ensure the artifact exists so buildBundle resolves it.
    mkdirSync(join(TEST_DIR, 'results', 'baseline'), { recursive: true });
    writeFileSync(join(TEST_DIR, figRel), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const encodedPath = astraPath
      .split('/')
      .map((seg) => (seg ? encodeURIComponent(seg) : seg))
      .join('/');
    const res = await rawRequest(api, `/astra-bundle/local${encodedPath}`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { bundle: { outputs: Record<string, { resolved_path: string | null }> } };
    const fig = parsed.bundle.outputs.fig1;
    expect(fig).toBeDefined();
    if (fig?.resolved_path) {
      // resolved_path should be a portolan /project-file URL, not a bare
      // project-relative path.
      expect(fig.resolved_path).toContain('/project-file/local');
      expect(fig.resolved_path).toContain('fig1.png');
    }
  });
});

describe('HttpApi — /papers/<cacheKey>/paper.pdf endpoint', () => {
  const PAPER_CACHE_DIR = join(TEST_DIR, 'paper-cache');
  let api: HttpApi;
  let prevEnv: string | undefined;

  beforeEach(() => {
    mkdirSync(PAPER_CACHE_DIR, { recursive: true });
    prevEnv = process.env.ASTRA_PAPER_CACHE_DIR;
    process.env.ASTRA_PAPER_CACHE_DIR = PAPER_CACHE_DIR;
    api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ASTRA_PAPER_CACHE_DIR;
    else process.env.ASTRA_PAPER_CACHE_DIR = prevEnv;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('serves a cached paper.pdf', async () => {
    const cacheKey = '10.48550_arXiv.2402.14070';
    const dir = join(PAPER_CACHE_DIR, cacheKey);
    mkdirSync(dir, { recursive: true });
    // Minimal "valid PDF" header so paper-viewer.js's pdfjs sees something
    // PDF-shaped; the route doesn't care, this just proves the bytes
    // round-trip.
    writeFileSync(join(dir, 'paper.pdf'), Buffer.from('%PDF-1.4\n%fake\n'));

    const res = await rawRequest(api, `/papers/${encodeURIComponent(cacheKey)}/paper.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.body.startsWith('%PDF-1.4')).toBe(true);
  });

  it('returns 404 when the cache entry is missing', async () => {
    const res = await rawRequest(api, '/papers/10.48550_arXiv.MISSING/paper.pdf');
    expect(res.status).toBe(404);
    expect(res.body.toLowerCase()).toContain('paper not in cache');
  });

  it('rejects nested paths and traversal attempts', async () => {
    // Multi-segment cacheKey isn't allowed; only a single token then /paper.pdf.
    const traverse = await rawRequest(api, '/papers/..%2Fetc%2Fpasswd/paper.pdf');
    expect(traverse.status).toBe(404);
    const nested = await rawRequest(api, '/papers/foo/bar/paper.pdf');
    expect(nested.status).toBe(404);
    const notPdf = await rawRequest(api, '/papers/foo/secret.json');
    expect(notPdf.status).toBe(404);
  });
});
