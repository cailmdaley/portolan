/**
 * HttpApi claims annotation tests
 *
 * Tests the claims-specific behavior in HttpApi:
 * - GET /annotations?claimId= returns claim annotations
 * - POST /annotations creates claims annotations with validation
 * - formatClaimsAnnotationsForClaude output format
 * - Proxy injection of claims-annotate.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { AnnotationPersistence, Annotation } from '../AnnotationPersistence.js';
import { HttpApi } from '../HttpApi.js';
import { shellEscape } from '../KittyIntegration.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-claims');
const TEST_FILE = join(TEST_DIR, 'annotations.json');

// Minimal stubs for HttpApi constructor requirements
const stubCityLookup = {
  getCityById: () => null,
};
const stubOriginLookup = {
  getOrigin: () => null,
};
const stubPersistenceLookup = {
  getCityById: () => null,
};

function makePersistence(): AnnotationPersistence {
  const p = new AnnotationPersistence();
  (p as any).dataDir = TEST_DIR;
  (p as any).filePath = TEST_FILE;
  return p;
}

/** Factory: create an Annotation with claim defaults, overriding only what matters per test */
function makeClaimAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? '1',
    originId: 'local',
    comment: 'test comment',
    createdAt: Date.now(),
    isClaimAnnotation: true,
    claimId: 'c1',
    ...overrides,
  };
}

