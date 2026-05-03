/**
 * HttpApiKanban tests — global kanban view of constitution-tagged fibers,
 * grouped into in-flight / awaiting-review / tempered columns.
 *
 * Tests against a synthetic felt host directory built per-case. The endpoint
 * defaults to ~/loom but accepts a feltHost override; we instantiate the
 * sub-API directly and call `handleKanban` with a fake URL/ServerResponse to
 * sidestep the HttpApi constructor's full graph (which expects a city
 * lookup we don't need here).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { HttpApiKanban, applyTargetToFrontmatter, mutateTagsInPlace } from '../HttpApiKanban.js';
import { FiberTreeSnapshotStore } from '../FiberTreeSnapshotStore.js';

const TEST_DIR = join(homedir(), '.portolan-test-kanban');
const FELT_DIR = join(TEST_DIR, '.felt');

interface CapturedResponse {
  status: number;
  body: any;
}

/**
 * Invoke `handleKanban` with a stub ServerResponse that captures status +
 * body. Returns the parsed JSON body.
 */
async function callKanban(api: HttpApiKanban): Promise<CapturedResponse> {
  let status = 0;
  const chunks: string[] = [];
  const stub = {
    writeHead(s: number) { status = s; },
    end(chunk?: string) { if (chunk) chunks.push(chunk); },
  } as unknown as ServerResponse;
  await api.handleKanban(new URL('http://localhost/kanban'), stub);
  const raw = chunks.join('');
  return { status, body: raw ? JSON.parse(raw) : null };
}

/**
 * Reconstruct a fiber's `.felt/`-relative path from its id + isRoot flag.
 * Mirrors the agent-side and HttpApiKanban's `relativeFeltPath` for use in
 * Stage 4 round-trip tests where the executor needs to know which file the
 * server told it to mutate.
 */
function relativeFeltPathFromId(id: string, isRoot: boolean): string {
  const segments = id.split('/');
  const basename = segments[segments.length - 1];
  return isRoot ? `${basename}.md` : `${id}/${basename}.md`;
}

