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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ServerResponse } from 'http';
import { HttpApiKanban } from '../HttpApiKanban.js';

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
    } else {
      fmLines.push(`${k}: ${v}`);
    }
  }
  const content = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
  writeFileSync(join(dir, `${basename}.md`), content, 'utf-8');
}

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
    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual({ inFlight: [], awaitingReview: [], tempered: [] });
    expect(res.body.totals).toEqual({ inFlight: 0, awaitingReview: 0, tempered: 0 });
  });

  it('skips fibers that are not constitution-tagged', async () => {
    writeFib('regular-task', { name: 'Task', status: 'open', tags: ['task'], 'created-at': '2026-04-01' });
    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);
    expect(res.body.totals).toEqual({ inFlight: 0, awaitingReview: 0, tempered: 0 });
  });

  it('groups constitution fibers into in-flight / awaiting-review / tempered', async () => {
    writeFib('open-one', {
      name: 'Open one',
      status: 'open',
      tags: ['constitution'],
      'created-at': '2026-04-10',
    });
    writeFib('active-one', {
      name: 'Active one',
      status: 'active',
      tags: ['constitution'],
      'created-at': '2026-04-11',
    });
    writeFib('awaiting', {
      name: 'Awaiting',
      status: 'closed',
      tags: ['constitution'],
      'created-at': '2026-04-01',
      'closed-at': '2026-04-12',
    });
    writeFib('tempered-one', {
      name: 'Tempered',
      status: 'closed',
      tempered: 'true',
      tags: ['constitution'],
      'created-at': '2026-04-02',
      'closed-at': '2026-04-13',
    });

    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ inFlight: 2, awaitingReview: 1, tempered: 1 });
    expect(res.body.columns.inFlight.map((c: any) => c.id).sort()).toEqual(['active-one', 'open-one']);
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['awaiting']);
    expect(res.body.columns.tempered.map((c: any) => c.id)).toEqual(['tempered-one']);
  });

  it('sorts in-flight by createdAt desc and awaiting-review by closedAt desc', async () => {
    // Three in-flight, increasing creation order; should come back in reverse.
    writeFib('a', { name: 'A', status: 'open', tags: ['constitution'], 'created-at': '2026-04-01' });
    writeFib('b', { name: 'B', status: 'open', tags: ['constitution'], 'created-at': '2026-04-02' });
    writeFib('c', { name: 'C', status: 'open', tags: ['constitution'], 'created-at': '2026-04-03' });
    // Three awaiting, increasing close order; reverse expected.
    writeFib('x', { name: 'X', status: 'closed', tags: ['constitution'], 'created-at': '2026-04-01', 'closed-at': '2026-04-04' });
    writeFib('y', { name: 'Y', status: 'closed', tags: ['constitution'], 'created-at': '2026-04-01', 'closed-at': '2026-04-05' });
    writeFib('z', { name: 'Z', status: 'closed', tags: ['constitution'], 'created-at': '2026-04-01', 'closed-at': '2026-04-06' });

    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    expect(res.body.columns.inFlight.map((c: any) => c.id)).toEqual(['c', 'b', 'a']);
    expect(res.body.columns.awaitingReview.map((c: any) => c.id)).toEqual(['z', 'y', 'x']);
  });

  it('marks dependsOnSatisfied=false when a depends_on target is not tempered', async () => {
    writeFib('upstream', {
      name: 'Upstream',
      status: 'closed',
      tags: ['constitution'],
      'created-at': '2026-04-01',
      // not tempered
    });
    writeFib('downstream', {
      name: 'Downstream',
      status: 'open',
      tags: ['constitution'],
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
      tags: ['constitution'],
      'created-at': '2026-04-01',
    });
    writeFib('downstream', {
      name: 'Downstream',
      status: 'open',
      tags: ['constitution'],
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
      tags: ['constitution'],
      'created-at': '2026-04-01',
    });
    const api = new HttpApiKanban({ feltHost: TEST_DIR });
    const res = await callKanban(api);

    const child = res.body.columns.inFlight.find((c: any) => c.id === 'parent/child');
    expect(child).toBeTruthy();
    expect(child.path).toBe(join(TEST_DIR, '.felt', 'parent', 'child', 'child.md'));
  });

  it('honors temperedLimit and reports temperedTotal separately', async () => {
    for (let i = 0; i < 5; i++) {
      writeFib(`t${i}`, {
        name: `T${i}`,
        status: 'closed',
        tempered: 'true',
        tags: ['constitution'],
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
