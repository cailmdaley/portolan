/**
 * Agent-side Shuttle: parser + eligibility predicate.
 *
 * Constitution shuttle-remote-dispatch. The agent inlines a minimal port
 * of `Shuttle.computeEligibility` (server/src/Shuttle.ts) plus a YAML-ish
 * frontmatter parser scoped to the four fields Shuttle actually reads
 * (status, tags, depends_on, tempered). Both helpers live in agent.js so
 * the agent stays single-file scp-able.
 *
 * This test covers the parser directly; the eligibility predicate is small
 * enough to test in place without round-tripping through the server's
 * `computeEligibility`.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_PATH = join(__dirname, '..', '..', 'agent.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agentMod: any;

beforeAll(async () => {
  agentMod = await import(AGENT_PATH);
});

import { beforeAll } from 'vitest';

describe('agent: parseFiberFrontmatter', () => {
  it('reads inline-list tags', () => {
    const fm = agentMod.parseFiberFrontmatter(
      `---\nname: x\ntags: [constitution, draft]\nstatus: active\n---\nbody\n`,
    );
    expect(fm.tags).toEqual(['constitution', 'draft']);
    expect(fm.status).toBe('active');
  });

  it('reads block-list tags', () => {
    const fm = agentMod.parseFiberFrontmatter(
      [
        '---',
        'name: x',
        'tags:',
        '  - constitution',
        '  - portolan',
        'status: active',
        '---',
        '',
      ].join('\n'),
    );
    expect(fm.tags).toEqual(['constitution', 'portolan']);
  });

  it('reads inline depends_on and parses tempered as boolean', () => {
    const fm = agentMod.parseFiberFrontmatter(
      [
        '---',
        'name: x',
        'tags: [constitution]',
        'depends_on: [a, b]',
        'tempered: true',
        '---',
      ].join('\n'),
    );
    expect(fm.dependsOn).toEqual(['a', 'b']);
    expect(fm.tempered).toBe(true);
  });

  it('reads block-list depends_on', () => {
    const fm = agentMod.parseFiberFrontmatter(
      [
        '---',
        'tags: [constitution]',
        'depends_on:',
        '  - a',
        '  - "b/with/path"',
        '---',
      ].join('\n'),
    );
    expect(fm.dependsOn).toEqual(['a', 'b/with/path']);
  });

  it('returns null when there is no frontmatter', () => {
    expect(agentMod.parseFiberFrontmatter('# just markdown\n\n')).toBeNull();
  });

  it('returns sane defaults for fibers missing fields', () => {
    const fm = agentMod.parseFiberFrontmatter(`---\nname: x\n---\nbody\n`);
    expect(fm).toEqual({
      tags: [],
      dependsOn: [],
      status: undefined,
      tempered: undefined,
    });
  });
});

describe('agent: shuttleIdFromPath', () => {
  it('resolves entry-point fibers', () => {
    expect(agentMod.shuttleIdFromPath('cmbx.md')).toBe('cmbx');
  });

  it('resolves directory-shaped fibers', () => {
    expect(agentMod.shuttleIdFromPath('cmbx/cmbx.md')).toBe('cmbx');
  });

  it('resolves nested container fibers', () => {
    expect(agentMod.shuttleIdFromPath('ai-futures/portolan/portolan.md')).toBe(
      'ai-futures/portolan',
    );
  });

  it('returns null for non-container .md', () => {
    expect(agentMod.shuttleIdFromPath('cmbx/notes.md')).toBeNull();
    expect(agentMod.shuttleIdFromPath('foo.txt')).toBeNull();
  });
});

describe('agent: computeShuttleEligibility', () => {
  const fiber = (overrides: Record<string, unknown>) => ({
    id: 'foo',
    status: 'active',
    tags: [],
    dependsOn: [],
    tempered: undefined,
    ...overrides,
  });

  it('selects constitution-tagged, unblocked, non-closed fibers', () => {
    const fibers = [
      fiber({ id: 'a', tags: ['constitution'] }),
      fiber({ id: 'b', tags: ['constitution'], status: 'closed' }),
      fiber({ id: 'c', tags: ['decision'] }),
      fiber({ id: 'd', tags: ['constitution'], status: 'active' }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible.map((f: { id: string }) => f.id).sort()).toEqual(['a', 'd']);
    expect(blocked.map((b: { fiberId: string }) => b.fiberId)).toEqual(['b']);
  });

  it('excludes draft-tagged fibers', () => {
    const fibers = [
      fiber({ id: 'ready', tags: ['constitution'] }),
      fiber({ id: 'parked', tags: ['constitution', 'draft'] }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible.map((f: { id: string }) => f.id)).toEqual(['ready']);
    expect(blocked[0].fiberId).toBe('parked');
    expect(blocked[0].reason).toContain('draft');
  });

  it('blocks on unsatisfied depends_on', () => {
    const fibers = [
      fiber({ id: 'dep', tags: ['constitution'] }),
      fiber({ id: 'work', tags: ['constitution'], dependsOn: ['dep'] }),
    ];
    const r1 = agentMod.computeShuttleEligibility(fibers, []);
    expect(r1.eligible.map((f: { id: string }) => f.id)).toEqual(['dep']);
    expect(r1.blocked[0].reason).toContain('dep');

    fibers[0].tempered = true;
    const r2 = agentMod.computeShuttleEligibility(fibers, []);
    expect(r2.eligible.map((f: { id: string }) => f.id).sort()).toEqual(['dep', 'work']);
    expect(r2.blocked).toEqual([]);
  });

  it('respects prefix scoping', () => {
    const fibers = [
      fiber({ id: 'in-scope/work', tags: ['constitution'] }),
      fiber({ id: 'in-scope', tags: ['constitution'] }),
      fiber({ id: 'other/work', tags: ['constitution'] }),
    ];
    const { eligible } = agentMod.computeShuttleEligibility(fibers, ['in-scope']);
    expect(eligible.map((f: { id: string }) => f.id).sort()).toEqual([
      'in-scope',
      'in-scope/work',
    ]);
  });

  it('partial prefix does not bleed into unrelated paths', () => {
    const fibers = [
      fiber({ id: 'shuttle-tests/work', tags: ['constitution'] }),
      fiber({ id: 'shuttle/work', tags: ['constitution'] }),
    ];
    const { eligible } = agentMod.computeShuttleEligibility(fibers, ['shuttle']);
    expect(eligible.map((f: { id: string }) => f.id)).toEqual(['shuttle/work']);
  });

  it('treats missing depends-on target as unsatisfied', () => {
    const fibers = [
      fiber({ id: 'orphan', tags: ['constitution'], dependsOn: ['ghost'] }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible).toEqual([]);
    expect(blocked[0].reason).toContain('ghost');
  });
});
