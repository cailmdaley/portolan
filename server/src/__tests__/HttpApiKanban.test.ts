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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import YAML from 'yaml';
import {
  HttpApiKanban,
  classifyFiber,
  type FeltTagEditInvocation,
  type KanbanCard,
  type RemoteKanbanMutationRequest,
  type ShuttleCtlInvocation,
} from '../HttpApiKanban.js';
import { canonicalFiberRefFromPath, canonicalStoreRelativeId } from '../canonicalFiberRef.js';
import type { Fiber } from '../FiberReader.js';
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

function mdPathForFiberId(host: string, fiberId: string): string {
  const segments = fiberId.split('/');
  const basename = segments[segments.length - 1];
  return join(host, '.felt', ...segments, `${basename}.md`);
}

function rewriteFrontmatter(raw: string, mutate: (doc: Record<string, any>) => void): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error('file has no YAML frontmatter');
  const doc = (YAML.parse(match[1]) ?? {}) as Record<string, any>;
  mutate(doc);
  const after = raw.slice(match[0].length);
  return `---\n${YAML.stringify(doc).trimEnd()}\n---\n${after}`;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function applyShuttleCtlInvocation(invocation: ShuttleCtlInvocation, nowIso = '2026-05-03T16:00:00.000Z'): void {
  const path = mdPathForFiberId(invocation.host, invocation.fiberId);
  const raw = readFileSync(path, 'utf-8');
  const updated = rewriteFrontmatter(raw, (doc) => {
    switch (invocation.verb) {
      case 'pause':
        if (doc.status === 'closed') doc.status = 'active';
        delete doc.tempered;
        delete doc['closed-at'];
        doc.shuttle = { ...(doc.shuttle ?? {}), enabled: false };
        break;
      case 'reopen':
        doc.status = 'active';
        delete doc.tempered;
        delete doc['closed-at'];
        doc.shuttle = { ...(doc.shuttle ?? {}), enabled: true };
        break;
      case 'close':
        doc.status = 'closed';
        if (invocation.tempered === undefined) delete doc.tempered;
        else doc.tempered = invocation.tempered;
        if (doc['closed-at'] === undefined) doc['closed-at'] = nowIso;
        break;
      case 'accept':
        doc.shuttle = {
          ...(doc.shuttle ?? {}),
          enabled: true,
          review: { ...(doc.shuttle?.review ?? {}), state: 'scheduled' },
        };
        break;
      case 'set-outcome':
        doc.outcome = invocation.outcome;
        break;
    }
  });
  writeFileSync(path, updated, 'utf-8');
}

function applyFeltTagEditInvocation(invocation: FeltTagEditInvocation): void {
  const path = mdPathForFiberId(invocation.host, invocation.fiberId);
  const raw = readFileSync(path, 'utf-8');
  const updated = rewriteFrontmatter(raw, (doc) => {
    const current = normalizeTags(Array.isArray(doc.tags) ? doc.tags.map((tag) => String(tag)) : []);
    const removeSet = new Set(invocation.remove);
    const next = current.filter((tag) => !removeSet.has(tag));
    for (const tag of invocation.add) if (!next.includes(tag)) next.push(tag);
    if (next.length === 0) delete doc.tags;
    else doc.tags = next;
  });
  writeFileSync(path, updated, 'utf-8');
}

function applyRemoteMutation(content: string, mutation: RemoteKanbanMutationRequest, nowIso = '2026-05-03T16:00:00.000Z'): string {
  return rewriteFrontmatter(content, (doc) => {
    if (mutation.kind === 'felt-tags') {
      doc.tags = normalizeTags(mutation.tags);
      if (doc.tags.length === 0) delete doc.tags;
      return;
    }

    switch (mutation.verb) {
      case 'pause':
        if (doc.status === 'closed') doc.status = 'active';
        delete doc.tempered;
        delete doc['closed-at'];
        doc.shuttle = { ...(doc.shuttle ?? {}), enabled: false };
        break;
      case 'reopen':
        doc.status = 'active';
        delete doc.tempered;
        delete doc['closed-at'];
        doc.shuttle = { ...(doc.shuttle ?? {}), enabled: true };
        break;
      case 'close':
        doc.status = 'closed';
        if (mutation.tempered === undefined) delete doc.tempered;
        else doc.tempered = mutation.tempered;
        if (doc['closed-at'] === undefined) doc['closed-at'] = nowIso;
        break;
      case 'accept':
        doc.shuttle = {
          ...(doc.shuttle ?? {}),
          enabled: true,
          review: { ...(doc.shuttle?.review ?? {}), state: 'scheduled' },
        };
        break;
      case 'set-outcome':
        doc.outcome = mutation.outcome;
        break;
    }
  });
}

