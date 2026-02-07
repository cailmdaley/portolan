/**
 * HttpApi claims annotation tests
 *
 * Tests the claims-specific behavior in HttpApi:
 * - GET /annotations?claimId= returns claim annotations
 * - POST /annotations creates claims annotations with validation
 * - formatClaimsAnnotationsForClaude output format
 * - Proxy injection of claims-annotate.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { AnnotationPersistence, Annotation } from '../AnnotationPersistence.js';
import { HttpApi } from '../HttpApi.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
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
      expect(res.data.error).toMatch(/path or claimId/i);
    });
  });

  // ────────────────────────────────────────────────────────────
  // formatClaimsAnnotationsForClaude
  // ────────────────────────────────────────────────────────────

  describe('formatClaimsAnnotationsForClaude', () => {
    // Access private method for direct testing
    function formatClaims(cityName: string, annotations: Annotation[], globalComment?: string): string {
      return (api as any).formatClaimsAnnotationsForClaude(cityName, annotations, globalComment);
    }

    it('formats text annotations', () => {
      const annotations: Annotation[] = [
        {
          id: '1',
          originId: 'local',
          comment: 'Seems low — recheck with different bin edges',
          createdAt: Date.now(),
          isClaimAnnotation: true,
          claimId: 'claim-1',
          claimTitle: 'B-modes consistent with zero',
          selectedText: 'PTE 0.29',
        },
      ];

      const output = formatClaims('pure-eb', annotations);

      expect(output).toContain('# Claims review: pure-eb');
      expect(output).toContain('## 1. [B-modes consistent with zero]');
      expect(output).toContain('> On text: "PTE 0.29"');
      expect(output).toContain('> Seems low — recheck with different bin edges');
      expect(output).toContain('---');
    });

    it('formats image/artifact annotations with position', () => {
      const annotations: Annotation[] = [
        {
          id: '1',
          originId: 'local',
          comment: 'Check edge effects on velocity',
          createdAt: Date.now(),
          isClaimAnnotation: true,
          claimId: 'claim-2',
          claimTitle: 'Galaxy generation pipeline',
          artifact: 'galaxy_fields.png',
          x: 45,
          y: 32,
        },
      ];

      const output = formatClaims('pure-eb', annotations);

      expect(output).toContain('## 1. [Galaxy generation pipeline]');
      expect(output).toContain('> On plot: galaxy_fields.png (at 45%, 32%)');
      expect(output).toContain('> Check edge effects on velocity');
    });

    it('formats multiple annotations with numbering', () => {
      const annotations: Annotation[] = [
        {
          id: '1', originId: 'local', comment: 'First',
          createdAt: Date.now(), isClaimAnnotation: true,
          claimId: 'c1', claimTitle: 'Claim A', selectedText: 'text A',
        },
        {
          id: '2', originId: 'local', comment: 'Second',
          createdAt: Date.now(), isClaimAnnotation: true,
          claimId: 'c2', claimTitle: 'Claim B', artifact: 'plot.png', x: 10, y: 20,
        },
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
      const annotations: Annotation[] = [
        {
          id: '1', originId: 'local', comment: 'Just one',
          createdAt: Date.now(), isClaimAnnotation: true,
          claimId: 'c1', claimTitle: 'Single',
        },
      ];

      const output = formatClaims('test', annotations);
      expect(output).toContain('1 piece of feedback');
    });

    it('truncates long selected text', () => {
      const annotations: Annotation[] = [
        {
          id: '1', originId: 'local',
          comment: 'Too long',
          createdAt: Date.now(), isClaimAnnotation: true,
          claimId: 'c1', claimTitle: 'Long Text',
          selectedText: 'A'.repeat(100),
        },
      ];

      const output = formatClaims('test', annotations);
      // selectedText is sliced to 60 chars
      expect(output).toContain('"' + 'A'.repeat(60) + '"');
      expect(output).not.toContain('A'.repeat(100));
    });

    it('falls back to claimId when claimTitle missing', () => {
      const annotations: Annotation[] = [
        {
          id: '1', originId: 'local', comment: 'No title',
          createdAt: Date.now(), isClaimAnnotation: true,
          claimId: 'claim-xyz',
        },
      ];

      const output = formatClaims('test', annotations);
      expect(output).toContain('[claim-xyz]');
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
      expect(res.data).toContain('window === window.top');
    });
  });
});
