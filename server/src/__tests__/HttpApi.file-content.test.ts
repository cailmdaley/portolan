import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
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