function makeShuttleCtlStub(calls: ShuttleCtlInvocation[], nowIso = '2026-05-03T16:00:00.000Z') {
  return async (invocation: ShuttleCtlInvocation): Promise<void> => {
    calls.push(invocation);
    applyShuttleCtlInvocation(invocation, nowIso);
  };
}

function makeFeltEditStub(calls: FeltTagEditInvocation[]) {
  return async (invocation: FeltTagEditInvocation): Promise<void> => {
    calls.push(invocation);
    applyFeltTagEditInvocation(invocation);
  };
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
    expect(res.body.columns).toEqual({ ideas: [], drafts: [], inFlight: [], awaitingReview: [], tempered: [], composted: [] });
    expect(res.body.totals).toEqual({ ideas: 0, drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 });
  });

  it('skips fibers that have no shuttle: block', async () => {
    writeFib('regular-task', { name: 'Task', status: 'open', tags: ['task'], 'created-at': '2026-04-01' });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);
    expect(res.body.totals).toEqual({ ideas: 0, drafts: 0, inFlight: 0, awaitingReview: 0, tempered: 0, composted: 0 });
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
    expect(res.body.totals).toEqual({ ideas: 0, drafts: 1, inFlight: 2, awaitingReview: 1, tempered: 1, composted: 0 });
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
    // Standing roles in scheduled state are dormant (waiting for next cron),
    // so they land in drafts (sorted to the bottom) rather than crowding
    // inFlight with cards that aren't actively running. inFlight stays empty
    // here because there are no active oneshots.
    expect(res.body.columns.inFlight.map((c: any) => c.id)).toEqual([]);
    expect(res.body.columns.drafts.map((c: any) => c.id)).toEqual(['canary-scheduled']);
  });

  it('sorts drafts with active drafts on top, dormant standing roles on bottom', async () => {
    // Drafts hold two distinct kinds: paused/work-in-progress fibers (the
    // ones a user is reviewing or about to dispatch) and dormant standing
    // roles (waiting for cron). The standing roles get pushed below by the
    // drafts comparator so they don't crowd the user's active drafts.
    writeFib('paused-old', {
      name: 'Paused (old)',
      status: 'active',
      shuttle: SHUTTLE_DRAFT,
      'created-at': '2026-04-01',
    });
    writeFib('paused-new', {
      name: 'Paused (new)',
      status: 'active',
      shuttle: SHUTTLE_DRAFT,
      'created-at': '2026-04-03',
    });
    writeFib('standing-dormant', {
      name: 'Standing (dormant, recently created)',
      status: 'active',
      shuttle: SHUTTLE_STANDING_SCHEDULED,
      'created-at': '2026-04-05', // newest, but dormant — should still be below paused
    });
    const api = new HttpApiKanban({ feltHost: TEST_DIR, listSessions: () => [] });
    const res = await callKanban(api);

    expect(res.status).toBe(200);
    expect(res.body.columns.drafts.map((c: any) => c.id)).toEqual([
      'paused-new',
      'paused-old',
      'standing-dormant',
    ]);
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

  it('matches a Shuttle worker dispatched from a foreign canonical store via symlink', async () => {
    // Mirrors the loom→lightcone topology: the kanban view enumerates the
    // fiber under a prefixed id (`futures/foreign/<inner>`), but Shuttle
    // dispatched it from its canonical store, so the tmux session carries
    // only the canonical-store id (`<inner>`). The matcher must key off
    // canonical identity (derived from canonicalPath), not the kanban view's
    // prefixed id, otherwise the running-worker indicator goes missing.
    const foreignDir = join(TEST_DIR, 'foreign');
    const foreignFelt = join(foreignDir, '.felt');
    mkdirSync(foreignFelt, { recursive: true });
    const innerDir = join(foreignFelt, 'inner-fiber');
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(
      join(innerDir, 'inner-fiber.md'),
      `---\nname: Inner\nstatus: open\nshuttle:\n  enabled: true\n  kind: oneshot\ncreated-at: 2026-04-01\n---\n\nbody\n`,
      'utf-8',
    );
    // Mount the foreign store under our outer felt host via a symlink — the
    // exact shape `~/loom/.felt/ai-futures/lightcone -> ~/lightcone/.felt`.
    const mountDir = join(FELT_DIR, 'futures');
    mkdirSync(mountDir, { recursive: true });
    require('fs').symlinkSync(foreignFelt, join(mountDir, 'foreign'));

    const api = new HttpApiKanban({
      feltHost: TEST_DIR,
      // Session name uses the canonical-store id, not the kanban-view id.
      listSessions: () => ['shuttle-inner-fiber'],
    });
    const res = await callKanban(api);

    const card = res.body.columns.inFlight.find((c: any) =>
      c.id.endsWith('inner-fiber'),
    );
    expect(card).toBeDefined();
    expect(card.runningWorker).toBe('shuttle-inner-fiber');
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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'story', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(body().ok).toBe(true);
      expect(body().card.tempered).toBe(true);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'story', tempered: true }]);

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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'approved', target: 'awaitingReview' }), res);

      expect(status()).toBe(200);
      expect(body().card.tempered).toBeUndefined();
      expect(body().card.status).toBe('closed');
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'approved' }]);

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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'legacy-queued', target: 'queued' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'legacy-queued' }]);
    });

    it('moves a fiber to drafts — calls shuttle-ctl pause, clears closed-at', async () => {
      writeFib('idea', {
        name: 'Idea',
        status: 'open',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'idea', target: 'drafts' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'pause', fiberId: 'idea' }]);
      // felt-level: status left as-is (open), no tag mutations
      const after = readFileSync(join(FELT_DIR, 'idea', 'idea.md'), 'utf-8');
      expect(after).toMatch(/^status: open$/m);
      expect(after).not.toMatch(/^  - draft$/m);
    });

    it('moves a draft to inFlight — calls shuttle-ctl reopen, status=active', async () => {
      writeFib('promoted', {
        name: 'Promoted',
        status: 'open',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'promoted', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'promoted' }]);
      expect(body().card.status).toBe('active');
    });

    it('standing-role awaitingReview → inFlight calls shuttle-ctl accept (not reopen)', async () => {
      // The kanban gesture for accepting a standing-role run is to drag the
      // card from awaitingReview back into inFlight. The right verb is
      // `accept` (advances review.state + computes next_due_at) — `reopen`
      // would incorrectly treat the standing run like a oneshot requeue.
      writeFib('canary', {
        name: 'Canary',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'accept', fiberId: 'canary' }]);
      expect(body().card.status).toBe('active');
      const after = readFileSync(join(FELT_DIR, 'canary', 'canary.md'), 'utf-8');
      expect(after).toMatch(/^status: active$/m);
      expect(after).toMatch(/^    state: scheduled$/m);
    });

    it('invokes Shuttle action ids for local transition grammar', async () => {
      writeFib('resolver-owned', {
        name: 'Resolver owned',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const resolved: Array<{ fiberId: string; target: string }> = [];
      const invoked: Array<{ fiberId: string; action: string }> = [];
      const shuttleCtl = makeShuttleCtlStub(shuttleCalls);
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleActionResolverFn: async ({ fiberId, target }) => {
          resolved.push({ fiberId, target });
          return { id: 'accept-run' };
        },
        shuttleActionInvokerFn: async ({ fiberId, action }) => {
          invoked.push({ fiberId, action });
          await shuttleCtl({ host: TEST_DIR, verb: 'accept', fiberId });
        },
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'resolver-owned', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(resolved).toEqual([{ fiberId: 'resolver-owned', target: 'inFlight' }]);
      expect(invoked).toEqual([{ fiberId: 'resolver-owned', action: 'accept-run' }]);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'accept', fiberId: 'resolver-owned' }]);
    });

    it('falls back to local action mapping when tests use the shuttle-ctl seam', async () => {
      writeFib('daemonless', {
        name: 'Daemonless',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'daemonless', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'accept', fiberId: 'daemonless' }]);
    });

    it('can execute a local transition from submitted card context without walking the board', async () => {
      writeFib('fast-card', {
        name: 'Fast card',
        status: 'active',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const card: KanbanCard = {
        id: 'fast-card',
        name: 'Fast card',
        path: join(FELT_DIR, 'fast-card', 'fast-card.md'),
        originId: 'local',
        status: 'active',
        createdAt: '2026-04-01',
        dependsOnSatisfied: true,
        shuttleEnabled: true,
        shuttleKind: 'oneshot',
      };
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        // If the implementation falls back to collectFibers(), this host has
        // no .felt tree and the transition will fail. The submitted card path
        // carries enough local context to avoid that slow lookup.
        feltHost: join(TEST_DIR, 'missing-host'),
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'fast-card', target: 'tempered', card }), res);

      expect(status()).toBe(200);
      expect(body().card.tempered).toBe(true);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'fast-card', tempered: true }]);
    });

    it('standing role in scheduled state → inFlight calls dispatch with adHoc:true', async () => {
      // Manual launch from drafts: dragging a dormant standing role (waiting
      // for cron) to inFlight fires an ad-hoc run. The synthetic adhoc-*
      // run id (generated by the daemon) means the cron-scheduled
      // next_due_at is preserved; manual triggering doesn't burn the next
      // scheduled occurrence. This is the kanban-gesture mirror of the
      // modal's "Dispatch now" button for standing roles.
      writeFib('standing-fire', {
        name: 'Standing role (dormant, drag to inFlight)',
        status: 'active',
        shuttle: SHUTTLE_STANDING_SCHEDULED,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'standing-fire', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([
        { host: TEST_DIR, verb: 'dispatch', fiberId: 'standing-fire', adHoc: true },
      ]);
    });

    it('closed standing role → inFlight calls reopen before any ad-hoc dispatch', async () => {
      writeFib('standing-closed', {
        name: 'Standing role (closed)',
        status: 'closed',
        shuttle: SHUTTLE_STANDING_SCHEDULED,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'standing-closed', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([
        { host: TEST_DIR, verb: 'reopen', fiberId: 'standing-closed' },
      ]);
    });

    it('paused standing role (enabled=false) → inFlight calls reopen, not dispatch', async () => {
      // A paused standing role isn't dispatching at all (enabled=false),
      // so the natural gesture for unpausing is reopen — not ad-hoc
      // dispatch. After reopen, the daemon picks up the schedule again on
      // its next poll. Resume + immediate dispatch is two gestures, not one.
      writeFib('standing-paused', {
        name: 'Standing role (paused)',
        status: 'active',
        shuttle: { enabled: false, kind: 'standing', review: { state: 'scheduled' } },
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'standing-paused', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([
        { host: TEST_DIR, verb: 'reopen', fiberId: 'standing-paused' },
      ]);
    });

    it('oneshot draft → inFlight still calls reopen (the standing-accept path is kind-gated)', async () => {
      // Regression check: the standing-accept branch must not steal the
      // reopen path for plain oneshot drafts.
      writeFib('oneshot-draft', {
        name: 'Oneshot draft',
        status: 'open',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'oneshot-draft', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'oneshot-draft' }]);
    });

    it('standing-role awaitingReview → tempered also calls accept (NOT close/tempered=true)', async () => {
      // For standing roles, "tempered" of an awaiting run is equivalent to
      // accepting it — the human is approving this run, but the role itself
      // continues. The oneshot close/tempered path would terminate the role,
      // which is wrong. Only `composted` should retire a standing role.
      writeFib('canary-tempered', {
        name: 'Canary tempered',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary-tempered', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'accept', fiberId: 'canary-tempered' }]);
      expect(body().card.status).toBe('active');
      const after = readFileSync(join(FELT_DIR, 'canary-tempered', 'canary-tempered.md'), 'utf-8');
      expect(after).toMatch(/^status: active$/m);
      expect(after).toMatch(/^    state: scheduled$/m);
      expect(after).not.toMatch(/^tempered: true$/m);
    });

    it('standing-role awaitingReview → composted DOES terminate the role (status=closed, tempered=false)', async () => {
      // composted is "I'm done with this recurring thing, retire it." For
      // standing roles that means closing the fiber so the daemon stops
      // dispatching it forever.
      writeFib('canary-retired', {
        name: 'Canary retired',
        status: 'active',
        shuttle: SHUTTLE_STANDING_AWAITING,
        'created-at': '2026-04-01',
      });
      const fixedNow = new Date('2026-05-03T16:00:00Z');
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls, fixedNow.toISOString()),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'canary-retired', target: 'composted' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'canary-retired', tempered: false }]);
      const after = readFileSync(join(FELT_DIR, 'canary-retired', 'canary-retired.md'), 'utf-8');
      expect(after).toMatch(/^status: closed$/m);
      expect(after).toMatch(/^tempered: false$/m);
      expect(after).toMatch(/^closed-at: 2026-05-03T16:00:00\.000Z$/m);
    });

    it('oneshot awaitingReview → tempered still closes with tempered=true', async () => {
      // Regression check: the standing-accept tempered branch must not steal
      // the path for plain oneshot acceptance.
      writeFib('oneshot-accept', {
        name: 'Oneshot accept',
        status: 'closed',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
        'closed-at': '2026-04-15',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'oneshot-accept', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'oneshot-accept', tempered: true }]);
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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'reactivate', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'reactivate' }]);

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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls, fixedNow.toISOString()),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'skip-review', target: 'tempered' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'skip-review', tempered: true }]);
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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'moot', target: 'composted' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('closed');
      expect(body().card.tempered).toBe(false);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'close', fiberId: 'moot', tempered: false }]);

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
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'revive', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(body().card.status).toBe('active');
      expect(body().card.tempered).toBeUndefined();
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'revive' }]);

      const after = readFileSync(join(FELT_DIR, 'revive', 'revive.md'), 'utf-8');
      expect(after).not.toMatch(/^tempered:/m);
    });

    it('canonicalizes a symlinked project view before calling shuttle-ctl', async () => {
      const loom = join(TEST_DIR, 'loom');
      const project = join(TEST_DIR, 'project');
      mkdirSync(join(loom, '.felt', 'ai-futures', 'portolan', 'kanban-modal'), { recursive: true });
      mkdirSync(project, { recursive: true });
      symlinkSync(join(loom, '.felt', 'ai-futures', 'portolan'), join(project, '.felt'));
      writeFileSync(
        join(loom, '.felt', 'ai-futures', 'portolan', 'kanban-modal', 'kanban-modal.md'),
        [
          '---',
          'name: Kanban modal',
          'status: active',
          'created-at: 2026-04-01',
          'shuttle:',
          '  enabled: true',
          '  kind: oneshot',
          '---',
          '',
          'body',
          '',
        ].join('\n'),
        'utf-8',
      );

      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: project,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'kanban-modal', target: 'awaitingReview' }), res);

      expect(status()).toBe(200);
      expect(
        canonicalFiberRefFromPath(
          realpathSync(join(project, '.felt', 'kanban-modal', 'kanban-modal.md')),
        ),
      ).toEqual({ host: loom, fiberId: 'ai-futures/portolan/kanban-modal' });
      expect(shuttleCalls).toEqual([
        { host: loom, verb: 'close', fiberId: 'ai-futures/portolan/kanban-modal' },
      ]);
    });

    it('drafts → ideas adds the idea tag (no shuttle-ctl call)', async () => {
      // Column placement for `ideas` is governed by the `idea` tag, not by
      // a lifecycle verb. Dragging into ideas must be a tag mutation; if
      // it shells shuttle-ctl, the kanban view diverges from disk state.
      writeFib('sketch', {
        name: 'Sketch',
        status: 'open',
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const feltCalls: FeltTagEditInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
        feltEditFn: makeFeltEditStub(feltCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'sketch', target: 'ideas' }), res);

      expect(status()).toBe(200);
      expect(shuttleCalls).toEqual([]);
      expect(feltCalls).toEqual([
        { host: TEST_DIR, fiberId: 'sketch', add: ['idea'], remove: [] },
      ]);
      expect(body().card.tags).toContain('idea');
      const after = readFileSync(join(FELT_DIR, 'sketch', 'sketch.md'), 'utf-8');
      expect(after).toMatch(/^  - idea$/m);
    });

    it('ideas → drafts strips the idea tag and pauses', async () => {
      // Drag-out-of-ideas chains a tag-strip into the lifecycle verb so the
      // fiber lands in the requested column under classifyFiber's rules
      // (idea-tag precedence over enabled).
      writeFib('thought', {
        name: 'Thought',
        status: 'open',
        tags: ['idea'],
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const feltCalls: FeltTagEditInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
        feltEditFn: makeFeltEditStub(feltCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'thought', target: 'drafts' }), res);

      expect(status()).toBe(200);
      expect(feltCalls).toEqual([
        { host: TEST_DIR, fiberId: 'thought', add: [], remove: ['idea'] },
      ]);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'pause', fiberId: 'thought' }]);
      const after = readFileSync(join(FELT_DIR, 'thought', 'thought.md'), 'utf-8');
      expect(after).not.toMatch(/^  - idea$/m);
    });

    it('ideas → inFlight strips the idea tag and reopens', async () => {
      writeFib('promote', {
        name: 'Promote',
        status: 'open',
        tags: ['idea'],
        shuttle: SHUTTLE_DRAFT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const feltCalls: FeltTagEditInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
        feltEditFn: makeFeltEditStub(feltCalls),
      });
      const { res, status } = capRes();
      await api.handleTransition(jsonReq({ fiberId: 'promote', target: 'inFlight' }), res);

      expect(status()).toBe(200);
      expect(feltCalls).toEqual([
        { host: TEST_DIR, fiberId: 'promote', add: [], remove: ['idea'] },
      ]);
      expect(shuttleCalls).toEqual([{ host: TEST_DIR, verb: 'reopen', fiberId: 'promote' }]);
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

  describe('handleTags', () => {
    function jsonReq(body: unknown): IncomingMessage {
      return Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
    }

    function capRes(): { res: ServerResponse; status: () => number; body: () => any } {
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(s: number) { status = s; },
        end(c?: string) { if (c) chunks.push(c); },
      } as unknown as ServerResponse;
      return { res, status: () => status, body: () => (chunks.length ? JSON.parse(chunks.join('')) : null) };
    }

    it('replaces local tags through felt edit diffs', async () => {
      writeFib('taggy', {
        name: 'Taggy',
        status: 'active',
        tags: ['constitution', 'old'],
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const feltCalls: FeltTagEditInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        feltEditFn: makeFeltEditStub(feltCalls),
      });
      const { res, status, body } = capRes();
      await api.handleTags(jsonReq({ fiberId: 'taggy', tags: ['new', 'old', 'new'] }), res);

      expect(status()).toBe(200);
      expect(body().card.tags).toEqual(['old', 'new']);
      expect(feltCalls).toEqual([
        { host: TEST_DIR, fiberId: 'taggy', add: ['new'], remove: ['constitution'] },
      ]);

      const after = readFileSync(join(FELT_DIR, 'taggy', 'taggy.md'), 'utf-8');
      expect(after).toContain('- old');
      expect(after).toContain('- new');
      expect(after).not.toContain('constitution');
    });

    it('routes remote tag edits through remoteTransitionExecutor', async () => {
      const store = new FiberTreeSnapshotStore();
      const content = [
        '---',
        'name: cmbx',
        'status: active',
        'tags:',
        '  - constitution',
        '  - old',
        'shuttle:',
        '  enabled: true',
        '  kind: oneshot',
        'created-at: 2026-04-15T00:00:00Z',
        '---',
        '',
        'body',
      ].join('\n');
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content },
      ]);
      const calls: RemoteKanbanMutationRequest[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async (args) => {
          calls.push(args);
          store.applyDelta(args.originId, [
            { path: args.path, op: 'upsert', content: applyRemoteMutation(content, args) },
          ]);
        },
        listSessions: () => [],
      });

      const card = await api.applyTags('cmbx', ['new']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        originId: 'remote-cineca',
        fiberId: 'cmbx',
        path: 'cmbx/cmbx.md',
        kind: 'felt-tags',
        tags: ['new'],
      });
      expect(card.tags).toEqual(['new']);
    });
  });

  describe('handleFiberPatch', () => {
    function jsonReq(body: unknown): IncomingMessage {
      return Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
    }

    function capRes(): { res: ServerResponse; status: () => number; body: () => any } {
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(s: number) { status = s; },
        end(c?: string) { if (c) chunks.push(c); },
      } as unknown as ServerResponse;
      return { res, status: () => status, body: () => (chunks.length ? JSON.parse(chunks.join('')) : null) };
    }

    it('routes outcome edits through shuttle-ctl set-outcome', async () => {
      writeFib('story', {
        name: 'Story',
        status: 'active',
        shuttle: SHUTTLE_INFLIGHT,
        'created-at': '2026-04-01',
      });
      const shuttleCalls: ShuttleCtlInvocation[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        shuttleCtlFn: makeShuttleCtlStub(shuttleCalls),
      });
      const { res, status, body } = capRes();
      await api.handleFiberPatch(jsonReq({ fiberId: 'story', outcome: 'First line\nSecond line' }), res);

      expect(status()).toBe(200);
      expect(body().ok).toBe(true);
      expect(shuttleCalls).toEqual([
        { host: TEST_DIR, verb: 'set-outcome', fiberId: 'story', outcome: 'First line\nSecond line' },
      ]);

      const after = readFileSync(join(FELT_DIR, 'story', 'story.md'), 'utf-8');
      expect(after).toContain('outcome: |-');
      expect(after).toContain('  First line');
      expect(after).toContain('  Second line');
    });
  });

  describe('remote-origin snapshots (Stage 3a)', () => {
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
        (res.body.columns.inFlight as Array<{ id: string; originId: string }>).map(c => [c.id, c.originId]),
      );
      expect(byId.get('cmbx')).toBe('remote-cineca');
      expect(byId.get('pure_eb')).toBe('remote-candide');
    });

    it('applyTransition without a remoteTransitionExecutor still refuses remote fibers', async () => {
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

    it('applyTransition routes remote-origin writes through remoteTransitionExecutor', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'cmbx/cmbx.md', content: fiberContent('cmbx') },
      ]);
      const calls: RemoteKanbanMutationRequest[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async (args) => {
          calls.push(args);
          store.applyDelta(args.originId, [
            { path: args.path, op: 'upsert', content: applyRemoteMutation(fiberContent('cmbx'), args) },
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
        kind: 'shuttle',
        verb: 'close',
        tempered: true,
      });
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
      await expect(api.applyTransition('cmbx', 'tempered')).rejects.toThrow(/didn't acknowledge/);
    });

    it('relativeFeltPath round-trips both root-shaped and dir-shaped fibers', async () => {
      const store = new FiberTreeSnapshotStore();
      store.upsertFullDump('remote-cineca', '/leonardo/loom', [
        { path: 'loom.md', content: fiberContent('loom') },
        { path: 'ai-futures/portolan/portolan.md', content: fiberContent('portolan') },
      ]);
      const seen: string[] = [];
      const api = new HttpApiKanban({
        feltHost: TEST_DIR,
        remoteSnapshotsProvider: () => store.getAllSnapshots(),
        remoteTransitionExecutor: async (args) => {
          seen.push(args.path);
          const before = store.getSnapshot(args.originId)?.fibers.find(
            f => relativeFeltPathFromId(f.id, f.isRoot) === args.path,
          );
          if (!before) throw new Error(`no fiber for path ${args.path}`);
          store.applyDelta(args.originId, [
            { path: args.path, op: 'upsert', content: applyRemoteMutation(fiberContent(before.name), args) },
          ]);
        },
        listSessions: () => [],
      });

      await api.applyTransition('loom', 'tempered');
      await api.applyTransition('ai-futures/portolan', 'tempered');
      expect(seen).toEqual(['loom.md', 'ai-futures/portolan/portolan.md']);
    });

    it('remote fibers without a shuttle: block are excluded', async () => {
      const store = new FiberTreeSnapshotStore();
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
    expect(res.body.columns.tempered.map((c: any) => c.id)).toEqual(['t4', 't3', 't2']);
  });
});

