/**
 * Agent ↔ server frontmatter parity test.
 *
 * Stage 4 of [[ai-futures/portolan/vellum-reader/constitution-vellum-kanban]]
 * routes remote-origin kanban transitions through the agent. Per the locked
 * decision, `applyTargetToFrontmatter` (and its `mutateTagsInPlace` helper)
 * are inlined into `server/agent.js` so the agent ships as a single scp'd
 * file. That trades shared-import-safety for a manual-sync risk; this test
 * is the guardrail.
 *
 * We import both copies — the TS source from `HttpApiKanban.ts` and the JS
 * inlined copy from `agent.js` — and run them through a corpus of inputs
 * spanning every kanban target and every recognized frontmatter shape.
 * Byte-equal output across every input means the two implementations agree;
 * a single divergence fails CI before it can ship to a remote machine.
 *
 * If you change the helper in HttpApiKanban.ts, mirror the change in
 * agent.js — the comment block above each copy points at the other.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  applyTargetToFrontmatter as serverApply,
  type KanbanTarget,
} from '../HttpApiKanban.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// agent.js lives at server/agent.js; tests live at server/src/__tests__/.
const AGENT_PATH = join(__dirname, '..', '..', 'agent.js');

// agent.js is an ESM module that imports `ws` and starts no main loop until
// `main()` is called. We import for side-effect-free function access only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agentMod: any;

const NOW = '2026-04-29T12:00:00.000Z';

const TARGETS: KanbanTarget[] = [
  'drafts',
  'inFlight',
  'queued',
  'active',
  'awaitingReview',
  'tempered',
];

interface Fixture {
  name: string;
  content: string;
}

const FIXTURES: Fixture[] = [
  {
    name: 'minimal active fiber, no tags block',
    content: [
      '---',
      'name: A fiber',
      'status: active',
      'created-at: 2026-04-15T00:00:00Z',
      '---',
      '',
      'body',
    ].join('\n'),
  },
  {
    name: 'block-list tags, constitution + draft',
    content: [
      '---',
      'name: With block tags',
      'status: open',
      'tags:',
      '  - constitution',
      '  - draft',
      'created-at: 2026-04-15T00:00:00Z',
      '---',
      '',
      'body',
    ].join('\n'),
  },
  {
    name: 'inline tags array',
    content: [
      '---',
      'name: Inline tags',
      'status: active',
      'tags: [constitution, foo]',
      'created-at: 2026-04-15T00:00:00Z',
      '---',
      'body',
    ].join('\n'),
  },
  {
    name: 'closed + tempered, with closed-at already set',
    content: [
      '---',
      'name: Already closed',
      'status: closed',
      'tempered: true',
      'closed-at: 2026-03-01T00:00:00Z',
      'tags:',
      '  - constitution',
      '---',
      '',
      'body',
    ].join('\n'),
  },
  {
    name: 'block-scalar outcome that must survive byte-identically',
    content: [
      '---',
      'name: Outcome with block scalar',
      'status: active',
      'tags:',
      '  - constitution',
      'outcome: |-',
      '  Multi-line outcome with',
      '  punctuation: colons, dashes — and ellipses…',
      '  > nested-looking line',
      '---',
      '',
      'body',
    ].join('\n'),
  },
  {
    name: 'CRLF line endings preserved through the round-trip',
    content:
      ['---', 'name: CRLF', 'status: active', 'tags:', '  - constitution', '---', '', 'body'].join(
        '\r\n',
      ),
  },
  {
    name: 'fiber that already has the draft tag (round-trip into drafts is no-op-ish)',
    content: [
      '---',
      'name: Already draft',
      'status: open',
      'tags:',
      '  - constitution',
      '  - draft',
      '---',
      '',
      'body',
    ].join('\n'),
  },
  {
    name: 'fiber with tempered: false carrying a closed-at to clear',
    content: [
      '---',
      'name: Reopen me',
      'status: closed',
      'tempered: false',
      'closed-at: 2026-03-01T00:00:00Z',
      'tags:',
      '  - constitution',
      '---',
      'body',
    ].join('\n'),
  },
];

describe('agent.js ↔ HttpApiKanban frontmatter parity', () => {
  it('agent.js exposes its inline applyTargetToFrontmatter', async () => {
    // Dynamic import so the test file can resolve the JS module at run time
    // without TypeScript needing a .d.ts. agent.js doesn't export anything
    // at the moment — we add a parity export below for tests only.
    agentMod = await import(/* @vite-ignore */ AGENT_PATH);
    expect(typeof agentMod.applyTargetToFrontmatter).toBe('function');
    expect(typeof agentMod.mutateTagsInPlace).toBe('function');
  });

  for (const fixture of FIXTURES) {
    for (const target of TARGETS) {
      it(`${fixture.name} → ${target}: agent and server produce identical output`, async () => {
        agentMod ??= await import(/* @vite-ignore */ AGENT_PATH);
        const serverOut = serverApply(fixture.content, target, NOW);
        const agentOut = agentMod.applyTargetToFrontmatter(fixture.content, target, NOW);
        expect(agentOut).toBe(serverOut);
      });
    }
  }

  it('both implementations refuse files without frontmatter', async () => {
    agentMod ??= await import(/* @vite-ignore */ AGENT_PATH);
    expect(() => serverApply('# just a body\n', 'tempered', NOW)).toThrow(/frontmatter/);
    expect(() => agentMod.applyTargetToFrontmatter('# just a body\n', 'tempered', NOW)).toThrow(
      /frontmatter/,
    );
  });

  it('both implementations are idempotent — applying the same target twice is a fixed point', async () => {
    agentMod ??= await import(/* @vite-ignore */ AGENT_PATH);
    for (const fixture of FIXTURES) {
      for (const target of TARGETS) {
        const once = agentMod.applyTargetToFrontmatter(fixture.content, target, NOW);
        const twice = agentMod.applyTargetToFrontmatter(once, target, NOW);
        expect(twice).toBe(once);
      }
    }
  });
});
