import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { countOpenFibers, mapFeltJsonToFiber } from '../FiberReader.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Helper: create a directory-based fiber (slug/slug.md) */
function writeFiber(feltDir: string, slug: string, content: string) {
  const dir = join(feltDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content);
}

describe('FiberReader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `fiber-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('countOpenFibers', () => {
    it('should return 0 when .felt directory does not exist', async () => {
      const count = await countOpenFibers(testDir);
      expect(count).toBe(0);
    });

    it('should return 0 when .felt directory is empty', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(0);
    });

    it('should count fibers with status !== "closed"', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'fiber1', `---
status: open
kind: task
---
# Open fiber
`);

      writeFiber(feltDir, 'fiber2', `---
status: closed
kind: task
---
# Closed fiber
`);

      writeFiber(feltDir, 'fiber3', `---
status: active
kind: decision
---
# Active fiber
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(2); // fiber1 and fiber3
    });

    it('should count fibers without status field as open', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'no-status', `---
kind: task
---
# No status field
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should skip fibers without frontmatter (felt semantics)', async () => {
      // Pre felt-mediated reads, FiberReader's permissive walker included
      // bare markdown files as fibers with empty status. felt-mediated
      // reads now apply felt's stricter rule: a fiber file must start
      // with `---` frontmatter, otherwise felt warns and excludes it. The
      // reader inherits this — there's no longer a path that surfaces
      // partially-formed fibers, which is the right contract: anything
      // that doesn't parse cleanly should be visible to felt check, not
      // silently included in counts.
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'no-frontmatter', `# Just content, no frontmatter
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(0);
    });

    it('should ignore non-fiber directories and loose files', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'real-fiber', `---
status: open
---
# Real fiber
`);

      // Loose file (not in a directory) — should be ignored
      writeFileSync(join(feltDir, 'myst.yml'), 'version: 1');

      // Directory without matching slug.md — should be ignored
      mkdirSync(join(feltDir, 'empty-dir'));

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should handle various status values', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      const statuses = ['open', 'active', 'pending', 'blocked', 'closed', 'done'];

      statuses.forEach((status, i) => {
        writeFiber(feltDir, `fiber${i}`, `---
status: ${status}
---
# Fiber ${i}
`);
      });

      const count = await countOpenFibers(testDir);
      // Only 'closed' is not counted
      expect(count).toBe(5);
    });

    it('should handle malformed YAML gracefully', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'valid', `---
status: open
---
# Valid
`);

      writeFiber(feltDir, 'malformed', `---
status: open
badly: [formatted: yaml
---
# Malformed
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('should handle status with quotes', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'quoted', `---
status: "open"
---
# Quoted status
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should treat quoted "closed" as closed, not open', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'quoted-closed', `---
status: "closed"
---
# Quoted closed status
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(0);
    });

    it('should handle status with extra whitespace', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'whitespace', `---
status:   open
---
# Extra whitespace
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should handle multiple frontmatter delimiters', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFiber(feltDir, 'multi', `---
status: open
---
# Content

---
Not frontmatter
---
`);

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });
  });

  describe('mapFeltJsonToFiber', () => {
    it('reads bare-string depends_on (legacy fiber shape)', () => {
      const fiber = mapFeltJsonToFiber({
        id: 'work',
        status: 'open',
        depends_on: ['upstream-a', 'upstream-b'],
      });
      expect(fiber?.dependsOn).toEqual(['upstream-a', 'upstream-b']);
    });

    it('extracts .id from object-shape depends_on (felt JSON shape)', () => {
      // felt ships depends_on as `[{id: "..."}]` for fibers built from
      // wikilink references. The reader must accept this shape;
      // dropping it silently broke kanban dependsOnSatisfied.
      const fiber = mapFeltJsonToFiber({
        id: 'work',
        status: 'open',
        depends_on: [{ id: 'upstream-a' }, { id: 'upstream-b' }],
      });
      expect(fiber?.dependsOn).toEqual(['upstream-a', 'upstream-b']);
    });

    it('tolerates mixed string + object depends_on', () => {
      const fiber = mapFeltJsonToFiber({
        id: 'work',
        status: 'open',
        depends_on: ['plain', { id: 'objectified' }],
      });
      expect(fiber?.dependsOn).toEqual(['plain', 'objectified']);
    });

    it('returns dependsOn=undefined when depends_on is empty or missing', () => {
      expect(mapFeltJsonToFiber({ id: 'a', status: 'open' })?.dependsOn).toBeUndefined();
      expect(
        mapFeltJsonToFiber({ id: 'a', status: 'open', depends_on: [] })?.dependsOn,
      ).toBeUndefined();
    });
  });
});