describe('classifyFiber', () => {
  // Minimal fiber factory: only id/name/status/kind/priority/createdAt are
  // required by the type; everything else is optional. Pass overrides to
  // shape the case under test.
  function fib(overrides: Partial<Fiber> = {}): Fiber {
    return {
      id: 'x',
      name: 'X',
      status: 'open',
      kind: 'task',
      priority: 2,
      createdAt: '2026-04-01',
      hasShuttleBlock: true,
      ...overrides,
    };
  }

  describe('open lifecycle', () => {
    it("`idea` tag wins over shuttle.enabled", () => {
      // Tag-driven: even with shuttle.enabled=true (which would put the
      // fiber in inFlight), the idea tag pulls it back to ideas. This is
      // load-bearing — flipping idea→draft is a tag edit, no need to also
      // toggle shuttle.enabled.
      expect(classifyFiber(fib({ tags: ['idea'], shuttleEnabled: true }))).toBe('ideas');
      expect(classifyFiber(fib({ tags: ['idea'], shuttleEnabled: false }))).toBe('ideas');
    });

    it('paused (shuttle.enabled=false) → drafts', () => {
      expect(classifyFiber(fib({ shuttleEnabled: false }))).toBe('drafts');
    });

    it('enabled and not idea → inFlight', () => {
      expect(classifyFiber(fib({ shuttleEnabled: true }))).toBe('inFlight');
    });

    it('"draft" tag does NOT influence placement (cosmetic only)', () => {
      // The draft tag is vestigial — pre-cutover convention. Column
      // membership is driven by shuttle.enabled. Locking this in so a
      // future reader doesn't bring back tag-based classification.
      expect(classifyFiber(fib({ tags: ['draft'], shuttleEnabled: true }))).toBe('inFlight');
      expect(classifyFiber(fib({ tags: ['draft'], shuttleEnabled: false }))).toBe('drafts');
    });
  });

  describe('closed lifecycle', () => {
    it('tempered=true → tempered', () => {
      expect(classifyFiber(fib({ status: 'closed', tempered: true }))).toBe('tempered');
    });

    it('tempered=false → composted', () => {
      expect(classifyFiber(fib({ status: 'closed', tempered: false }))).toBe('composted');
    });

    it('tempered absent → awaitingReview', () => {
      // Agent-handed-off: status flipped to closed, tempered not yet set.
      expect(classifyFiber(fib({ status: 'closed' }))).toBe('awaitingReview');
    });
  });

  describe('standing roles', () => {
    it("review.state=`awaiting` → awaitingReview, regardless of status", () => {
      // Standing roles stay status:active permanently; review.state is the
      // post-run lifecycle signal.
      expect(
        classifyFiber(
          fib({
            status: 'active',
            shuttleKind: 'standing',
            shuttleReviewState: 'awaiting',
            shuttleEnabled: true,
          }),
        ),
      ).toBe('awaitingReview');
    });

    it('review.state=`scheduled` → drafts (between runs, sorted to bottom)', () => {
      // Standing roles between runs are dispatch-eligible but dormant —
      // waiting for the next cron tick. They share the drafts column with
      // paused fibers (sorted to the bottom by the drafts comparator) so
      // the inFlight column stays focused on what's running or immediately
      // due. View-only — the daemon's eligibility check reads shuttle:
      // directly and is unaffected by column membership.
      expect(
        classifyFiber(
          fib({
            status: 'active',
            shuttleKind: 'standing',
            shuttleReviewState: 'scheduled',
            shuttleEnabled: true,
          }),
        ),
      ).toBe('drafts');
    });

    it('review.state=`accepted` → drafts (just accepted, awaiting next cron)', () => {
      // Same as scheduled: post-accept, the role is dormant until the next
      // cron occurrence. accepted is a transient state that the daemon
      // collapses to scheduled on next dispatch.
      expect(
        classifyFiber(
          fib({
            status: 'active',
            shuttleKind: 'standing',
            shuttleReviewState: 'accepted',
            shuttleEnabled: true,
          }),
        ),
      ).toBe('drafts');
    });

    it('paused standing role → drafts', () => {
      expect(
        classifyFiber(
          fib({
            status: 'active',
            shuttleKind: 'standing',
            shuttleEnabled: false,
          }),
        ),
      ).toBe('drafts');
    });
  });
});

