import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  agentForFiber,
  computeEligibility,
  Shuttle,
  defaultShuttleConfig,
  shuttleSessionName,
} from '../Shuttle.js';
import type { Fiber } from '../FiberReader.js';
import { getAllFibers } from '../FiberReader.js';

// ── Fiber test fixtures ────────────────────────────────────────────────

function fiber(overrides: Partial<Fiber>): Fiber {
  return {
    id: 'foo',
    name: 'Foo',
    status: 'open',
    kind: 'task',
    priority: 2,
    createdAt: '2026-04-28T00:00:00Z',
    ...overrides,
  };
}

// ── computeEligibility ─────────────────────────────────────────────────

describe('computeEligibility', () => {
  it('selects constitution-tagged, unblocked, non-closed fibers', () => {
    const fibers: Fiber[] = [
      fiber({ id: 'a', tags: ['constitution'] }),
      fiber({ id: 'b', tags: ['constitution'], status: 'closed' }),
      fiber({ id: 'c', tags: ['decision'] }),
      fiber({ id: 'd', tags: ['constitution'], status: 'active' }),
    ];
    const { eligible, blocked } = computeEligibility(fibers);
    expect(eligible.map(f => f.id).sort()).toEqual(['a', 'd']);
    expect(blocked.map(b => b.fiber.id)).toEqual(['b']);
  });

  it('excludes draft-tagged fibers (kanban-side opt-out)', () => {
    // The `draft` tag is the kanban-side "not yet ready to dispatch" signal,
    // separate from the commitment switch (`constitution` tag). A fiber
    // tagged [constitution, draft] is committed-to-eventually but parked.
    const fibers: Fiber[] = [
      fiber({ id: 'ready', tags: ['constitution'] }),
      fiber({ id: 'parked', tags: ['constitution', 'draft'] }),
    ];
    const { eligible, blocked } = computeEligibility(fibers);
    expect(eligible.map(f => f.id)).toEqual(['ready']);
    expect(blocked.map(b => b.fiber.id)).toEqual(['parked']);
    expect(blocked[0].reason).toContain('draft');
  });

  it('blocks on unsatisfied depends_on', () => {
    const fibers: Fiber[] = [
      fiber({ id: 'dep', tags: ['constitution'], status: 'active' }),
      fiber({
        id: 'work',
        tags: ['constitution'],
        dependsOn: ['dep'],
      }),
    ];
    const r1 = computeEligibility(fibers);
    expect(r1.eligible.map(f => f.id)).toEqual(['dep']);
    expect(r1.blocked[0]?.reason).toContain('dep');

    // Temper the dep — work becomes eligible.
    fibers[0].tempered = true;
    const r2 = computeEligibility(fibers);
    expect(r2.eligible.map(f => f.id).sort()).toEqual(['dep', 'work']);
    expect(r2.blocked).toEqual([]);
  });

  it('Stage 2 DAG: closed-but-not-tempered does NOT satisfy dependents', () => {
    // Path B edge case. `status: closed` is overloaded — it can mean
    // "agent paused awaiting review" (`!tempered`) or "human accepted"
    // (`tempered: true`). Only the latter should unblock dependents.
    const first = fiber({ id: 'first', tags: ['constitution'], status: 'closed' });
    const second = fiber({
      id: 'second',
      tags: ['constitution'],
      status: 'active',
      dependsOn: ['first'],
    });

    // 1. first closed but NOT tempered → second remains blocked.
    const r1 = computeEligibility([first, second]);
    expect(r1.eligible).toEqual([]);
    expect(r1.blocked.map(b => b.fiber.id).sort()).toEqual(['first', 'second']);
    expect(r1.blocked.find(b => b.fiber.id === 'second')?.reason).toContain('first');

    // 2. first closed AND tempered → second becomes eligible. first
    //    itself stays blocked (status: closed) — the eligibility predicate
    //    only emits 'closed' once; tempering doesn't re-open it.
    first.tempered = true;
    const r2 = computeEligibility([first, second]);
    expect(r2.eligible.map(f => f.id)).toEqual(['second']);
    expect(r2.blocked.map(b => b.fiber.id)).toEqual(['first']);
  });

  it('treats missing depends-on target as unsatisfied', () => {
    const fibers: Fiber[] = [
      fiber({
        id: 'orphan',
        tags: ['constitution'],
        dependsOn: ['ghost'],
      }),
    ];
    const { eligible, blocked } = computeEligibility(fibers);
    expect(eligible).toEqual([]);
    expect(blocked[0]?.reason).toContain('ghost');
  });

  it('respects queue prefix scoping', () => {
    const fibers: Fiber[] = [
      fiber({ id: 'in-scope/work', tags: ['constitution'] }),
      fiber({ id: 'in-scope', tags: ['constitution'] }),
      fiber({ id: 'other/work', tags: ['constitution'] }),
    ];
    const { eligible } = computeEligibility(fibers, ['in-scope']);
    expect(eligible.map(f => f.id).sort()).toEqual(['in-scope', 'in-scope/work']);
  });

  it('partial prefix does NOT bleed into unrelated paths', () => {
    const fibers: Fiber[] = [
      fiber({ id: 'shuttle-tests/work', tags: ['constitution'] }),
      fiber({ id: 'shuttle/work', tags: ['constitution'] }),
    ];
    const { eligible } = computeEligibility(fibers, ['shuttle']);
    // 'shuttle' must match 'shuttle' or 'shuttle/...' but NOT 'shuttle-tests/...'
    expect(eligible.map(f => f.id)).toEqual(['shuttle/work']);
  });
});