/** Helper: fire an HTTP request against HttpApi and return parsed response */
async function httpRequest(
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

describe('HttpApi — claims annotations', () => {
  let persistence: AnnotationPersistence;
  let api: HttpApi;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    persistence = makePersistence();
    persistence.load();

    api = new HttpApi(stubCityLookup as any, stubOriginLookup as any, stubPersistenceLookup as any);
    api.setAnnotationPersistence(persistence);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  /** Access private formatClaimsAnnotationsForClaude via api instance */
  function formatClaims(cityName: string, annotations: Annotation[], globalComment?: string): string {
    return (api as any).formatClaimsAnnotationsForClaude(cityName, annotations, globalComment);
  }

  /** Create a city lookup stub that resolves a single city by id */
  function makeCityLookup(cityId: string, cityDir: string, name: string) {
    return {
      getCityById: (id: string) => id === cityId ? {
        id: cityId,
        name,
        path: cityDir,
        originId: 'local',
      } : null,
    };
  }

  // ────────────────────────────────────────────────────────────
  // POST /annotations — create claims annotation
  // ────────────────────────────────────────────────────────────

  describe('POST /annotations (claims)', () => {
    it('creates a claim annotation with required fields', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Seems low',
        isClaimAnnotation: true,
        claimId: 'claim-1',
        claimTitle: 'B-modes consistent with zero',
        selectedText: 'PTE 0.29',
      });

      expect(res.status).toBe(201);
      expect(res.data.annotation).toBeDefined();
      expect(res.data.annotation.isClaimAnnotation).toBe(true);
      expect(res.data.annotation.claimId).toBe('claim-1');
      expect(res.data.annotation.claimTitle).toBe('B-modes consistent with zero');
      expect(res.data.annotation.selectedText).toBe('PTE 0.29');
    });

    it('creates a claim image annotation', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Edge effects visible',
        isClaimAnnotation: true,
        claimId: 'claim-2',
        claimTitle: 'Galaxy generation pipeline',
        artifact: 'galaxy_fields.png',
        x: 45.2,
        y: 31.8,
        isImageAnnotation: true,
      });

      expect(res.status).toBe(201);
      expect(res.data.annotation.artifact).toBe('galaxy_fields.png');
      expect(res.data.annotation.x).toBe(45.2);
      expect(res.data.annotation.y).toBe(31.8);
    });

    it('rejects claim annotation without claimId', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Missing claimId',
        isClaimAnnotation: true,
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/claimId/i);
    });

    it('rejects claim annotation without comment', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        isClaimAnnotation: true,
        claimId: 'claim-1',
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/comment/i);
    });
  });

  // ────────────────────────────────────────────────────────────
  // GET /annotations?claimId=
  // ────────────────────────────────────────────────────────────

  describe('GET /annotations?claimId=', () => {
    it('returns annotations for a specific claim', async () => {
      persistence.add({
        originId: 'local',
        comment: 'First',
        isClaimAnnotation: true,
        claimId: 'claim-1',
        claimTitle: 'Test claim',
      } as any);
      persistence.add({
        originId: 'local',
        comment: 'Second',
        isClaimAnnotation: true,
        claimId: 'claim-1',
        claimTitle: 'Test claim',
      } as any);
      persistence.add({
        originId: 'local',
        comment: 'Other',
        isClaimAnnotation: true,
        claimId: 'claim-2',
        claimTitle: 'Other claim',
      } as any);

      const res = await httpRequest(api, 'GET', '/annotations?claimId=claim-1');

      expect(res.status).toBe(200);
      expect(res.data.annotations).toHaveLength(2);
      expect(res.data.annotations.every((a: any) => a.claimId === 'claim-1')).toBe(true);
    });

    it('returns empty array for unknown claim', async () => {
      const res = await httpRequest(api, 'GET', '/annotations?claimId=nonexistent');

      expect(res.status).toBe(200);
      expect(res.data.annotations).toHaveLength(0);
    });

    it('does not return file annotations when querying by claimId', async () => {
      persistence.add({
        originId: 'local',
        comment: 'File annotation',
        filePath: '/test/file.ts',
        from: 0,
        to: 10,
      } as any);
      persistence.add({
        originId: 'local',
        comment: 'Claim annotation',
        isClaimAnnotation: true,
        claimId: 'claim-1',
        claimTitle: 'Test',
      } as any);

      const res = await httpRequest(api, 'GET', '/annotations?claimId=claim-1');

      expect(res.status).toBe(200);
      expect(res.data.annotations).toHaveLength(1);
      expect(res.data.annotations[0].isClaimAnnotation).toBe(true);
    });

    it('returns 400 when neither path nor claimId provided', async () => {
      const res = await httpRequest(api, 'GET', '/annotations');

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/path.*claimId|claimId.*path/i);
    });
  });

  // ────────────────────────────────────────────────────────────
  // formatClaimsAnnotationsForClaude
  // ────────────────────────────────────────────────────────────

  describe('formatClaimsAnnotationsForClaude', () => {
    it('formats text annotations', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'Seems low — recheck with different bin edges',
          claimId: 'claim-1',
          claimTitle: 'B-modes consistent with zero',
          selectedText: 'PTE 0.29',
        }),
      ];

      const output = formatClaims('pure-eb', annotations);

      expect(output).toContain('# Claims review: pure-eb');
      expect(output).toContain('## 1. [B-modes consistent with zero]');
      expect(output).toContain('> On text: "PTE 0.29"');
      expect(output).toContain('> Seems low — recheck with different bin edges');
      expect(output).toContain('---');
    });

    it('formats image/artifact annotations with position', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'Check edge effects on velocity',
          claimId: 'claim-2',
          claimTitle: 'Galaxy generation pipeline',
          artifact: 'galaxy_fields.png',
          x: 45,
          y: 32,
        }),
      ];

      const output = formatClaims('pure-eb', annotations);

      expect(output).toContain('## 1. [Galaxy generation pipeline]');
      expect(output).toContain('> On plot: galaxy_fields.png (at 45%, 32%)');
      expect(output).toContain('> Check edge effects on velocity');
    });

    it('formats multiple annotations with numbering', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'First', claimTitle: 'Claim A', selectedText: 'text A',
        }),
        makeClaimAnnotation({
          id: '2', comment: 'Second',
          claimId: 'c2', claimTitle: 'Claim B', artifact: 'plot.png', x: 10, y: 20,
        }),
      ];

      const output = formatClaims('test', annotations);

      expect(output).toContain('## 1. [Claim A]');
      expect(output).toContain('## 2. [Claim B]');
      expect(output).toContain('2 pieces of feedback');
    });

    it('includes global comment when provided', () => {
      const output = formatClaims('test', [], 'Overall the analysis looks solid.');

      expect(output).toContain('# Claims review: test');
      expect(output).toContain('Overall the analysis looks solid.');
    });

    it('handles single annotation pluralization', () => {
      const annotations = [
        makeClaimAnnotation({ comment: 'Just one', claimTitle: 'Single' }),
      ];

      const output = formatClaims('test', annotations);
      expect(output).toContain('1 piece of feedback');
    });

    it('truncates long selected text', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'Too long', claimTitle: 'Long Text',
          selectedText: 'A'.repeat(100),
        }),
      ];

      const output = formatClaims('test', annotations);
      // selectedText is sliced to 60 chars with ellipsis
      expect(output).toContain('"' + 'A'.repeat(60) + '…"');
      expect(output).not.toContain('A'.repeat(100));
    });

    it('falls back to claimId when claimTitle missing', () => {
      const annotations = [
        makeClaimAnnotation({ comment: 'No title', claimId: 'claim-xyz' }),
      ];

      const output = formatClaims('test', annotations);
      expect(output).toContain('[claim-xyz]');
    });

    it('groups multiple annotations under the same claim heading', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'First note', claimId: 'c1', claimTitle: 'B-modes',
          selectedText: 'PTE 0.29',
        }),
        makeClaimAnnotation({
          id: '2', comment: 'Second note', claimId: 'c1', claimTitle: 'B-modes',
          artifact: 'b_modes.png', x: 50, y: 25,
        }),
        makeClaimAnnotation({
          id: '3', comment: 'Other claim', claimId: 'c2', claimTitle: 'Galaxy pipeline',
        }),
      ];

      const output = formatClaims('test', annotations);

      // Single heading for B-modes (not repeated)
      expect(output).toContain('## 1. [B-modes]');
      expect(output).toContain('## 2. [Galaxy pipeline]');
      // Both annotations under claim 1
      expect(output).toContain('> On text: "PTE 0.29"');
      expect(output).toContain('> On plot: b_modes.png (at 50%, 25%)');
      // B-modes heading appears only once
      const headingMatches = output.match(/\[B-modes\]/g);
      expect(headingMatches).toHaveLength(1);
      // 3 total annotations
      expect(output).toContain('3 pieces of feedback');
    });
  });

  // ────────────────────────────────────────────────────────────
  // Claims annotation CRUD round-trip
  // ────────────────────────────────────────────────────────────

  describe('CRUD round-trip', () => {
    it('create → get → update → delete', async () => {
      // Create
      const createRes = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Initial',
        isClaimAnnotation: true,
        claimId: 'claim-crud',
        claimTitle: 'CRUD Test',
      });
      expect(createRes.status).toBe(201);
      const id = createRes.data.annotation.id;

      // Get
      const getRes = await httpRequest(api, 'GET', '/annotations?claimId=claim-crud');
      expect(getRes.status).toBe(200);
      expect(getRes.data.annotations).toHaveLength(1);
      expect(getRes.data.annotations[0].comment).toBe('Initial');

      // Update
      const updateRes = await httpRequest(api, 'PUT', `/annotations/${id}`, {
        comment: 'Revised',
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.data.annotation.comment).toBe('Revised');

      // Delete
      const deleteRes = await httpRequest(api, 'DELETE', `/annotations/${id}`);
      expect(deleteRes.status).toBe(200);

      // Verify gone
      const finalRes = await httpRequest(api, 'GET', '/annotations?claimId=claim-crud');
      expect(finalRes.data.annotations).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // GET /annotations?claims=true — all claims annotations
  // ────────────────────────────────────────────────────────────

  describe('GET /annotations?claims=true', () => {
    it('returns all claims annotations across claims', async () => {
      persistence.add({
        originId: 'local', comment: 'A', isClaimAnnotation: true,
        claimId: 'c1', claimTitle: 'First',
      } as any);
      persistence.add({
        originId: 'local', comment: 'B', isClaimAnnotation: true,
        claimId: 'c2', claimTitle: 'Second',
      } as any);
      persistence.add({
        originId: 'local', comment: 'File only',
        filePath: '/test/file.ts', from: 0, to: 10,
      } as any);

      const res = await httpRequest(api, 'GET', '/annotations?claims=true');

      expect(res.status).toBe(200);
      expect(res.data.annotations).toHaveLength(2);
      expect(res.data.annotations.every((a: any) => a.isClaimAnnotation)).toBe(true);
    });

    it('returns empty array when no claims exist', async () => {
      persistence.add({
        originId: 'local', comment: 'File only',
        filePath: '/test/file.ts', from: 0, to: 10,
      } as any);

      const res = await httpRequest(api, 'GET', '/annotations?claims=true');

      expect(res.status).toBe(200);
      expect(res.data.annotations).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Image annotation validation
  // ────────────────────────────────────────────────────────────

  describe('POST /annotations — image validation', () => {
    it('rejects claim image annotation without x coordinate', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Missing position',
        isClaimAnnotation: true,
        claimId: 'claim-img',
        artifact: 'plot.png',
        y: 50,
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/x and y/i);
    });

    it('rejects claim image annotation without y coordinate', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Missing position',
        isClaimAnnotation: true,
        claimId: 'claim-img',
        artifact: 'plot.png',
        x: 50,
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/x and y/i);
    });

    it('accepts claim image annotation with both coordinates', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Valid image',
        isClaimAnnotation: true,
        claimId: 'claim-img',
        artifact: 'plot.png',
        x: 45, y: 32,
      });

      expect(res.status).toBe(201);
    });

    it('accepts claim text annotation without artifact', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'Just text',
        isClaimAnnotation: true,
        claimId: 'claim-txt',
        selectedText: 'some text',
      });

      expect(res.status).toBe(201);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Delete annotation lifecycle
  // ────────────────────────────────────────────────────────────

  describe('DELETE /annotations/:id (claims)', () => {
    it('deletes a claims annotation and removes it from claimId query', async () => {
      const createRes = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'To delete',
        isClaimAnnotation: true,
        claimId: 'claim-del',
      });
      expect(createRes.status).toBe(201);
      const id = createRes.data.annotation.id;

      const deleteRes = await httpRequest(api, 'DELETE', `/annotations/${id}`);
      expect(deleteRes.status).toBe(200);

      const getRes = await httpRequest(api, 'GET', '/annotations?claimId=claim-del');
      expect(getRes.data.annotations).toHaveLength(0);

      // Also gone from all-claims query
      const allRes = await httpRequest(api, 'GET', '/annotations?claims=true');
      expect(allRes.data.annotations).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // /claims-annotate.js endpoint
  // ────────────────────────────────────────────────────────────

  describe('GET /claims-annotate.js', () => {
    it('serves the annotation script with correct content type', async () => {
      const res = await httpRequest(api, 'GET', '/claims-annotate.js');

      expect(res.status).toBe(200);
      // The response is JavaScript content (string, not parsed JSON)
      expect(typeof res.data).toBe('string');
      expect(res.data).toContain('claims-annotation-save');
      expect(res.data).toContain('claims-annotation-load');
      expect(res.data).toContain('claims-annotation-delete');
      expect(res.data).toContain('claims-annotation-promote');
      expect(res.data).toContain('window === window.top');
    });

    it('includes auto-bridging for dashboards without data attributes', async () => {
      const res = await httpRequest(api, 'GET', '/claims-annotate.js');

      expect(res.status).toBe(200);
      // Auto-tagging reads dashboard globals to inject data attributes
      expect(res.data).toContain('getClaimContextFromGlobals');
      expect(res.data).toContain('autoTagClaimPanel');
      expect(res.data).toContain('currentClaimId');
      expect(res.data).toContain('claimGraph');
      // Derives artifact name from image src when data-artifact is missing
      expect(res.data).toContain('img:not([data-artifact])');
    });
  });

  // ────────────────────────────────────────────────────────────
  // POST /promote-to-felt
  // ────────────────────────────────────────────────────────────

  describe('POST /promote-to-felt', () => {
    it('rejects request without required fields', async () => {
      const res = await httpRequest(api, 'POST', '/promote-to-felt', {
        claimId: 'claim-1',
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/claimId.*comment.*cityId|Missing required/i);
    });

    it('rejects request with empty body', async () => {
      const res = await httpRequest(api, 'POST', '/promote-to-felt', {});

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/Missing required/i);
    });

    it('returns 404 for unknown city', async () => {
      const res = await httpRequest(api, 'POST', '/promote-to-felt', {
        claimId: 'claim-1',
        comment: 'Test comment',
        cityId: 'nonexistent-city',
      });

      expect(res.status).toBe(404);
      expect(res.data.error).toMatch(/City not found/i);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Claims dashboard proxy injection
  // ────────────────────────────────────────────────────────────

  describe('GET /claims-dashboard (proxy injection)', () => {
    const MOCK_CITY_DIR = join(TEST_DIR, 'mock-city');
    const MOCK_DASHBOARD = join(MOCK_CITY_DIR, 'results', 'claims', 'index.html');

    const MOCK_DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head><title>Claims</title></head>
<body>
<img src="claim_id/plot.png" alt="Plot">
<style>@font-face { url('fonts/custom.woff2') }</style>
<script>
let currentClaimId = null;
const claimGraph = {};
const imgPath = claim.id + '/' + path.split('/').pop();
const lightbox = { src: claim.id + '/' + artifactPath };
</script>
</body>
</html>`;

    let cityApi: HttpApi;

    beforeEach(() => {
      const dashDir = join(MOCK_CITY_DIR, 'results', 'claims');
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(MOCK_DASHBOARD, MOCK_DASHBOARD_HTML, 'utf-8');

      cityApi = new HttpApi(
        makeCityLookup('test-city', MOCK_CITY_DIR, 'TestCity') as any,
        stubOriginLookup as any, stubPersistenceLookup as any,
      );
    });

    it('injects claims-annotate.js script tag', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      expect(res.status).toBe(200);
      expect(res.data).toContain('<script src="/claims-annotate.js"></script>');
    });

    it('injects CLAIMS_ASSETS_BASE and CLAIMS_CITY_ID globals', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      expect(res.data).toContain('window.CLAIMS_ASSETS_BASE = "/claims-assets"');
      expect(res.data).toContain('window.CLAIMS_CITY_ID = "test-city"');
    });

    it('rewrites static image src to use proxy', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      expect(res.data).toContain('src="/claims-assets/claim_id/plot.png?cityId=test-city"');
      expect(res.data).not.toContain('src="claim_id/plot.png"');
    });

    it('rewrites CSS font urls to use proxy', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      expect(res.data).toContain("url('/claims-assets/fonts/custom.woff2?cityId=test-city')");
    });

    it('rewrites dynamic imgPath construction', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      expect(res.data).toContain('window.CLAIMS_ASSETS_BASE');
      expect(res.data).toContain('window.CLAIMS_CITY_ID');
      // Original imgPath construction should be rewritten
      expect(res.data).not.toMatch(/const imgPath = claim\.id \+ '\/'/);
    });

    it('promotes let/const to var for annotation bridge globals', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=test-city');

      // let currentClaimId → var currentClaimId (so window.currentClaimId works)
      expect(res.data).toContain('var currentClaimId');
      expect(res.data).not.toContain('let currentClaimId');
      // const claimGraph → var claimGraph (so window.claimGraph works)
      expect(res.data).toContain('var claimGraph');
      // Other const declarations should be untouched
      expect(res.data).toContain('const lightbox');
    });

    it('returns 400 without cityId', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard');

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown city', async () => {
      const res = await httpRequest(cityApi, 'GET', '/claims-dashboard?cityId=nonexistent');

      expect(res.status).toBe(404);
    });

    it('sanitizes cityId to prevent XSS in injected script', async () => {
      // Create a city with a dangerous-looking ID
      const xssId = 'test"></script><script>alert(1)</script>';
      const xssCityDir = join(TEST_DIR, 'xss-city');
      const xssDashDir = join(xssCityDir, 'results', 'claims');
      mkdirSync(xssDashDir, { recursive: true });
      writeFileSync(join(xssDashDir, 'index.html'), MOCK_DASHBOARD_HTML, 'utf-8');

      const xssLookup = {
        getCityById: (id: string) => id === xssId ? {
          id: xssId,
          name: 'XSS City',
          path: xssCityDir,
          originId: 'local',
        } : null,
      };
      const xssApi = new HttpApi(xssLookup as any, stubOriginLookup as any, stubPersistenceLookup as any);

      const res = await httpRequest(xssApi, 'GET', `/claims-dashboard?cityId=${encodeURIComponent(xssId)}`);

      expect(res.status).toBe(200);
      // Script-breaking characters stripped: no closing/opening script tags
      expect(res.data).not.toContain('</script><script>');
      // Quotes and angle brackets removed from injected cityId
      expect(res.data).not.toContain('CLAIMS_CITY_ID = "test"');
      expect(res.data).toContain('CLAIMS_CITY_ID = "test');
      // The original dangerous payload is defanged
      expect(res.data).not.toMatch(/<script>alert/);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Realistic dashboard proxy rewrite (modeled on KineLens)
  // ────────────────────────────────────────────────────────────

  describe('GET /claims-dashboard — realistic dashboard proxy rewrite', () => {
    const REAL_CITY_DIR = join(TEST_DIR, 'kinelens-city');
    const REAL_DASHBOARD = join(REAL_CITY_DIR, 'results', 'claims', 'index.html');

    // HTML closely modeled on actual KineLens claims dashboard structure
    const REALISTIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>KineLens Claims</title>
    <link href="https://fonts.googleapis.com/css2?family=EB+Garamond&display=swap" rel="stylesheet">
    <style>
        @font-face {
            font-family: 'EBGaramondInitialsF1';
            src: url('EBGaramond-InitialsF1.otf') format('opentype');
            font-weight: normal;
        }
        @font-face {
            font-family: 'EBGaramondLocal';
            src: url('EBGaramond12-Regular.otf') format('opentype');
            font-weight: normal;
        }
        @font-face {
            font-family: 'EBGaramondLocal';
            src: url('EBGaramond12-Italic.otf') format('opentype');
            font-style: italic;
        }
        .claim-panel { padding: 1rem; }
        .artifact img { max-width: 100%; cursor: pointer; }
    </style>
</head>
<body>
    <div id="sidebar">
        <img src="logo.png" alt="Logo">
    </div>
    <div class="claim-panel" id="claim-panel"></div>
    <div class="lightbox">
        <img src="" alt="Lightbox">
    </div>

<script>
let currentClaimId = null;
let currentPlotIndex = 0;
const claimGraph = {};
const evidenceCache = {};
let lightboxOpen = false;

// Populate claim graph
claims.forEach(c => {
    claimGraph[c.id] = {
        data: c,
        children: [],
    };
});

function renderClaim() {
    if (!currentClaimId) return;
    const claim = claimGraph[currentClaimId].data;
    const artifactEntries = Object.entries(claim.artifacts);
    let artifactsHtml = '';
    if (artifactEntries.length > 0) {
        const [name, path] = artifactEntries[currentPlotIndex];
        const imgPath = claim.id + '/' + path.split('/').pop();
        artifactsHtml = '<div class="artifact"><img src="' + imgPath + '" alt="' + name + '"></div>';
    }
    document.getElementById('claim-panel').innerHTML = artifactsHtml;
}

function openLightbox(clickedSrc) {
    const claim = claimGraph[currentClaimId].data;
    const artifactEntries = Object.entries(claim.artifacts);
    lightboxImages = artifactEntries.map(([name, path]) => ({
        name: name,
        src: claim.id + '/' + path.split('/').pop()
    }));
    document.querySelector('.lightbox img').src = lightboxImages[0].src;
}

function selectClaim(claimId) {
    if (!claimGraph[claimId]) return;
    currentClaimId = claimId;
    renderClaim();
}
</script>
</body>
</html>`;

    let realApi: HttpApi;

    beforeEach(() => {
      const dashDir = join(REAL_CITY_DIR, 'results', 'claims');
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(REAL_DASHBOARD, REALISTIC_HTML, 'utf-8');

      realApi = new HttpApi(
        makeCityLookup('kinelens', REAL_CITY_DIR, 'KineLens') as any,
        stubOriginLookup as any, stubPersistenceLookup as any,
      );
    });

    it('rewrites all @font-face url() declarations', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      expect(res.status).toBe(200);
      // All three font files rewritten
      expect(res.data).toContain("url('/claims-assets/EBGaramond-InitialsF1.otf?cityId=kinelens')");
      expect(res.data).toContain("url('/claims-assets/EBGaramond12-Regular.otf?cityId=kinelens')");
      expect(res.data).toContain("url('/claims-assets/EBGaramond12-Italic.otf?cityId=kinelens')");
      // Original bare font URLs replaced
      expect(res.data).not.toContain("url('EBGaramond-InitialsF1.otf')");
      expect(res.data).not.toContain("url('EBGaramond12-Regular.otf')");
    });

    it('rewrites static <img src> for images in body', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // logo.png in sidebar rewritten
      expect(res.data).toContain('src="/claims-assets/logo.png?cityId=kinelens"');
      expect(res.data).not.toContain('src="logo.png"');
    });

    it('does not rewrite external Google Fonts link', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // External link left untouched
      expect(res.data).toContain('href="https://fonts.googleapis.com');
    });

    it('rewrites imgPath construction inside renderClaim', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // The imgPath line should be rewritten to use CLAIMS_ASSETS_BASE
      expect(res.data).toContain('window.CLAIMS_ASSETS_BASE');
      expect(res.data).not.toMatch(/const imgPath = claim\.id \+ '\/'/);
    });

    it('promotes let currentClaimId and const claimGraph to var', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      expect(res.data).toContain('var currentClaimId');
      expect(res.data).not.toContain('let currentClaimId');
      expect(res.data).toContain('var claimGraph');
      expect(res.data).not.toContain('const claimGraph');
    });

    it('does not promote unrelated let/const declarations', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // These should remain untouched
      expect(res.data).toContain('let currentPlotIndex');
      expect(res.data).toContain('const evidenceCache');
      expect(res.data).toContain('let lightboxOpen');
      expect(res.data).toContain('let artifactsHtml');
    });

    it('preserves #claim-panel element for annotation script auto-bridging', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      expect(res.data).toContain('id="claim-panel"');
      expect(res.data).toContain('class="claim-panel"');
    });

    it('injects annotation infrastructure into <head>', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // Script injection happens right after <head>
      const headIdx = res.data.indexOf('<head>');
      const scriptIdx = res.data.indexOf('window.CLAIMS_ASSETS_BASE');
      const annotateIdx = res.data.indexOf('claims-annotate.js');

      expect(headIdx).toBeGreaterThan(-1);
      expect(scriptIdx).toBeGreaterThan(headIdx);
      expect(annotateIdx).toBeGreaterThan(headIdx);
    });

    it('empty lightbox img src is not rewritten (no image extension)', async () => {
      const res = await httpRequest(realApi, 'GET', '/claims-dashboard?cityId=kinelens');

      // The lightbox <img src=""> has no file extension, so src rewrite regex doesn't match
      expect(res.data).toContain('src=""');
    });
  });

  // ────────────────────────────────────────────────────────────
  // formatClaimsAnnotationsForClaude — additional edge cases
  // ────────────────────────────────────────────────────────────

  describe('formatClaimsAnnotationsForClaude — edge cases', () => {
    it('formats comment-only annotations (no selectedText or artifact)', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'This claim needs more evidence',
          claimTitle: 'Dark energy equation of state',
        }),
      ];

      const output = formatClaims('test', annotations);

      expect(output).toContain('## 1. [Dark energy equation of state]');
      expect(output).toContain('> This claim needs more evidence');
      // Should not contain "On text:" or "On plot:" lines
      expect(output).not.toContain('On text:');
      expect(output).not.toContain('On plot:');
    });

    it('handles empty annotations array', () => {
      const output = formatClaims('test', []);

      expect(output).toContain('# Claims review: test');
      expect(output).toContain('---');
      expect(output).not.toContain('pieces of feedback');
    });

    it('handles mixed annotation types under the same claim', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'General note',
          claimId: 'c1',
          claimTitle: 'Multi-type claim',
        }),
        makeClaimAnnotation({
          id: '2',
          comment: 'Text note',
          claimId: 'c1',
          claimTitle: 'Multi-type claim',
          selectedText: 'PTE = 0.3',
        }),
        makeClaimAnnotation({
          id: '3',
          comment: 'Image note',
          claimId: 'c1',
          claimTitle: 'Multi-type claim',
          artifact: 'spectrum.png',
          x: 50,
          y: 25,
        }),
      ];

      const output = formatClaims('test', annotations);

      // Single heading for all three
      const headingMatches = output.match(/\[Multi-type claim\]/g);
      expect(headingMatches).toHaveLength(1);
      // All three annotation types present
      expect(output).toContain('> General note');
      expect(output).toContain('> On text: "PTE = 0.3"');
      expect(output).toContain('> On plot: spectrum.png (at 50%, 25%)');
      expect(output).toContain('3 pieces of feedback');
    });

    it('handles image annotation without coordinates', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'General plot note',
          artifact: 'overview.png',
        }),
      ];

      const output = formatClaims('test', annotations);

      expect(output).toContain('> On plot: overview.png');
      // No position reference when x/y are undefined
      expect(output).not.toContain('at');
    });
  });

  // ────────────────────────────────────────────────────────────
  // Claims assets proxy — security
  // ────────────────────────────────────────────────────────────

  describe('GET /claims-assets (security)', () => {
    it('rejects path traversal in nested segments', async () => {
      // URL parser resolves bare ../.. but not embedded traversal segments
      const res = await httpRequest(api, 'GET', '/claims-assets/sub/..%2F..%2Fetc/passwd?cityId=test');

      // Either 400 (caught by traversal check) or 404 (city not found) — never serves the file
      expect([400, 404]).toContain(res.status);
    });

    it('rejects shell injection via dollar substitution', async () => {
      const res = await httpRequest(api, 'GET', '/claims-assets/$(id).png?cityId=test');

      expect(res.status).toBe(400);
      expect(res.data).toContain('Invalid asset path');
    });

    it('rejects shell injection via backticks', async () => {
      const res = await httpRequest(api, 'GET', '/claims-assets/`whoami`.png?cityId=test');

      expect(res.status).toBe(400);
      expect(res.data).toContain('Invalid asset path');
    });

    it('accepts clean asset paths', async () => {
      // Will 404 (city not found) but should pass the security check
      const res = await httpRequest(api, 'GET', '/claims-assets/claim-123/plot.png?cityId=test');

      // 404 because stub city lookup returns null — but NOT 400
      expect(res.status).toBe(404);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Special characters in annotation comments
  // ────────────────────────────────────────────────────────────

  describe('annotations with special characters', () => {
    it('handles single quotes in comment', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: "it's got single quotes",
        isClaimAnnotation: true,
        claimId: 'claim-sq',
        claimTitle: 'Single quotes test',
      });

      expect(res.status).toBe(201);
      expect(res.data.annotation.comment).toBe("it's got single quotes");
    });

    it('handles double quotes in comment', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'the "scare quotes" issue',
        isClaimAnnotation: true,
        claimId: 'claim-dq',
        claimTitle: 'Double quotes test',
      });

      expect(res.status).toBe(201);
      expect(res.data.annotation.comment).toBe('the "scare quotes" issue');
    });

    it('handles unicode in selectedText', async () => {
      const res = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment: 'check this',
        isClaimAnnotation: true,
        claimId: 'claim-uni',
        selectedText: 'σ = 2.3 ± 0.1',
      });

      expect(res.status).toBe(201);
      expect(res.data.annotation.selectedText).toBe('σ = 2.3 ± 0.1');
    });

    it('round-trips special chars through CRUD', async () => {
      const comment = "it's a \"complex\" note — with em-dash & symbols <>";

      const createRes = await httpRequest(api, 'POST', '/annotations', {
        originId: 'local',
        comment,
        isClaimAnnotation: true,
        claimId: 'claim-special',
        claimTitle: 'Special chars',
        selectedText: 'PTE < 0.05 & σ > 3',
      });
      expect(createRes.status).toBe(201);
      const id = createRes.data.annotation.id;

      const getRes = await httpRequest(api, 'GET', '/annotations?claimId=claim-special');
      expect(getRes.status).toBe(200);
      expect(getRes.data.annotations[0].comment).toBe(comment);
      expect(getRes.data.annotations[0].selectedText).toBe('PTE < 0.05 & σ > 3');

      // Verify format output handles special chars
      const formatClaims = (api as any).formatClaimsAnnotationsForClaude.bind(api);
      const formatted = formatClaims('test', getRes.data.annotations);
      expect(formatted).toContain('PTE < 0.05 & σ > 3');
      expect(formatted).toContain(comment);

      // Clean up
      await httpRequest(api, 'DELETE', `/annotations/${id}`);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Proxy injection: selectedClaimId variant
  // ────────────────────────────────────────────────────────────

  describe('GET /claims-dashboard (selectedClaimId variant)', () => {
    const VARIANT_CITY_DIR = join(TEST_DIR, 'variant-city');
    const VARIANT_DASHBOARD = join(VARIANT_CITY_DIR, 'results', 'claims', 'index.html');

    // Remote dashboards may use selectedClaimId instead of currentClaimId
    const VARIANT_HTML = `<!DOCTYPE html>
<html>
<head><title>Claims</title></head>
<body>
<script>
let selectedClaimId = null;
const claimGraph = {};
</script>
</body>
</html>`;

    let variantApi: HttpApi;

    beforeEach(() => {
      const dashDir = join(VARIANT_CITY_DIR, 'results', 'claims');
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(VARIANT_DASHBOARD, VARIANT_HTML, 'utf-8');

      variantApi = new HttpApi(
        makeCityLookup('variant-city', VARIANT_CITY_DIR, 'VariantCity') as any,
        stubOriginLookup as any, stubPersistenceLookup as any,
      );
    });

    it('promotes selectedClaimId from let to var', async () => {
      const res = await httpRequest(variantApi, 'GET', '/claims-dashboard?cityId=variant-city');

      expect(res.status).toBe(200);
      expect(res.data).toContain('var selectedClaimId');
      expect(res.data).not.toContain('let selectedClaimId');
    });
  });

  // ────────────────────────────────────────────────────────────
  // shellEscape — imported from KittyIntegration
  // ────────────────────────────────────────────────────────────

  describe('shellEscape', () => {
    it('wraps in single quotes and escapes embedded single quotes', () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it('wraps clean strings in single quotes', () => {
      expect(shellEscape('/home/user/results/claims/index.html')).toBe("'/home/user/results/claims/index.html'");
    });

    it('escapes multiple single quotes', () => {
      expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
    });

    it('handles strings with double quotes (safe inside single quotes)', () => {
      expect(shellEscape('say "hello"')).toBe("'say \"hello\"'");
    });

    it('handles backticks (safe inside single quotes)', () => {
      expect(shellEscape('`whoami`')).toBe("'`whoami`'");
    });

    it('handles dollar substitution (safe inside single quotes)', () => {
      expect(shellEscape('$(id)')).toBe("'$(id)'");
    });

    it('handles path with spaces', () => {
      expect(shellEscape('/home/user/my project/file.txt')).toBe("'/home/user/my project/file.txt'");
    });

    it('escapes single quotes in paths with dangerous chars', () => {
      // Inside single quotes, only ' needs escaping.
      // Double quotes, backticks, $ are all literal inside single quotes.
      expect(shellEscape("path'with\"dangerous`chars$(id)")).toBe("'path'\\''with\"dangerous`chars$(id)'");
    });
  });

  // ────────────────────────────────────────────────────────────
  // formatClaimsAnnotationsForClaude — send-to-worker format
  // ────────────────────────────────────────────────────────────

  describe('formatClaimsAnnotationsForClaude for send-to-worker', () => {
    it('produces the expected worker paste format', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'Seems low — recheck with different bin edges',
          claimId: 'c1',
          claimTitle: 'B-modes consistent with zero',
          selectedText: 'PTE 0.29',
        }),
        makeClaimAnnotation({
          id: '2',
          comment: 'Check edge effects on velocity profile',
          claimId: 'c2',
          claimTitle: 'Galaxy generation pipeline',
          artifact: 'galaxy_fields.png',
          x: 45,
          y: 32,
        }),
      ];

      const output = formatClaims('pure-eb', annotations);

      // Verify structure matches spec: "# Claims review: {cityName}"
      expect(output).toMatch(/^[\n]*# Claims review: pure-eb/);
      // "I've reviewed..." introduction
      expect(output).toContain("I've reviewed the claims dashboard and have 2 pieces of feedback:");
      // Claim headings with numbering
      expect(output).toContain('## 1. [B-modes consistent with zero]');
      expect(output).toContain('## 2. [Galaxy generation pipeline]');
      // Text annotation format
      expect(output).toContain('> On text: "PTE 0.29"');
      expect(output).toContain('> Seems low — recheck with different bin edges');
      // Image annotation format with position
      expect(output).toContain('> On plot: galaxy_fields.png (at 45%, 32%)');
      expect(output).toContain('> Check edge effects on velocity profile');
      // Ends with separator
      expect(output).toMatch(/---\s*$/);
    });

    it('produces readable output with global comment', () => {
      const annotations = [
        makeClaimAnnotation({
          comment: 'Minor issue',
          claimTitle: 'Test claim',
        }),
      ];

      const output = formatClaims('KineLens', annotations, 'Overall the analysis is solid, just a few notes.');

      expect(output).toContain('# Claims review: KineLens');
      expect(output).toContain('Overall the analysis is solid, just a few notes.');
      expect(output).toContain('## 1. [Test claim]');
      expect(output).toContain('> Minor issue');
    });
  });
});