/** Write a directory-based fiber under FELT_DIR. */
function writeFib(slugPath: string, frontmatter: Record<string, unknown>, body = ''): void {
  const segments = slugPath.split('/');
  const dir = join(FELT_DIR, ...segments);
  mkdirSync(dir, { recursive: true });
  const basename = segments[segments.length - 1];
  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}:`);
      for (const item of v) fmLines.push(`  - ${item}`);
    } else if (typeof v === 'string' && v.includes('\n')) {
      fmLines.push(`${k}: |`);
      for (const line of v.split('\n')) fmLines.push(`  ${line}`);
    } else if (typeof v === 'object' && v !== null) {
      // Up-to-two-level nested object: shuttle: { enabled, kind, review: { state } }
      fmLines.push(`${k}:`);
      for (const [subK, subV] of Object.entries(v as Record<string, unknown>)) {
        if (typeof subV === 'object' && subV !== null) {
          fmLines.push(`  ${subK}:`);
          for (const [k3, v3] of Object.entries(subV as Record<string, unknown>)) {
            fmLines.push(`    ${k3}: ${v3}`);
          }
        } else {
          fmLines.push(`  ${subK}: ${subV}`);
        }
      }
    } else {
      fmLines.push(`${k}: ${v}`);
    }
  }
  const content = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
  writeFileSync(join(dir, `${basename}.md`), content, 'utf-8');
}

/** A shuttle block that lands a fiber in inFlight (enabled = true). */
const SHUTTLE_INFLIGHT = { enabled: true, kind: 'oneshot' } as const;
/** A shuttle block that lands a fiber in drafts (enabled = false). */
const SHUTTLE_DRAFT = { enabled: false, kind: 'oneshot' } as const;
/** A standing-role shuttle block whose worker has finished a run and is awaiting human acceptance. */
const SHUTTLE_STANDING_AWAITING = {
  enabled: true,
  kind: 'standing',
  review: { state: 'awaiting' },
} as const;
/** A standing-role shuttle block scheduled for the next cron tick (no review pending). */
const SHUTTLE_STANDING_SCHEDULED = {
  enabled: true,
  kind: 'standing',
  review: { state: 'scheduled' },
} as const;

describe('HttpApiKanban — /kanban endpoint', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(FELT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty columns when no .felt directory exists', async () => {
    rmSync(FELT_DIR, { recursive: true, force: true });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual({ drafts: [], inFlight: [], awaitingReview: [], tempered: [], composted: [] });
    expect(res.body.totals).toEqual({ drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 });
  });

  it('skips fibers that have no shuttle: block', async () => {
    writeFib('regular-task', { name: 'Task', status: 'open', tags: ['task'], 'created-at': '2026-04-01' });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);
    expect(res.body.totals).toEqual({ drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 });
  });

  it('groups shuttle-block fibers into drafts / in-flight / awaiting-review / tempered', async () => {
    writeFib('draft-one', {
      name: 'Draft',
      status: 'open',
      shuttle: SHUTTLE_DRAFT,
      'created-at': '2026-04-09',
    });
    writeFib('open-one', {
      name: 'Open one',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-10',
    });
    writeFib('active-one', {
      name: 'Active one',
      status: 'active',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-11',
    });
    writeFib('awaiting', {
      name: 'Awaiting',
      status: 'closed',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
      'closed-at': '2026-04-12',
    });
    writeFib('tempered-one', {
      name: 'Tempered',
      status: 'closed',
      tempered: 'true',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-02',
      'closed-at': '2026-04-13',
    });

    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ drafts: 1, inFlight: 2, awaitingReview: 1, tempered: 1, composted: 0 });
    expect(res.body.columns.drafts.map((c: any) => c.id)).toEqual(['draft-one']);
    expect(res.body.columns.inFlight.map((c: any) => c.id)).toEqual(['active-one', 'open-one']);
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['awaiting']);
    expect(res.body.columns.tempered.map((c: any) => c.id)).toEqual(['tempered-one']);
  });

  it('routes a kind:standing fiber with review.state=awaiting to awaitingReview, even though status is active', async () => {
    // Standing roles keep status: active permanently (it means "installed").
    // Per-run review lifecycle is in shuttle.review.state. After a worker
    // finishes a run, review.state goes to "awaiting" and the role should
    // surface in the awaitingReview column for human acceptance — not stay
    // hidden in inFlight where it'd be indistinguishable from a scheduled run.
    writeFib('canary', {
      name: 'Canary (review pending)',
      status: 'active',
      shuttle: SHUTTLE_STANDING_AWAITING,
      'created-at': '2026-04-01',
    });
    writeFib('canary-scheduled', {
      name: 'Canary (next run pending)',
      status: 'active',
      shuttle: SHUTTLE_STANDING_SCHEDULED,
      'created-at': '2026-04-02',
    });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);

    expect(res.status).toBe(200);
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['canary']);
    expect(res.body.columns.inFlight.map((c: any) => c.id)).toEqual(['canary-scheduled']);
  });

  it('keeps a paused (enabled=false) closed fiber in awaiting/tempered, not drafts', async () => {
    // shuttle.enabled=false only routes to drafts for open fibers; closed fibers
    // route by status+tempered regardless of the shuttle block's enabled field.
    writeFib('closed-draft', {
      name: 'Closed draft',
      status: 'closed',
      shuttle: SHUTTLE_DRAFT,
      'created-at': '2026-04-01',
      'closed-at': '2026-04-02',
    });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);
    expect(res.body.columns.drafts).toHaveLength(0);
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['closed-draft']);
  });

  it('sorts in-flight by running-worker-first, then createdAt desc', async () => {
    writeFib('a', { name: 'A', status: 'open', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-01' });
    writeFib('b', { name: 'B', status: 'open', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-02' });
    writeFib('busy', { name: 'Busy', status: 'open', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-03' });
    writeFib('x', { name: 'X', status: 'closed', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-01', 'closed-at': '2026-04-04' });
    writeFib('y', { name: 'Y', status: 'closed', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-01', 'closed-at': '2026-04-05' });

    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => ['shuttle-a'] });
    const res = await callKanban(api);

    // 'a' has a running worker → active-first, then 'busy' (newer) and 'b' (older) by createdAt desc.
    expect(res.body.columns.inFlight.map((c: any) => c.id)).toEqual(['a', 'busy', 'b']);
    expect(res.body.columns.inFlight[0].runningWorker).toBe('shuttle-a');
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['y', 'x']);
  });

  it('marks in-flight cards with a running Shuttle worker', async () => {
    writeFib('busy', { name: 'Busy', status: 'open', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-01' });
    writeFib('idle', { name: 'Idle', status: 'open', shuttle: SHUTTLE_INFLIGHT, 'created-at': '2026-04-02' });

    const api = new HttpApiKanban({
      feltHost: TEST_DIR,
      listSessions: () => ['shuttle-busy'],
    });
    const res = await callKanban(api);

    const cards = res.body.columns.inFlight;
    expect(cards.map((c: any) => c.id)).toEqual(['busy', 'idle']); // running first
    expect(cards.find((c: any) => c.id === 'busy').runningWorker).toBe('shuttle-busy');
    expect(cards.find((c: any) => c.id === 'idle').runningWorker).toBeUndefined();
  });

  it('marks dependsOnSatisfied=false when a depends_on target is not tempered', async () => {
    writeFib('upstream', {
      name: 'Upstream',
      status: 'closed',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
      // not tempered
    });
    writeFib('downstream', {
      name: 'Downstream',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-02',
      'depends-on': ['upstream'],
    });

    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    const downstream = res.body.columns.inFlight.find((c: any) => c.id === 'downstream');
    expect(downstream).toBeTruthy();
    expect(downstream.dependsOnSatisfied).toBe(false);
    expect(downstream.dependsOn).toEqual(['upstream']);
  });

  it('marks dependsOnSatisfied=true when all depends_on targets are tempered', async () => {
    writeFib('upstream', {
      name: 'Upstream',
      status: 'closed',
      tempered: 'true',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
    });
    writeFib('downstream', {
      name: 'Downstream',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-02',
      'depends-on': ['upstream'],
    });

    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    const downstream = res.body.columns.inFlight.find((c: any) => c.id === 'downstream');
    expect(downstream.dependsOnSatisfied).toBe(true);
  });

  it('emits absolute path for nested fiber pointing at <feltHost>/.felt/<id>/<slug>.md', async () => {
    writeFib('parent/child', {
      name: 'Child',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
    });
    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    const child = res.body.columns.inFlight.find((c: any) => c.id === 'parent/child');
    expect(child).toBeTruthy();
    expect(child.path).toBe(join(TEST_DIR, '.felt', 'parent', 'child', 'child.md'));
  });

  it('resolves cityId + projectSlug for nested cards when the pinned city owns the .felt', async () => {
    writeFib('parent/child', {
      name: 'Child',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
    });
    // Pin TEST_DIR itself as a city — its `.felt` realpath is exactly
    // FELT_DIR, so every walk-discovered fiber falls under it. The
    // resolver should echo `cityId` and emit the same project-relative
    // slug as the card id.
    const api = new HttpApiKanban({
      feltHost: TEST_DIR,
      cities: [{ id: 'self', path: TEST_DIR }],
    });
    const res = await callKanban(api);
    const card = res.body.columns.inFlight.find((c: any) => c.id === 'parent/child');
    expect(card).toBeTruthy();
    expect(card.cityId).toBe('self');
    expect(card.projectSlug).toBe('parent/child');
  });

  it('resolves to the deeper-matching city when a fiber is reachable via a symlinked alias', async () => {
    // Mirror the real loom layout: portolan's `.felt/` is a *symlink into*
    // loom's tree, so the fiber physically lives at
    // `loom/.felt/ai-futures/portolan/<slug>` and `realpath(portolan/.felt)`
    // resolves to the same loom subdirectory. TEST_DIR is loom; create a
    // real `aliased/` subtree under loom's .felt with the fiber, then
    // build a sibling "project" directory whose `.felt/` is a symlink
    // pointing at that subtree.
    // Directory-shape fiber: `<slug-as-dir>/<basename>.md`.
    mkdirSync(join(FELT_DIR, 'aliased', 'real-fiber'), { recursive: true });
    writeFileSync(
      join(FELT_DIR, 'aliased', 'real-fiber', 'real-fiber.md'),
      '---\nname: Real\nstatus: open\nshuttle:\n  enabled: true\n  kind: oneshot\ncreated-at: 2026-04-01\n---\nbody\n',
      'utf-8',
    );
    // Project city: its `.felt/` is a symlink into loom's `.felt/aliased/`.
    const projDir = join(TEST_DIR, 'proj-a');
    mkdirSync(projDir, { recursive: true });
    const { symlinkSync } = require('fs') as typeof import('fs');
    symlinkSync(join(FELT_DIR, 'aliased'), join(projDir, '.felt'));
    // Loom is pinned first (matches the real ~/.portolan/cities.json
    // ordering), proj-a second; resolver still picks proj-a because its
    // `.felt` realpath is the deeper prefix match (deepest-first sort).
    const api = new HttpApiKanban({
      feltHost: TEST_DIR,
      cities: [
        { id: 'loom-city', path: TEST_DIR },
        { id: 'proj-a-city', path: projDir },
      ],
    });
    const res = await callKanban(api);
    // Loom's walk produces id="aliased/real-fiber" (loom-relative).
    const card = res.body.columns.inFlight.find((c: any) => c.id === 'aliased/real-fiber');
    expect(card).toBeTruthy();
    // The deeper-matching city wins, with the project-relative slug
    // stripped of the loom-side prefix.
    expect(card.cityId).toBe('proj-a-city');
    expect(card.projectSlug).toBe('real-fiber');
  });

  it('omits cityId/projectSlug when cards have no matching pinned city', async () => {
    writeFib('orphan-fiber', {
      name: 'Orphan',
      status: 'open',
      shuttle: SHUTTLE_INFLIGHT,
      'created-at': '2026-04-01',
    });
    // Pin a totally unrelated city — the fiber's canonical path won't fall
    // under it, so the resolver should leave both fields undefined rather
    // than mis-attributing.
    const api = new HttpApiKanban({
      feltHost: TEST_DIR,
      cities: [{ id: 'unrelated', path: '/tmp/some-other-city' }],
    });
    const res = await callKanban(api);
    const card = res.body.columns.inFlight.find((c: any) => c.id === 'orphan-fiber');
    expect(card).toBeTruthy();
    expect(card.cityId).toBeUndefined();
    expect(card.projectSlug).toBeUndefined();
  });

  // ── POST /kanban/transition ────────────────────────────────────────────────

  describe('handleTransition', () => {
    /** Stub a JSON-body request. */
    function jsonReq(body: unknown): IncomingMessage {
      const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
      return stream;
    }

    /** Capture writeHead + end on a stub ServerResponse. */
    function capRes(): { res: ServerResponse; status: () => number; body: () => any } {
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(s: number) { status = s; },
        end(c?: string) { if (c) chunks.push(c); },
      } as unknown as ServerResponse;
      return { res, status: () => status, body: () => (chunks.length ? JSON.parse(chunks.join('')) : null) };
    }

    it('moves an awaiting-review fiber to tempered', async () => {
      writeFib('story', {
        name: 'Story',
        status: 'closed',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'story', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(body().ok).toBe(true);
      expect(body().card.tempered).toBe(true);

      // Verify the file actually changed and closed-at was preserved.
      const after = readFileSync(join(FELT_DIR, 'story', 'story.md'), 'utf-8');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: true$/m);
      expect(after).toMatch(/^closed-at: 2026-04-15$/m);
    });

    it('moves a tempered fiber back to awaiting review (clears tempered)', async () => {
      writeFib('approved', {
        name: 'Approved',
        status: 'closed',
        tempered: 'true',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'approved', target: 'awaitingReview' }), res);

      expect(status()).toBe(200);
      expect(body().card.tempered).toBeUndefined();
      expect(body().card.status).toBe('closed');

      const after = readFileSync(join(FELT_DIR, 'approved', 'approved.md'), 'utf-8');
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('legacy `queued` target is treated as inFlight (status=active, clears tempered)', async () => {
      writeFib('legacy-queued', {
        name: 'Legacy queued',
        status: 'closed',
        tempered: 'true',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'legacy-queued', target: 'queued' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();
      expect(shuttleCalls).toEqual([{ verb: 'resume', id: 'legacy-queued' }]);
    });

    it('moves a fiber to drafts — calls shuttle-ctl pause, clears closed-at', async () => {
      writeFib('idea', {
        name: 'Idea',
        status: 'open',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'idea', target: 'drafts' }), res);

      expect(status()).toBe(200);
      // shuttle-ctl pause called with the fiber id
      expect(shuttleCalls).toEqual([{ verb: 'pause', id: 'idea' }]);
      // felt-level: status left as-is (open), no tag mutations
      const after = readFileSync(join(FELT_DIR, 'idea', 'idea.md'), 'utf-8');
      expect(after).toMatch(/^status: open$/m);
      expect(after).not.toMatch(/^  - draft$/m);
    });

    it('moves a draft to inFlight — calls shuttle-ctl resume, status=active', async () => {
      writeFib('promoted', {
        name: 'Promoted',
        status: 'open',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'promoted', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ verb: 'resume', id: 'promoted' }]);
      expect(body().card.status).toBe('active');
    });

    it('standing-role awaitingReview → inFlight calls shuttle-ctl accept (not resume)', async () => {
      // The kanban gesture for accepting a standing-role run is to drag the
      // card from awaitingReview back into inFlight. The right verb is
      // `accept` (advances review.state + computes next_due_at) — `resume`
      // would no-op because enabled is already true and status already active.
      writeFib('canary', {
        name: 'Canary',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ verb: 'accept', id: 'canary' }]);
      // Standing role's status was 'active' before; should remain 'active'.
      // applyTargetToFrontmatter is skipped on the accept path so the file
      // contents are untouched here (accept itself wrote review/schedule via
      // shuttle-ctl, which the test seam stubs out — so the on-disk file
      // is left as-is for this assertion).
      const after = readFileSync(join(FELT_DIR, 'canary', 'canary.md'), 'utf-8');
      expect(after).toMatch(/^status: active$/m);
    });

    it('oneshot draft → inFlight still calls resume (the standing-accept path is kind-gated)', async () => {
      // Regression check: the standing-accept branch must not steal the
      // resume path for plain oneshot drafts.
      writeFib('oneshot-draft', {
        name: 'Oneshot draft',
        status: 'open',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'oneshot-draft', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ verb: 'resume', id: 'oneshot-draft' }]);
    });

    it('standing-role awaitingReview → tempered also calls accept (NOT close/tempered=true)', async () => {
      // For standing roles, "tempered" of an awaiting run is equivalent to
      // accepting it — the human is approving this run, but the role itself
      // continues. The oneshot tempered path (status=closed, tempered=true)
      // would terminate the role, which is wrong. Only `composted` should
      // terminate a standing role from the kanban.
      writeFib('canary-tempered', {
        name: 'Canary tempered',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary-tempered', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ verb: 'accept', id: 'canary-tempered' }]);
      // applyTargetToFrontmatter is skipped — file should be unchanged on disk
      // for the felt-level fields (the test seam stubs out the actual accept
      // shuttle-ctl call so review.state is not mutated here either, but the
      // important assertion is that status: closed / tempered: true are NOT
      // written).
      const after = readFileSync(join(FELT_DIR, 'canary-tempered', 'canary-tempered.md'), 'utf-8');
      expect(after).toMatch(/^status: active$/m);
      expect(after).not.toMatch(/^status: closed$/m);
      expect(after).not.toMatch(/^tempered: true$/m);
    });

    it('standing-role awaitingReview → composted DOES terminate the role (status=closed, tempered=false)', async () => {
      // composted is "I'm done with this recurring thing, retire it." For
      // standing roles that means falling through to the oneshot terminate
      // path: status=closed makes the daemon stop dispatching forever.
      writeFib('canary-retired', {
        name: 'Canary retired',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const fixedNow = new Date('2026-05-03T16:00:00Z');
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        now: () => fixedNow,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary-retired', target: 'composted' }), res);

      expect(status()).toBe(200);
      // No shuttle-ctl call — composted falls through to felt-only mutation.
      expect(shuttleCalls).toEqual([]);
      const after = readFileSync(join(FELT_DIR, 'canary-retired', 'canary-retired.md'), 'utf-8');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: false$/m);
      expect(after).toMatch(/^closed-at: 2026-05-03T16:00:00\.000Z$/m);
    });

    it('oneshot awaitingReview → tempered still does the oneshot dance (status=closed, tempered=true)', async () => {
      // Regression check: the standing-accept tempered branch must not steal
      // the path for plain oneshot acceptance.
      writeFib('oneshot-accept', {
        name: 'Oneshot accept',
        status: 'closed',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const shuttleCalls: Array<{ verb: string; id: string }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async (verb, id) => { shuttleCalls.push({ verb, id }); },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'oneshot-accept', target: 'tempered' }), res);

      expect(status()).toBe(200);
      // No shuttle-ctl call for oneshot tempered — felt-only mutation.
      expect(shuttleCalls).toEqual([]);
      const after = readFileSync(join(FELT_DIR, 'oneshot-accept', 'oneshot-accept.md'), 'utf-8');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: true$/m);
    });

    it('reopens a closed fiber to in flight, clearing closed-at and tempered', async () => {
      writeFib('reactivate', {
        name: 'Reactivate',
        status: 'closed',
        tempered: 'true',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async () => {},
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'reactivate', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();

      const after = readFileSync(join(FELT_DIR, 'reactivate', 'reactivate.md'), 'utf-8');
      expect(after).toMatch(/^status: active$/m);
      expect(after).not.toMatch(/^closed-at:/m);
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('sets closed-at to now when transitioning in-flight → tempered', async () => {
      writeFib('skip-review', {
        name: 'Skip review',
        status: 'open',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const fixedNow = new Date('2026-04-28T12:00:00Z');
      const api = new HttpApiKanban({ feltHost: TEST_DIR, now: () => fixedNow });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'skip-review', target: 'tempered' }), res);

      expect(status()).toBe(200);
      const after = readFileSync(join(FELT_DIR, 'skip-review', 'skip-review.md'), 'utf-8');
      expect(after).toMatch(/^closed-at: 2026-04-28T12:00:00\.000Z$/m);
      expect(after).toMatch(/^tempered: true$/m);
    });

    it('refuses to mutate fibers that have no shuttle: block', async () => {
      writeFib('plain-task', {
        name: 'Plain',
        status: 'open',
        tags: ['task'],
        'created-at': '2026-04-01',
      });
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'plain-task', target: 'tempered' }), res);

      expect(status()).toBe(500);
      expect(body().error).toMatch(/shuttle/);

      // File is byte-identical.
      const after = readFileSync(join(FELT_DIR, 'plain-task', 'plain-task.md'), 'utf-8');
      expect(after).toMatch(/^status: open$/m);
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('composts a fiber — closed with tempered:false', async () => {
      writeFib('moot', {
        name: 'Moot',
        status: 'open',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'moot', target: 'composted' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('closed');
      expect(body().card.tempered).toBe(false);

      const after = readFileSync(join(FELT_DIR, 'moot', 'moot.md'), 'utf-8');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: false$/m);
    });

    it('returns a composted fiber to in flight, clearing tempered', async () => {
      writeFib('revive', {
        name: 'Revive',
        status: 'closed',
        tempered: 'false',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: async () => {},
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'revive', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();

      const after = readFileSync(join(FELT_DIR, 'revive', 'revive.md'), 'utf-8');
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('rejects unknown target values with 400', async () => {
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'foo', target: 'bogus' }), res);

      expect(status()).toBe(400);
      expect(body().error).toMatch(/target/);
    });

    it('rejects malformed body with 400', async () => {
      const api = new HttpApiKanban({ feltHost: TEST_DIR });
      const { res, status } = capRes();
      const stream = Readable.from([]) as unknown as IncomingMessage;
      await api.handleTransition(stream, res);

      expect(status()).toBe(400);
    });
  });

  // ── Pure helper: applyTargetToFrontmatter ──────────────────────────────────

  describe('applyTargetToFrontmatter', () => {
    const NOW = '2026-04-28T12:00:00.000Z';

    it('preserves unrelated frontmatter and body byte-identical', () => {
      const original = [
        '---',
        'name: Foo',
        'status: open',
        'tags:',
        '  - constitution',
        '  - alpha',
        'priority: 2',
        'outcome: |',
        '  multi-line',
        '  outcome',
        '---',
        '',
        '# Body',
        '',
        'paragraph with status: open in prose',
        '',
      ].join('\n');

      const after = applyTargetToFrontmatter(original, 'tempered', NOW);
      expect(after).toContain('name: Foo');
      expect(after).toContain('tags:\n  - constitution\n  - alpha');
      expect(after).toContain('priority: 2');
      expect(after).toContain('outcome: |\n  multi-line\n  outcome');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: true$/m);
      expect(after).toMatch(/^closed-at: 2026-04-28T12:00:00\.000Z$/m);
      // Body is preserved verbatim.
      expect(after).toContain('paragraph with status: open in prose');
    });

    it('updates an existing tempered field by clearing it on awaitingReview', () => {
      const original = [
        '---',
        'name: Foo',
        'status: closed',
        'tempered: true',
        'tags:',
        '  - constitution',
        '---',
        'body',
      ].join('\n');

      const after = applyTargetToFrontmatter(original, 'awaitingReview', NOW);
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('throws when no frontmatter exists', () => {
      expect(() => applyTargetToFrontmatter('# just a body', 'tempered', NOW))
        .toThrow(/frontmatter/);
    });

    it('drafts target: preserves tags and status, clears closed-at and tempered', () => {
      const original = [
        '---',
        'name: Foo',
        'status: open',
        'tags:',
        '  - constitution',
        '  - alpha',
        'closed-at: 2026-04-01',
        '---',
        'body',
      ].join('\n');

      const after = applyTargetToFrontmatter(original, 'drafts', NOW);
      // No tag mutations (shuttle.enabled drives column, not tags)
      expect(after).toMatch(/^tags:\n  - constitution\n  - alpha$/m);
      expect(after).not.toMatch(/^  - draft$/m);
      // status left as-is (open), tempered absent, closed-at cleared
      expect(after).toMatch(/^status: open$/m);
      expect(after).not.toMatch(/^tempered:/m);
      expect(after).not.toMatch(/^closed-at:/m);
    });

    it('inFlight target: sets status=active, no tag mutations', () => {
      const original = [
        '---',
        'name: Foo',
        'status: open',
        'tags:',
        '  - constitution',
        '  - draft',
        '---',
        'body',
      ].join('\n');

      const after = applyTargetToFrontmatter(original, 'inFlight', NOW);
      // Status changes to active; draft tag NOT removed (shuttle.enabled drives column)
      expect(after).toMatch(/^status: active$/m);
      // tags preserved exactly
      const tagMatches = after.match(/^  - draft$/gm) ?? [];
      expect(tagMatches.length).toBe(1);
    });

    it('round-trips drafts → inFlight → drafts: felt-level fields are consistent', () => {
      const start = [
        '---',
        'name: Foo',
        'status: open',
        'tags:',
        '  - constitution',
        '---',
        'body',
      ].join('\n');

      const a = applyTargetToFrontmatter(start, 'drafts', NOW);
      const b = applyTargetToFrontmatter(a, 'inFlight', NOW);
      const c = applyTargetToFrontmatter(b, 'drafts', NOW);

      // No draft tag added/removed — only status changes on the inFlight pass.
      expect(a.match(/^  - draft$/m)).toBeNull();
      expect(b.match(/^  - draft$/m)).toBeNull();
      expect(c.match(/^  - draft$/m)).toBeNull();
      expect(b.match(/^status: active$/m)).not.toBeNull();
      // Tags (constitution) preserved through all transitions.
      expect(a.match(/^  - constitution$/m)).not.toBeNull();
      expect(b.match(/^  - constitution$/m)).not.toBeNull();
      expect(c.match(/^  - constitution$/m)).not.toBeNull();
    });

    it('does not match status: substrings inside the body', () => {
      // The launcher-grep self-match family: prose mentioning "status: open"
      // shouldn't be touched. Frontmatter-only edits are essential.
      const original = [
        '---',
        'name: Foo',
        'status: open',
        'tags:',
        '  - constitution',
        '---',
        '',
        'The body explains "status: open" semantics in prose.',
      ].join('\n');

      const after = applyTargetToFrontmatter(original, 'tempered', NOW);
      // Frontmatter status updated to closed.
      const fmStatusLines = after.split(/\n---/)[0].match(/^status:.*$/gm) ?? [];
      expect(fmStatusLines).toEqual(['status: closed']);
      // Body unchanged.
      expect(after).toContain('The body explains "status: open" semantics in prose.');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 3a — remote-origin snapshots fold into the merged set
  // ──────────────────────────────────────────────────────────────────────────

  describe('remote-origin snapshots (Stage 3a)', () => {
    /** Build a shuttle-managed fiber's md content for a snapshot file. */
    function fiberContent(name: string, status = 'active'): string {
      return [
        '---',
        `name: ${name}`,
        `status: ${status}`,
        'shuttle:',
        '  enabled: true',
        '  kind: oneshot',
        'created-at: 2026-04-15T00:00:00Z',
        '---',
        '',
        'body',
      ].join('\n');
    }

    it('remote-snapshot fibers appear in the kanban response', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      const res = await callKanban(api);
      expect(res.status).toBe(200);
      const ids = res.body.columns.inFlight.map((c: any) => c.id);
      expect(ids).toContain('cmbx');
      const cmbx = res.body.columns.inFlight.find((c: any) => c.id === 'cmbx');
      expect(cmbx.originId).toBe('remote-cineca');
    });

    it('remote and local fibers coexist; local wins on id collision', async () => {
      writeFib('shared-id', {
        name: 'Local copy',
        status: 'active',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-15T00:00:00Z',
      });
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'shared-id/shared-id.md', content: fiberContent('Remote copy') },
        { path: 'remote-only/remote-only.md', content: fiberContent('Remote-only fiber') },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      const res = await callKanban(api);
      expect(res.status).toBe(200);
      const cards = res.body.columns.inFlight;
      const shared = cards.find((c: any) => c.id === 'shared-id');
      expect(shared).toBeDefined();
      expect(shared.name).toBe('Local copy');
      expect(shared.originId).toBe('local');
      // Remote-only fiber appears via the snapshot.
      const remoteOnly = cards.find((c: any) => c.id === 'remote-only');
      expect(remoteOnly).toBeDefined();
      expect(remoteOnly.originId).toBe('remote-cineca');
    });

    it('local fibers carry originId=local even when no remote snapshots', async () => {
      writeFib('local-only', {
        name: 'Local',
        status: 'active',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-15T00:00:00Z',
      });
      const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
      const res = await callKanban(api);
      expect(res.body.columns.inFlight[0].originId).toBe('local');
    });

    it('multiple remote origins both appear', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      store.upsertFullDump('remote-candide', '/automnt/candide/loom', [
        { path: 'pure_eb/pure_eb.md', content: fiberContent('pure_eb') },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      const res = await callKanban(api);
      const byId = new Map<string, string>(
        (res.body.columns.inFlight as Array<{ id: string; originId: string }>)
          .map(c => [c.id, c.originId]),
      );
      expect(byId.get('cmbx')).toBe('remote-cineca');
      expect(byId.get('pure_eb')).toBe('remote-candide');
    });

    it('applyTransition without a remoteTransitionExecutor still refuses remote fibers', async () => {
      // Stage 4 wires the executor; absent it, behaviour falls back to the
      // Stage-3a boundary so test harnesses that don't plumb an agent see
      // an honest error instead of silent failure.
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      await expect(api.applyTransition('cmbx', 'awaitingReview')).rejects.toThrow(
        /remoteTransitionExecutor wiring/,
      );
    });

    it('response.staleness reports per-origin status with hostname', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      store.upsertFullDump('remote-candide', '/automnt/candide/loom', [
        { path: 'pure_eb/pure_eb.md', content: fiberContent('pure_eb') },
      ]);
      // Mark candide stale to verify the staleSince flows through.
      store.markStale('remote-candide', '2026-04-29T00:00:00Z');
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      const res = await callKanban(api);
      expect(res.body.staleness).toEqual({
        local: { status: 'fresh' },
        'remote-cineca': { status: 'fresh', hostname: 'cineca' },
        'remote-candide': {
          status: 'stale',
          hostname: 'candide',
          staleSince: '2026-04-29T00:00:00Z',
        },
      });
    });

    it('staleness includes local even when no remote snapshots', async () => {
      const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
      const res = await callKanban(api);
      expect(res.body.staleness).toEqual({ local: { status: 'fresh' } });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Stage 4 — applyTransition routes remote-origin writes through the executor
    // ────────────────────────────────────────────────────────────────────────

    it('applyTransition routes remote-origin writes through remoteTransitionExecutor', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      const calls: Array<{
        originId: string;
        fiberId: string;
        path: string;
        target: string;
        nowIso: string;
      }> = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async (args) => {
          calls.push(args);
          // Simulate the agent reply: apply the mutation server-side to the
          // snapshot. (In production the index.ts executor does this from
          // the agent's result.content.) Use the same applyTargetToFrontmatter
          // export the agent inlines, so this mirrors the round-trip shape.
          const original = fiberContent('cmbx');
          const updated = applyTargetToFrontmatter(original, args.target as any, args.nowIso);
          store.applyDelta(args.originId, [
            { path: args.path, op: 'upsert', content: updated },
          ]);
        },
        listSessions: () => [],
      });

      const card = await api.applyTransition('cmbx', 'tempered');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        originId: 'remote-cineca',
        fiberId: 'cmbx',
        path: 'cmbx/cmbx.md',
        target: 'tempered',
      });
      // Reflects the new state pulled from the snapshot post-delta.
      expect(card.id).toBe('cmbx');
      expect(card.originId).toBe('remote-cineca');
      expect(card.tempered).toBe(true);
      expect(card.status).toBe('closed');
    });

    it('applyTransition surfaces the executor error verbatim', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async () => {
          throw new Error("remote agent didn't acknowledge");
        },
        listSessions: () => [],
      });
      await expect(api.applyTransition('cmbx', 'tempered')).rejects.toThrow(
        /didn't acknowledge/,
      );
    });

    it('relativeFeltPath round-trips both root-shaped and dir-shaped fibers', async () => {
      // Fiber id semantics differ for entry-point (.felt/<slug>.md) vs.
      // directory-shaped (.felt/<dir>/<dir>.md). The path the executor
      // gets must match what the agent expects under FELT_DIR.
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        // Entry-point root fiber: .felt/loom.md
        { path: 'loom.md', content: fiberContent('loom') },
        // Nested container: .felt/ai-futures/portolan/portolan.md
        { path: 'ai-futures/portolan/portolan.md', content: fiberContent('portolan') },
      ]);
      const seen: string[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async ({ path, target, nowIso, originId }) => {
          seen.push(path);
          // Apply locally so the post-call collectFibers reads new state.
          const before = store.getSnapshot(originId)?.fibers.find(
            f => relativeFeltPathFromId(f.id, f.isRoot) === path,
          );
          if (!before) throw new Error(`no fiber for path ${path}`);
          const original = fiberContent(before.name);
          const updated = applyTargetToFrontmatter(original, target as any, nowIso);
          store.applyDelta(originId, [{ path, op: 'upsert', content: updated }]);
        },
        listSessions: () => [],
      });

      await api.applyTransition('loom', 'tempered');
      await api.applyTransition('ai-futures/portolan', 'tempered');
      expect(seen).toEqual(['loom.md', 'ai-futures/portolan/portolan.md']);
    });

    it('remote fibers without a shuttle: block are excluded', async () => {
      const store = new FiberTreeSnapshotStore();
      // No shuttle: block → excluded from kanban.
      const noBlock = [
        '---',
        'name: Untagged',
        'status: active',
        'created-at: 2026-04-15T00:00:00Z',
        '---',
      ].join('\n');
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'untagged/untagged.md', content: noBlock },
      ]);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        listSessions: () => [],
      });
      const res = await callKanban(api);
      expect(res.body.totals.inFlight).toBe(0);
    });
  });

  it('honors temperedLimit and reports temperedTotal separately', async () => {
    for (let i = 0; i < 5; i++) {
      writeFib(`t${i}`, {
        name: `T${i}`,
        status: 'closed',
        tempered: 'true',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
        'closed-at': `2026-04-${String(10 + i).padStart(2, '0')}`,
      });
    }
    const api = new HttpApiKanban({ feltHost: TEST_DIR, temperedLimit: 3 });
    const res = await callKanban(api);

    expect(res.body.totals.tempered).toBe(3);
    expect(res.body.temperedTotal).toBe(5);
    expect(res.body.columns.tempered).toHaveLength(3);
    // Most recent first.
    expect(res.body.columns.tempered.map((c: any) => c.id)).toEqual(['t4', 't3', 't2']);
  });
});