// ── Shuttle integration (with synthetic fiber tree) ────────────────────

function writeFiber(feltDir: string, slug: string, content: string) {
  const parts = slug.split('/');
  const leaf = parts[parts.length - 1];
  const dir = join(feltDir, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${leaf}.md`), content);
}

describe('Shuttle.tick', () => {
  let host: string;
  let feltDir: string;

  beforeEach(() => {
    host = join(tmpdir(), `shuttle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    feltDir = join(host, '.felt');
    mkdirSync(feltDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(host)) rmSync(host, { recursive: true, force: true });
  });

  it('reads scoped fibers and records spawn calls', async () => {
    writeFiber(
      feltDir,
      'tests/haiku',
      `---
name: Haiku
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
# Haiku

Write a haiku about loom.
`,
    );
    writeFiber(
      feltDir,
      'other/work',
      `---
name: Other
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );

    // Verify the test felt host parses cleanly first.
    const allFibers = await getAllFibers(host);
    expect(allFibers.map(f => f.id).sort()).toContain('tests/haiku');

    const spawned: string[] = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
    });
    const snap = await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);
    expect(snap.eligible.map(e => e.fiberId)).toEqual(['tests/haiku']);
    expect(snap.eligible[0].state).toBe('running');
  });

  it('does not respawn while the worker is still live (listSessions seam)', async () => {
    writeFiber(
      feltDir,
      'tests/haiku',
      `---
name: Haiku
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const liveSet = new Set<string>();
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        const session = shuttleSessionName(id);
        liveSet.add(session);
        return session;
      },
      listSessions: () => Array.from(liveSet),
    });

    await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);

    // Second tick while the session is still in liveSet — must NOT respawn.
    await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);
  });

  it('Stage 3 kill-and-recover: redispatches when the tmux session disappears', async () => {
    writeFiber(
      feltDir,
      'tests/haiku',
      `---
name: Haiku
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const liveSet = new Set<string>();
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        const session = shuttleSessionName(id);
        liveSet.add(session);
        return session;
      },
      listSessions: () => Array.from(liveSet),
    });

    // Tick 1: dispatch.
    const snap1 = await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);
    expect(snap1.eligible[0]?.state).toBe('running');

    // Simulate kill-mid-iteration: drop the session from the live set.
    liveSet.delete(shuttleSessionName('tests/haiku'));

    // Tick 2: Shuttle observes the dead session and redispatches because
    // the fiber is still eligible (status active, no closing handoff).
    const snap2 = await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku', 'tests/haiku']);
    expect(snap2.eligible[0]?.state).toBe('running');
    // The new session should be live again (spawn re-added it).
    expect(liveSet.has(shuttleSessionName('tests/haiku'))).toBe(true);
  });

  it('Stage 7: stale-origin gate suspends dispatch and resumes on reconnect', async () => {
    // A constitution fiber visible locally (e.g. via a loom symlink to a
    // network mount) whose canonical writer is a remote portolan-agent.
    // While the agent is connected, the snapshot store is fresh and the
    // freshness gate returns []; Shuttle dispatches normally. When the
    // agent disconnects (FiberTreeSnapshotStore.markStale), the gate
    // returns the stale originId; Shuttle moves the fiber to `blocked`
    // with reason "origin stale: …" and refuses to spawn until the
    // agent reconnects (gate returns [] again).
    writeFiber(
      feltDir,
      'tests/cmbx',
      `---
name: Cmbx
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    let staleOrigins: string[] = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
      // Closure over a mutable list so the test can flip stale ↔ fresh
      // between ticks without rebuilding the Shuttle instance.
      staleOriginsForFiber: () => [...staleOrigins],
    });

    // Tick 1: origin stale → blocked, NOT dispatched.
    staleOrigins = ['remote-cineca'];
    const snap1 = await shuttle.tick();
    expect(spawned).toEqual([]);
    expect(snap1.eligible).toEqual([]);
    const blockedEntry = snap1.blocked.find(b => b.fiberId === 'tests/cmbx');
    expect(blockedEntry?.reason).toContain('origin stale');
    expect(blockedEntry?.reason).toContain('remote-cineca');

    // Tick 2: agent reconnects, gate returns [] → fiber dispatches.
    staleOrigins = [];
    const snap2 = await shuttle.tick();
    expect(spawned).toEqual(['tests/cmbx']);
    expect(snap2.eligible.map(e => e.fiberId)).toEqual(['tests/cmbx']);
    expect(snap2.blocked.find(b => b.fiberId === 'tests/cmbx')).toBeUndefined();
  });

  it('Stage 7: gate listing multiple stale origins surfaces all in reason', async () => {
    writeFiber(
      feltDir,
      'tests/cmbx',
      `---
name: Cmbx
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
      staleOriginsForFiber: () => ['remote-cineca', 'remote-candide'],
    });

    const snap = await shuttle.tick();
    expect(spawned).toEqual([]);
    const reason = snap.blocked.find(b => b.fiberId === 'tests/cmbx')?.reason ?? '';
    expect(reason).toContain('remote-cineca');
    expect(reason).toContain('remote-candide');
  });

  it('Stage 7: gate is opt-in — dispatch unaffected when the hook is absent', async () => {
    // Confirms backward-compatibility: existing callers that don't wire
    // staleOriginsForFiber dispatch as before.
    writeFiber(
      feltDir,
      'tests/cmbx',
      `---
name: Cmbx
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
      // staleOriginsForFiber omitted
    });

    await shuttle.tick();
    expect(spawned).toEqual(['tests/cmbx']);
  });

  it('does not redispatch after the agent flips status to closed (Path B handoff)', async () => {
    // Stage 1 protocol: agent flips active → closed. Eligibility predicate
    // drops it. Loop pauses. Even if a previous worker session is gone,
    // there should be no redispatch.
    writeFiber(
      feltDir,
      'tests/haiku',
      `---
name: Haiku
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const liveSet = new Set<string>();
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        const session = shuttleSessionName(id);
        liveSet.add(session);
        return session;
      },
      listSessions: () => Array.from(liveSet),
    });

    await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);

    // Agent finishes, flips to closed, exits.
    writeFiber(
      feltDir,
      'tests/haiku',
      `---
name: Haiku
status: closed
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    liveSet.delete(shuttleSessionName('tests/haiku'));

    // No redispatch — eligibility predicate drops it on status: closed.
    const snap = await shuttle.tick();
    expect(spawned).toEqual(['tests/haiku']);
    expect(snap.eligible).toEqual([]);
    expect(snap.blocked.map(b => b.fiberId)).toEqual(['tests/haiku']);
  });

  it('shuttle-remote-dispatch: deferral gate routes a fiber to the connected remote agent', async () => {
    // Constitution shuttle-remote-dispatch: when a fiber is also visible
    // in a connected remote agent's snapshot, the laptop's Shuttle does
    // NOT dispatch — the agent will. The blocked entry's reason names
    // the deferral target so debug surfaces are legible.
    writeFiber(
      feltDir,
      'tests/cmbx',
      `---
name: Cmbx
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    let deferredOrigins: string[] = ['remote-candide'];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
      deferredOriginsForFiber: () => [...deferredOrigins],
    });

    // Tick 1: fiber visible to a connected remote → blocked, no dispatch.
    const snap1 = await shuttle.tick();
    expect(spawned).toEqual([]);
    expect(snap1.eligible).toEqual([]);
    const blocked = snap1.blocked.find(b => b.fiberId === 'tests/cmbx');
    expect(blocked?.reason).toContain('deferred to');
    expect(blocked?.reason).toContain('remote-candide');

    // Tick 2: agent disconnects (no longer in deferred list and not stale
    // either — local-only). Now we dispatch.
    deferredOrigins = [];
    const snap2 = await shuttle.tick();
    expect(spawned).toEqual(['tests/cmbx']);
    expect(snap2.eligible.map(e => e.fiberId)).toEqual(['tests/cmbx']);
  });

  it('shuttle-remote-dispatch: stale gate fires before deferral gate', async () => {
    // Edge: a fiber listed in BOTH a stale snapshot and a connected
    // remote's snapshot (e.g. a local symlink AND a separate cineca
    // mirror). Stale wins because the surfaced reason should describe
    // the more conservative gate. (Test order: stale check, then
    // deferral.)
    writeFiber(
      feltDir,
      'tests/cmbx',
      `---
name: Cmbx
status: active
tags:
    - constitution
created-at: 2026-04-28T00:00:00Z
---
`,
    );
    const spawned: string[] = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id) => {
        spawned.push(id);
        return shuttleSessionName(id);
      },
      staleOriginsForFiber: () => ['remote-cineca'],
      deferredOriginsForFiber: () => ['remote-candide'],
    });

    const snap = await shuttle.tick();
    expect(spawned).toEqual([]);
    const blocked = snap.blocked.find(b => b.fiberId === 'tests/cmbx');
    expect(blocked?.reason).toContain('origin stale');
    expect(blocked?.reason).toContain('remote-cineca');
    expect(blocked?.reason).not.toContain('deferred to');
  });

  it('shuttle-remote-dispatch: per-origin remote snapshots round-trip through Shuttle', () => {
    // Server stores each agent's pushed snapshot indexed by originId and
    // exposes a composite for the kanban / debug view. clearRemoteSnapshot
    // (called on agent disconnect) drops the entry.
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host }),
      spawnShuttleWorker: () => 'unused',
    });

    const candideSnap = {
      pollAt: 1,
      eligible: [{ fiberId: 'cmbx/foo', state: 'running' as const, tmuxSession: 'shuttle-cmbx/foo', startedAt: 1 }],
      blocked: [],
      orphans: [],
    };
    const cinecaSnap = {
      pollAt: 2,
      eligible: [],
      blocked: [{ fiberId: 'cmbx/bar', reason: 'tag: draft' }],
      orphans: [],
    };
    shuttle.setRemoteSnapshot('remote-candide', candideSnap);
    shuttle.setRemoteSnapshot('remote-cineca', cinecaSnap);

    const composite = shuttle.getCompositeSnapshot();
    expect(composite.local).toBeNull();
    expect(composite.remote['remote-candide']).toBe(candideSnap);
    expect(composite.remote['remote-cineca']).toBe(cinecaSnap);

    shuttle.clearRemoteSnapshot('remote-candide');
    const after = shuttle.getCompositeSnapshot();
    expect(after.remote['remote-candide']).toBeUndefined();
    expect(after.remote['remote-cineca']).toBe(cinecaSnap);
  });
});

// ── agent-for-fiber (codex parity) ─────────────────────────────────────

describe('agentForFiber', () => {
  it('selects codex when the fiber carries the `codex` tag', () => {
    expect(agentForFiber(['constitution', 'codex'])).toBe('codex');
    expect(agentForFiber(['codex'])).toBe('codex');
  });

  it('defaults to claude when no opt-in tag is present', () => {
    expect(agentForFiber(['constitution'])).toBe('claude');
    expect(agentForFiber([])).toBe('claude');
    expect(agentForFiber(undefined)).toBe('claude');
  });
});

describe('Shuttle dispatch agent selection', () => {
  let host: string;
  let feltDir: string;

  beforeEach(() => {
    host = join(tmpdir(), `shuttle-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    feltDir = join(host, '.felt');
    mkdirSync(feltDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(host)) rmSync(host, { recursive: true, force: true });
  });

  it('threads the codex tag through to the worker invocation', async () => {
    // Codex parity: a constitution fiber tagged `codex` dispatches via
    // codex; an untagged sibling defaults to claude. The dispatch
    // entry carries `agent` so the kanban can badge each card.
    writeFiber(
      feltDir,
      'tests/codex-fiber',
      `---
name: Codex
status: active
tags:
    - constitution
    - codex
created-at: 2026-04-30T00:00:00Z
---
`,
    );
    writeFiber(
      feltDir,
      'tests/claude-fiber',
      `---
name: Claude
status: active
tags:
    - constitution
created-at: 2026-04-30T00:00:00Z
---
`,
    );

    const spawned: Array<{ id: string; agent: string }> = [];
    const shuttle = new Shuttle({
      ...defaultShuttleConfig({ feltHost: host, queuePrefixes: ['tests'] }),
      spawnShuttleWorker: (id, _host, agent) => {
        spawned.push({ id, agent });
        return shuttleSessionName(id);
      },
    });
    const snap = await shuttle.tick();

    // Both eligible; agent threads through dispatch and lands on the entry.
    const byId = new Map(snap.eligible.map(e => [e.fiberId, e]));
    expect(byId.get('tests/codex-fiber')?.agent).toBe('codex');
    expect(byId.get('tests/claude-fiber')?.agent).toBe('claude');

    // Worker invocation receives the agent — the worker script branches
    // on this to pick `codex exec` vs `claude` and to bundle WAKE.md
    // appropriately.
    const spawnedById = new Map(spawned.map(s => [s.id, s.agent]));
    expect(spawnedById.get('tests/codex-fiber')).toBe('codex');
    expect(spawnedById.get('tests/claude-fiber')).toBe('claude');
  });
});