describe('canonicalStoreRelativeId', () => {
  it('returns the directory-form id for a nested fiber', () => {
    expect(
      canonicalStoreRelativeId(
        '/Users/x/.felt/lightcone-ui/myst-as-ast-layer-for-lightcone-ui/foo/foo.md',
      ),
    ).toBe('lightcone-ui/myst-as-ast-layer-for-lightcone-ui/foo');
  });

  it('returns the bare-form id for a fiber at the store root', () => {
    expect(canonicalStoreRelativeId('/Users/x/.felt/lightcone.md')).toBe('lightcone');
  });

  it('returns undefined for a path with no .felt segment', () => {
    expect(canonicalStoreRelativeId('/tmp/random/foo.md')).toBeUndefined();
  });

  it('returns undefined when the directory shape does not match the slug', () => {
    // Layout `<.felt>/parent/child.md` where parent != child — not a fiber.
    expect(canonicalStoreRelativeId('/Users/x/.felt/parent/child.md')).toBeUndefined();
  });

  it('uses the deepest .felt segment when nested .felt dirs occur', () => {
    // A canonical path that crossed a symlink between two felt stores ends up
    // under the *inner* store; the matcher must key off that one.
    expect(
      canonicalStoreRelativeId('/Users/x/.felt/.felt/inner/inner.md'),
    ).toBe('inner');
  });
});
