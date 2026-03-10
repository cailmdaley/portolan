import { describe, expect, it } from 'vitest';
import { reconcilePreviousLocalSessions } from '../PreviousSessionReconciler.js';
import type { Session } from '../SessionTracker.js';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? 'session-id',
    name: overrides.name ?? 'worker',
    tmuxSession: overrides.tmuxSession ?? 'tmux',
    cwd: overrides.cwd ?? '/tmp',
    cityId: overrides.cityId ?? null,
    workerHex: overrides.workerHex,
    cli: overrides.cli,
    status: overrides.status ?? 'idle',
    createdAt: overrides.createdAt ?? 1,
    lastActivity: overrides.lastActivity ?? 1,
    originId: overrides.originId ?? 'local',
  };
}

describe('reconcilePreviousLocalSessions', () => {
  it('prunes removed local sessions while preserving remote entries', () => {
    const removedLocal = makeSession({
      id: 'local-removed',
      tmuxSession: 'l1',
      cityId: 'city-a',
      workerHex: { q: 1, r: 2 },
      originId: 'local',
    });
    const remoteSession = makeSession({
      id: 'remote-keep',
      tmuxSession: 'r1',
      originId: 'remote-lab',
    });
    const stillLocal = makeSession({
      id: 'local-keep',
      tmuxSession: 'l2',
      originId: 'local',
    });

    const previous = new Map<string, Session>([
      [removedLocal.id, removedLocal],
      [remoteSession.id, remoteSession],
    ]);

    const removed = reconcilePreviousLocalSessions(previous, [stillLocal], 'local');

    expect(removed).toEqual([removedLocal]);
    expect(previous.has(removedLocal.id)).toBe(false);
    expect(previous.get(remoteSession.id)).toBe(remoteSession);
    expect(previous.get(stillLocal.id)).toBe(stillLocal);
  });

  it('refreshes existing local sessions to latest objects', () => {
    const staleLocal = makeSession({
      id: 'local-1',
      tmuxSession: 'worker-1',
      cwd: '/old/path',
      originId: 'local',
    });
    const freshLocal = makeSession({
      id: 'local-1',
      tmuxSession: 'worker-1',
      cwd: '/new/path',
      originId: 'local',
    });

    const previous = new Map<string, Session>([[staleLocal.id, staleLocal]]);
    const removed = reconcilePreviousLocalSessions(previous, [freshLocal], 'local');

    expect(removed).toHaveLength(0);
    expect(previous.get(staleLocal.id)).toBe(freshLocal);
    expect(previous.get(staleLocal.id)?.cwd).toBe('/new/path');
  });

  it('supports non-default local origin ids', () => {
    const localOnCustomOrigin = makeSession({
      id: 'edge-local',
      tmuxSession: 'edge-tmux',
      originId: 'edge',
    });
    const previous = new Map<string, Session>([[localOnCustomOrigin.id, localOnCustomOrigin]]);

    const removed = reconcilePreviousLocalSessions(previous, [], 'edge');

    expect(removed).toEqual([localOnCustomOrigin]);
    expect(previous.size).toBe(0);
  });
});
