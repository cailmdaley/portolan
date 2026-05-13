/**
 * HttpApi tapestry endpoint tests
 *
 * Tests the /tapestry endpoint that returns the full DAG (consumed by the static export):
 * - Fibers with tapestry: tags, edges, evidence, staleness
 * - /tapestry-asset/* artifact serving
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpApi } from '../HttpApi.js';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { mapFeltJsonToFiber } from '../FiberReader.js';
import {
  readEvidence,
  readEvidenceBatch,
  getSpecName,
  computeStaleness,
} from '../EvidenceReader.js';
import {
  httpRequest,
  makeCityLookup,
  makeMultiCityLookup,
  writeFiber,
  stubOriginLookup,
  stubPersistenceLookup,
} from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-tapestry');

function writeEvidence(claimsDir: string, specName: string, evidence: object) {
  const dir = join(claimsDir, specName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence), 'utf-8');
}

function writeArtifact(claimsDir: string, specName: string, filename: string, content: Buffer | string = 'PNG') {
  const dir = join(claimsDir, specName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('HttpApi — /tapestry endpoint', () => {
  const CITY_DIR = join(TEST_DIR, 'test-city');
  const FELT_DIR = join(CITY_DIR, '.felt');
  const CLAIMS_DIR = join(CITY_DIR, 'results', 'tapestry');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(FELT_DIR, { recursive: true });
    mkdirSync(CLAIMS_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('test', CITY_DIR) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Basic request validation ─────────────────────────────────

  it('returns 400 without cityId', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/cityId/i);
  });

  it('returns 404 for unknown city', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry?cityId=nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns empty DAG when no fibers have tapestry: tags', async () => {
    writeFiber(FELT_DIR, 'plain-task-abc123', `---
name: A plain task
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---

Just a task, no rule tag.`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');
    expect(res.status).toBe(200);
    expect(res.data.nodes).toHaveLength(0);
    expect(res.data.links).toHaveLength(0);
  });

  it('uses remote city config reader before SSH for /tapestry config', async () => {
    const cityDir = join(TEST_DIR, 'remote-config-city');
    const cityLookup = makeMultiCityLookup([{
      id: 'remote-config-city',
      name: 'RemoteConfigCity',
      path: cityDir,
      originId: 'remote-candide',
    }]);

    const remoteCalls: Array<{ originId: string; path: string }> = [];
    const city = cityLookup.getCityById('remote-config-city') as any;
    const remoteApi = new HttpApi(
      cityLookup as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
      {
        remoteCityConfigReader: async ({ originId, path }) => {
          remoteCalls.push({ originId, path });
          if (path.endsWith('workflow/config/config.yaml')) {
            return 'owner: candide\nmode: remote\n';
          }
          throw new Error('not this file');
        },
      },
    );

    const config = await (remoteApi as any).tapestryApi.readCityConfig(city, 'candide');
    expect(remoteCalls).toEqual([
      { originId: 'remote-candide', path: `${cityDir}/config/config.yaml` },
      { originId: 'remote-candide', path: `${cityDir}/workflow/config/config.yaml` },
    ]);
    expect(config).toEqual({ owner: 'candide', mode: 'remote' });
  });

  // ── Fibers with tapestry: tags ───────────────────────────────────

  it('returns fibers with tapestry: tags as nodes', async () => {
    writeFiber(FELT_DIR, 'foundation-abc123', `---
name: Foundation data
status: closed
kind: foundation
tags:
    - tapestry:foundation_data
priority: 2
created-at: 2026-01-01T00:00:00Z
closed-at: 2026-01-02T00:00:00Z
outcome: Data loaded successfully
---

This is the foundation data fiber body.`);

    writeFiber(FELT_DIR, 'claim-def456', `---
name: Cosebis data vector
status: open
kind: claim
tags:
    - tapestry:cosebis_data_vector
priority: 2
depends-on:
    - foundation-abc123
created-at: 2026-01-03T00:00:00Z
---

Testing the cosebis claim.`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.status).toBe(200);
    expect(res.data.nodes).toHaveLength(2);

    const foundation = res.data.nodes.find((n: any) => n.id === 'foundation-abc123');
    expect(foundation).toBeDefined();
    expect(foundation.name).toBe('Foundation data');
    expect(foundation.kind).toBe('foundation');
    expect(foundation.status).toBe('closed');
    expect(foundation.specName).toBe('foundation_data');
    expect(foundation.body).toContain('foundation data fiber body');

    const claim = res.data.nodes.find((n: any) => n.id === 'claim-def456');
    expect(claim).toBeDefined();
    expect(claim.name).toBe('Cosebis data vector');
    expect(claim.dependsOn).toEqual(['foundation-abc123']);
    expect(claim.specName).toBe('cosebis_data_vector');
  });

  // ── Links ────────────────────────────────────────────────────

  it('builds dependency links between rule fibers', async () => {
    writeFiber(FELT_DIR, 'f1-abc123', `---
name: Foundation
status: closed
kind: foundation
tags:
    - tapestry:f1
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'c1-def456', `---
name: Claim 1
status: open
kind: claim
tags:
    - tapestry:c1
depends-on:
    - f1-abc123
priority: 2
created-at: 2026-01-02T00:00:00Z
---`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.data.links).toHaveLength(1);
    expect(res.data.links[0]).toEqual({
      source: 'f1-abc123',
      target: 'c1-def456',
    });
  });

  it('filters out depends-on references to non-rule fibers', async () => {
    writeFiber(FELT_DIR, 'non-rule-abc123', `---
name: Non-rule fiber
status: open
kind: task
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'rule-fiber-def456', `---
name: Rule fiber
status: open
kind: claim
tags:
    - tapestry:my_claim
depends-on:
    - non-rule-abc123
priority: 2
created-at: 2026-01-02T00:00:00Z
---`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.data.nodes).toHaveLength(1);
    expect(res.data.nodes[0].dependsOn).toEqual([]);
    expect(res.data.links).toHaveLength(0);
  });

  // ── Evidence ─────────────────────────────────────────────────

  it('includes evidence metrics and artifacts', async () => {
    writeFiber(FELT_DIR, 'claim-abc123', `---
name: Test claim
status: closed
kind: claim
tags:
    - tapestry:test_claim
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeEvidence(CLAIMS_DIR, 'test_claim', {
      evidence: { pte: 0.22, chi2: 18.5, dof: 20 },
      output: { figure: 'figure.png' },
      generated: '2026-01-15T12:00:00Z',
    });

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.status).toBe(200);
    const node = res.data.nodes[0];
    expect(node.evidence).toBeDefined();
    expect(node.evidence.metrics).toEqual({ pte: 0.22, chi2: 18.5, dof: 20 });
    expect(node.evidence.artifacts.figure).toBe('figure.png');
    expect(node.evidence.generated).toBe('2026-01-15T12:00:00Z');
    expect(node.evidence.mtime).toBeGreaterThan(0);
  });

  it('returns null evidence when no evidence.json exists', async () => {
    writeFiber(FELT_DIR, 'no-evidence-abc123', `---
name: No evidence
status: open
kind: claim
tags:
    - tapestry:no_evidence
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.data.nodes[0].evidence).toBeNull();
    expect(res.data.nodes[0].staleness).toBe('no-evidence');
  });

  // ── Staleness ────────────────────────────────────────────────

  it('marks fiber as fresh when evidence is newer than dependencies', async () => {
    writeFiber(FELT_DIR, 'upstream-abc123', `---
name: Upstream
status: closed
kind: foundation
tags:
    - tapestry:upstream
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'downstream-def456', `---
name: Downstream
status: open
kind: claim
tags:
    - tapestry:downstream
depends-on:
    - upstream-abc123
priority: 2
created-at: 2026-01-02T00:00:00Z
---`);

    writeEvidence(CLAIMS_DIR, 'upstream', {
      evidence: { x: 1 },
      generated: '2026-01-10T00:00:00Z',
    });
    writeEvidence(CLAIMS_DIR, 'downstream', {
      evidence: { y: 2 },
      generated: '2026-01-15T00:00:00Z',
    });

    // Force deterministic mtimes: upstream older, downstream newer
    const oldTime = new Date('2026-01-10T00:00:00Z');
    const newTime = new Date('2026-01-15T00:00:00Z');
    utimesSync(join(CLAIMS_DIR, 'upstream', 'evidence.json'), oldTime, oldTime);
    utimesSync(join(CLAIMS_DIR, 'downstream', 'evidence.json'), newTime, newTime);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    const downstream = res.data.nodes.find((n: any) => n.id === 'downstream-def456');
    expect(downstream.staleness).toBe('fresh');
  });

  it('marks fiber as stale when dependency evidence is newer', async () => {
    writeFiber(FELT_DIR, 'upstream-abc123', `---
name: Upstream
status: closed
kind: foundation
tags:
    - tapestry:upstream
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'downstream-def456', `---
name: Downstream
status: open
kind: claim
tags:
    - tapestry:downstream
depends-on:
    - upstream-abc123
priority: 2
created-at: 2026-01-02T00:00:00Z
---`);

    writeEvidence(CLAIMS_DIR, 'downstream', {
      evidence: { y: 2 },
      generated: '2026-01-10T00:00:00Z',
    });
    writeEvidence(CLAIMS_DIR, 'upstream', {
      evidence: { x: 1 },
      generated: '2026-01-15T00:00:00Z',
    });

    // Force deterministic mtimes: downstream older, upstream newer (stale)
    const oldTime = new Date('2026-01-10T00:00:00Z');
    const newTime = new Date('2026-01-15T00:00:00Z');
    utimesSync(join(CLAIMS_DIR, 'downstream', 'evidence.json'), oldTime, oldTime);
    utimesSync(join(CLAIMS_DIR, 'upstream', 'evidence.json'), newTime, newTime);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    const downstream = res.data.nodes.find((n: any) => n.id === 'downstream-def456');
    expect(downstream.staleness).toBe('stale');
  });

  // ── Downstream concerns ──────────────────────────────────────

  it('downstream only includes other DAG nodes, not non-rule fibers', async () => {
    writeFiber(FELT_DIR, 'rule-abc123', `---
name: Rule fiber
status: open
kind: claim
tags:
    - tapestry:my_claim
priority: 2
created-at: 2026-01-01T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'rule-def456', `---
name: Another rule
status: open
kind: claim
tags:
    - tapestry:my_other_claim
depends-on:
    - rule-abc123
priority: 2
created-at: 2026-01-02T00:00:00Z
---`);

    writeFiber(FELT_DIR, 'task-ghi789', `---
name: Non-rule task
status: open
kind: task
depends-on:
    - rule-abc123
priority: 2
created-at: 2026-01-03T00:00:00Z
---`);

    const res = await httpRequest(api, 'GET', '/tapestry?cityId=test');

    expect(res.data.downstream).toBeDefined();
    const concerns = res.data.downstream['rule-abc123'];
    expect(concerns).toHaveLength(1);
    expect(concerns[0].name).toBe('Another rule');
  });
});

// ── /tapestry-asset tests ─────────────────────────────────────────

describe('HttpApi — /tapestry-asset endpoint', () => {
  const CITY_DIR = join(TEST_DIR, 'asset-city');
  const CLAIMS_DIR = join(CITY_DIR, 'results', 'tapestry');
  let api: HttpApi;

  beforeEach(() => {
    mkdirSync(CLAIMS_DIR, { recursive: true });
    api = new HttpApi(
      makeCityLookup('asset-test', CITY_DIR) as any,
      stubOriginLookup as any,
      stubPersistenceLookup as any,
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('serves a PNG artifact', async () => {
    const pngData = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic bytes
    writeArtifact(CLAIMS_DIR, 'test_claim', 'figure.png', pngData);

    const res = await httpRequest(api, 'GET', '/tapestry-asset/test_claim/figure.png?cityId=asset-test');

    expect(res.status).toBe(200);
  });

  it('returns 404 for missing artifact', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry-asset/nonexistent/plot.png?cityId=asset-test');
    expect(res.status).toBe(404);
  });

  it('rejects directory traversal', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry-asset/..%2F..%2Fetc/passwd?cityId=asset-test');
    expect(res.status).toBe(400);
  });

  it('rejects shell injection', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry-asset/$(id)/plot.png?cityId=asset-test');
    expect(res.status).toBe(400);
  });

  it('returns 400 without cityId', async () => {
    const res = await httpRequest(api, 'GET', '/tapestry-asset/spec/plot.png');
    expect(res.status).toBe(400);
  });
});

// ── FiberReader felt-JSON mapping tests ──────────────────────────

describe('FiberReader — mapFeltJsonToFiber', () => {
  it('maps tags and depends_on from felt JSON', () => {
    const fiber = mapFeltJsonToFiber({
      id: 'test-abc123',
      name: 'Test fiber',
      status: 'open',
      kind: 'claim',
      tags: ['tapestry:cosebis', 'ralph:1'],
      depends_on: ['upstream-abc123', 'foundation-def456'],
      priority: 2,
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(fiber?.tags).toEqual(['tapestry:cosebis', 'ralph:1']);
    expect(fiber?.dependsOn).toEqual(['upstream-abc123', 'foundation-def456']);
  });

  it('returns undefined for missing tags/dependsOn', () => {
    const fiber = mapFeltJsonToFiber({
      id: 'plain-abc123',
      name: 'Plain fiber',
      status: 'open',
      kind: 'task',
      priority: 2,
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(fiber?.tags).toBeUndefined();
    expect(fiber?.dependsOn).toBeUndefined();
  });

  it('maps created_at, closed_at, outcome, and body', () => {
    const fiber = mapFeltJsonToFiber({
      id: 'complete-abc123',
      name: 'Complete fiber',
      status: 'closed',
      kind: 'claim',
      priority: 2,
      created_at: '2026-01-01T00:00:00Z',
      closed_at: '2026-01-15T12:00:00Z',
      outcome: 'Analysis complete',
      body: '## Method\n\nUse weak lensing cross-correlation.',
    });

    expect(fiber?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(fiber?.closedAt).toBe('2026-01-15T12:00:00Z');
    expect(fiber?.outcome).toBe('Analysis complete');
    expect(fiber?.body).toContain('weak lensing');
  });

  it('maps shuttle block state from felt JSON', () => {
    const fiber = mapFeltJsonToFiber({
      id: 'standing-role',
      name: 'Standing role',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      shuttle: {
        enabled: true,
        kind: 'standing',
        agent: 'claude-sonnet',
        review: { state: 'awaiting' },
        session: { id: 'sess-123' },
        schedule: { expr: '0 9 * * 1-5', tz: 'Europe/Paris' },
      },
    });

    expect(fiber?.hasShuttleBlock).toBe(true);
    expect(fiber?.shuttleEnabled).toBe(true);
    expect(fiber?.shuttleKind).toBe('standing');
    expect(fiber?.shuttleReviewState).toBe('awaiting');
    expect(fiber?.shuttleSessionId).toBe('sess-123');
    expect(fiber?.shuttleAgent).toBe('claude-sonnet');
    expect(fiber?.shuttleSchedule).toEqual({ expr: '0 9 * * 1-5', tz: 'Europe/Paris' });
  });
});

// ── EvidenceReader unit tests ────────────────────────────────────

describe('EvidenceReader', () => {
  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('getSpecName', () => {
    it('extracts spec name from tapestry: tag', () => {
      expect(getSpecName(['tapestry:cosebis_data_vector', 'ralph:1'])).toBe('cosebis_data_vector');
    });

    it('returns undefined when no tapestry: tag', () => {
      expect(getSpecName(['ralph:1', 'other'])).toBeUndefined();
    });

    it('returns first tapestry: tag', () => {
      expect(getSpecName(['tapestry:first', 'tapestry:second'])).toBe('first');
    });
  });

  describe('readEvidenceBatch', () => {
    const CITY = join(TEST_DIR, 'evidence-batch-city');

    it('reads evidence via remote batch callback first', async () => {
      const seen: string[][] = [];
      const results = await readEvidenceBatch(
        CITY,
        ['spec_one', 'spec_missing'],
        'remote-candide',
        {
          remoteEvidenceBatchReader: async (request) => {
            seen.push(request.specNames);
            return {
              spec_one: {
                evidenceJson: JSON.stringify({
                  evidence: { pte: 0.12 },
                  output: { figure: 'figure.png' },
                }),
                mtimeMs: 1234567890,
              },
              spec_missing: null,
            };
          },
        },
      );

      expect(seen).toEqual([['spec_one', 'spec_missing']]);
      expect(results.get('spec_one')).toMatchObject({
        specName: 'spec_one',
        metrics: { pte: 0.12 },
        artifacts: { figure: 'figure.png' },
        mtime: 1234567890,
      });
      expect(results.get('spec_missing')).toBeNull();
    });
  });

  describe('readEvidence', () => {
    const CITY = join(TEST_DIR, 'evidence-city');

    it('reads evidence.json with metrics and artifacts', async () => {
      const dir = join(CITY, 'results', 'tapestry', 'test_spec');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({
        evidence: { pte: 0.3, chi2: 12 },
        output: { main_plot: 'main_plot.png' },
        generated: '2026-01-10T00:00:00Z',
      }));

      const ev = await readEvidence(CITY, 'test_spec');

      expect(ev).not.toBeNull();
      expect(ev!.specName).toBe('test_spec');
      expect(ev!.metrics).toEqual({ pte: 0.3, chi2: 12 });
      expect(ev!.artifacts.main_plot).toBe('main_plot.png');
      expect(ev!.mtime).toBeGreaterThan(0);
      expect(ev!.generated).toBe('2026-01-10T00:00:00Z');
    });

    it('only includes image files from output field', async () => {
      const dir = join(CITY, 'results', 'tapestry', 'with_images');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({
        evidence: {},
        output: { plot: 'plot.png', data: 'data.csv', evidence: 'evidence.json' },
      }));
      // Extra file in directory should NOT be picked up
      writeFileSync(join(dir, 'extra_plot.png'), 'PNG data');

      const ev = await readEvidence(CITY, 'with_images');

      expect(ev).not.toBeNull();
      expect(ev!.artifacts.plot).toBe('plot.png');
      expect(ev!.artifacts.data).toBeUndefined(); // non-image output excluded
      expect(ev!.artifacts.extra_plot).toBeUndefined(); // directory file excluded
    });

    it('returns null when evidence.json does not exist', async () => {
      mkdirSync(join(CITY, 'results', 'tapestry', 'empty'), { recursive: true });
      const ev = await readEvidence(CITY, 'empty');
      expect(ev).toBeNull();
    });

    it('returns null for nonexistent spec directory', async () => {
      mkdirSync(CITY, { recursive: true });
      const ev = await readEvidence(CITY, 'nonexistent');
      expect(ev).toBeNull();
    });

    it('returns empty artifacts when no output field exists', async () => {
      const dir = join(CITY, 'results', 'tapestry', 'legacy_spec');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({
        evidence: { pte: 0.5 },
      }));

      const ev = await readEvidence(CITY, 'legacy_spec');

      expect(ev).not.toBeNull();
      expect(Object.keys(ev!.artifacts)).toHaveLength(0);
      expect(ev!.metrics.pte).toBe(0.5);
    });
  });

  describe('computeStaleness', () => {
    it('returns fresh when downstream is newer', () => {
      const evidenceMap = new Map([
        ['upstream', { specName: 'upstream', metrics: {}, artifacts: {}, mtime: 1000 }],
        ['downstream', { specName: 'downstream', metrics: {}, artifacts: {}, mtime: 2000 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'upstream'],
        ['f2', 'downstream'],
      ]);
      const depsMap = new Map([['f2', ['f1']]]);

      expect(computeStaleness('f2', depsMap, evidenceMap as any, fiberSpecMap)).toBe('fresh');
    });

    it('returns stale when upstream is newer', () => {
      const evidenceMap = new Map([
        ['upstream', { specName: 'upstream', metrics: {}, artifacts: {}, mtime: 2000 }],
        ['downstream', { specName: 'downstream', metrics: {}, artifacts: {}, mtime: 1000 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'upstream'],
        ['f2', 'downstream'],
      ]);
      const depsMap = new Map([['f2', ['f1']]]);

      expect(computeStaleness('f2', depsMap, evidenceMap as any, fiberSpecMap)).toBe('stale');
    });

    it('returns no-evidence when fiber has no evidence', () => {
      const evidenceMap = new Map([
        ['upstream', { specName: 'upstream', metrics: {}, artifacts: {}, mtime: 1000 }],
      ]);
      const fiberSpecMap = new Map([['f1', 'upstream']]);
      const depsMap = new Map([['f2', ['f1']]]);

      expect(computeStaleness('f2', depsMap, evidenceMap as any, fiberSpecMap)).toBe('no-evidence');
    });

    it('returns fresh when no dependencies have evidence', () => {
      const evidenceMap = new Map([
        ['downstream', { specName: 'downstream', metrics: {}, artifacts: {}, mtime: 1000 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'upstream'],
        ['f2', 'downstream'],
      ]);
      const depsMap = new Map([['f2', ['f1']]]);

      expect(computeStaleness('f2', depsMap, evidenceMap as any, fiberSpecMap)).toBe('fresh');
    });

    it('stale through no-evidence grouping node', () => {
      const evidenceMap = new Map([
        ['source', { specName: 'source', metrics: {}, artifacts: {}, mtime: 20 }],
        ['leaf', { specName: 'leaf', metrics: {}, artifacts: {}, mtime: 10 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'source'],
        ['f2', 'group'],
        ['f3', 'leaf'],
      ]);
      const depsMap = new Map([
        ['f2', ['f1']],
        ['f3', ['f2']],
      ]);

      expect(computeStaleness('f3', depsMap, evidenceMap as any, fiberSpecMap)).toBe('stale');
    });

    it('fresh through no-evidence grouping node when upstream is older', () => {
      const evidenceMap = new Map([
        ['source', { specName: 'source', metrics: {}, artifacts: {}, mtime: 10 }],
        ['leaf', { specName: 'leaf', metrics: {}, artifacts: {}, mtime: 20 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'source'],
        ['f2', 'group'],
        ['f3', 'leaf'],
      ]);
      const depsMap = new Map([
        ['f2', ['f1']],
        ['f3', ['f2']],
      ]);

      expect(computeStaleness('f3', depsMap, evidenceMap as any, fiberSpecMap)).toBe('fresh');
    });

    it('stale through multiple no-evidence grouping nodes', () => {
      const evidenceMap = new Map([
        ['source', { specName: 'source', metrics: {}, artifacts: {}, mtime: 30 }],
        ['leaf', { specName: 'leaf', metrics: {}, artifacts: {}, mtime: 10 }],
      ]);
      const fiberSpecMap = new Map([
        ['f1', 'source'],
        ['f2', 'groupA'],
        ['f3', 'groupB'],
        ['f4', 'leaf'],
      ]);
      const depsMap = new Map([
        ['f2', ['f1']],
        ['f3', ['f2']],
        ['f4', ['f3']],
      ]);

      expect(computeStaleness('f4', depsMap, evidenceMap as any, fiberSpecMap)).toBe('stale');
    });
  });
});
