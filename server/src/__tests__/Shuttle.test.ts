import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
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
});
