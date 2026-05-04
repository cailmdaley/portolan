/**
 * Shared test helpers for HttpApi and AnnotationPersistence tests.
 *
 * Extracted from duplicated definitions across test files.
 */

import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AnnotationPersistence } from '../AnnotationPersistence.js';
import { HttpApi } from '../HttpApi.js';

// ── Stubs ────────────────────────────────────────────────────────────

export const stubOriginLookup = {
  getOrigin: () => null,
};

export const stubPersistenceLookup = {
  getCityById: () => null,
  // resolveKanbanApi reads pinned cities to thread per-card cityId/projectSlug
  // through HttpApiKanban (so the frontend can resolve loom-relative card ids
  // back to a project-scoped slug for click-through). Tests that don't care
  // about enrichment get an empty pin list — cards still render, just without
  // the extra fields.
  getCities: () => [] as Array<{ id: string; path: string; originId: string }>,
  findSshHostForPath: () => undefined,
};

// ── AnnotationPersistence factory ────────────────────────────────────

/** Create an AnnotationPersistence instance pointed at a test directory. */
export function makePersistence(testDir: string, testFile: string): AnnotationPersistence {
  const p = new AnnotationPersistence();
  (p as any).dataDir = testDir;
  (p as any).filePath = testFile;
  return p;
}

// ── City lookup stub ─────────────────────────────────────────────────

/** Create a city lookup stub that resolves a single city by id. */
export function makeCityLookup(cityId: string, cityDir: string, name: string = 'TestCity') {
  const city = {
    id: cityId,
    name,
    path: cityDir,
    originId: 'local',
  };
  return {
    getCityById: (id: string) => (id === cityId ? city : null),
    getCities: () => [city],
    isPinned: (id: string) => id === cityId,
  };
}

/**
 * Multi-city lookup stub. Each entry can override originId (defaults to
 * 'local'); useful for kanban-scope tests that exercise local vs remote
 * routing without spinning up a real CityManager.
 */
export function makeMultiCityLookup(
  entries: Array<{ id: string; path: string; name?: string; originId?: string }>,
) {
  const cities = entries.map((e) => ({
    id: e.id,
    name: e.name ?? e.id,
    path: e.path,
    originId: e.originId ?? 'local',
  }));
  const byId = new Map(cities.map((c) => [c.id, c]));
  return {
    getCityById: (id: string) => byId.get(id) ?? null,
    getCities: () => cities,
    isPinned: (id: string) => byId.has(id),
  };
}

// ── HTTP request helper ──────────────────────────────────────────────

/** Fire an HTTP request against an HttpApi instance and return parsed response. */
export async function httpRequest(
  api: HttpApi,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; data: any }> {
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
      const bodyStr = body ? JSON.stringify(body) : undefined;

      fetch(url, {
        method,
        headers: bodyStr ? { 'Content-Type': 'application/json' } : {},
        body: bodyStr,
      })
        .then(async (res) => {
          const text = await res.text();
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          server.close();
          resolve({ status: res.status, data });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Fiber file writer ────────────────────────────────────────────────

/** Write a directory-based fiber (slug/slug.md) into a .felt directory. */
export function writeFiber(feltDir: string, slug: string, content: string): void {
  const dir = join(feltDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content, 'utf-8');
}
