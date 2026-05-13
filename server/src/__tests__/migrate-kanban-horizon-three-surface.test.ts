/**
 * Tests for scripts/migrate-kanban-horizon-three-surface.ts
 *
 * The migration is the load-bearing step for the kanban three-surface
 * cutover: it's the only thing standing between fibers filed under the
 * 4-row horizons schema (`later`/`someday`) and the narrowed schema this
 * constitution lands. Idempotency matters because the script can be
 * re-run safely after partial rollouts, and because a second pass over
 * already-stashed fibers should not stack duplicate `cold:` keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import YAML from 'yaml';
import {
  rewriteHorizonAndCold,
  walkMarkdown,
} from '../../../scripts/migrate-kanban-horizon-three-surface.js';

const TEST_DIR = join(homedir(), '.portolan-test-kanban-migration');

function fmFor(file: string): Record<string, unknown> {
  const raw = readFileSync(file, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`no frontmatter in ${file}`);
  return YAML.parse(match[1]) as Record<string, unknown>;
}

describe('rewriteHorizonAndCold', () => {
  it('rewrites horizon: later → horizon: stashed', () => {
    const raw = '---\nname: X\nhorizon: later\n---\n\nbody.\n';
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('migrated');
    expect(res.after).toContain('horizon: stashed');
    expect(res.after).not.toContain('horizon: later');
    expect(res.after).not.toContain('cold:');
  });

  it('rewrites horizon: someday → horizon: stashed + cold: true', () => {
    const raw = '---\nname: X\nhorizon: someday\n---\n\nbody.\n';
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('migrated');
    expect(res.after).toContain('horizon: stashed');
    expect(res.after).toContain('cold: true');
  });

  it('leaves horizon: now / soon / stashed alone', () => {
    for (const horizon of ['now', 'soon', 'stashed']) {
      const raw = `---\nname: X\nhorizon: ${horizon}\n---\n\nbody.\n`;
      const res = rewriteHorizonAndCold(raw);
      expect(res.kind).toBe('unchanged');
    }
  });

  it('leaves fibers without a horizon field alone', () => {
    const raw = '---\nname: X\nstatus: open\n---\n\nbody.\n';
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('unchanged');
  });

  it('is idempotent: someday → stashed/cold and re-runs are no-ops', () => {
    const raw = '---\nname: X\nhorizon: someday\n---\n\nbody.\n';
    const first = rewriteHorizonAndCold(raw);
    expect(first.kind).toBe('migrated');
    const second = rewriteHorizonAndCold(first.after!);
    expect(second.kind).toBe('unchanged');
  });

  it('does not stack duplicate cold: entries when cold is already true', () => {
    // A user might hand-set cold: true on a someday fiber before the
    // migration runs; the script should rewrite horizon and leave cold alone.
    const raw = '---\nname: X\nhorizon: someday\ncold: true\n---\n\nbody.\n';
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('migrated');
    expect(res.after).toContain('horizon: stashed');
    // Exactly one cold: line.
    expect(res.after!.match(/^cold:/gm)?.length).toBe(1);
  });

  it('preserves unrelated frontmatter keys and body bytes', () => {
    const raw =
      '---\nname: X\nstatus: open\nhorizon: later\ntags:\n  - constitution\n---\n\n# Heading\n\nText.\n';
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('migrated');
    expect(res.after).toContain('name: X');
    expect(res.after).toContain('status: open');
    expect(res.after).toContain('tags:');
    expect(res.after).toContain('  - constitution');
    expect(res.after).toContain('# Heading');
    expect(res.after).toContain('Text.');
  });

  it('rewrites quoted horizon values', () => {
    const raw = "---\nhorizon: 'someday'\n---\n\nbody.\n";
    const res = rewriteHorizonAndCold(raw);
    expect(res.kind).toBe('migrated');
    expect(res.after).toContain('horizon: stashed');
    expect(res.after).toContain('cold: true');
  });
});

describe('migration script end-to-end on a tmp felt store', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function fib(slug: string, frontmatter: Record<string, unknown>): string {
    const dir = join(TEST_DIR, slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${slug}.md`);
    const yaml = YAML.stringify(frontmatter).trimEnd();
    writeFileSync(path, `---\n${yaml}\n---\n\n# ${slug}\n`, 'utf-8');
    return path;
  }

  it('walkMarkdown picks up nested fibers and ignores hidden subdirs', () => {
    const a = fib('alpha', { name: 'Alpha', horizon: 'later' });
    const b = fib('beta', { name: 'Beta', horizon: 'soon' });
    // A nested .felt-like directory under a fiber should still be walked.
    mkdirSync(join(TEST_DIR, '.git'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.git', 'config'), 'noop', 'utf-8');
    const files = walkMarkdown(TEST_DIR);
    expect(files.sort()).toEqual([a, b].sort());
  });

  it('rewriting + reading back yields the new schema; second pass is no-op', () => {
    fib('later-fib', { name: 'Later', status: 'active', horizon: 'later' });
    fib('someday-fib', { name: 'Someday', status: 'active', horizon: 'someday' });
    fib('now-fib', { name: 'Now', status: 'active', horizon: 'now' });

    const files = walkMarkdown(TEST_DIR);
    for (const f of files) {
      const raw = readFileSync(f, 'utf-8');
      const res = rewriteHorizonAndCold(raw);
      if (res.kind === 'migrated') writeFileSync(f, res.after!, 'utf-8');
    }

    expect(fmFor(join(TEST_DIR, 'later-fib', 'later-fib.md'))).toMatchObject({
      horizon: 'stashed',
    });
    expect(fmFor(join(TEST_DIR, 'later-fib', 'later-fib.md'))).not.toHaveProperty('cold');

    expect(fmFor(join(TEST_DIR, 'someday-fib', 'someday-fib.md'))).toMatchObject({
      horizon: 'stashed',
      cold: true,
    });

    expect(fmFor(join(TEST_DIR, 'now-fib', 'now-fib.md'))).toMatchObject({
      horizon: 'now',
    });

    // Re-run: every file should now be unchanged.
    for (const f of files) {
      const raw = readFileSync(f, 'utf-8');
      const res = rewriteHorizonAndCold(raw);
      expect(res.kind).toBe('unchanged');
    }
  });
});
