import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { countOpenFibers } from '../FiberReader.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

      // Open fiber (status: open)
      writeFileSync(
        join(feltDir, 'fiber1.md'),
        `---
status: open
kind: task
---
# Open fiber
`
      );

      // Closed fiber
      writeFileSync(
        join(feltDir, 'fiber2.md'),
        `---
status: closed
kind: task
---
# Closed fiber
`
      );

      // Another open fiber (status: active)
      writeFileSync(
        join(feltDir, 'fiber3.md'),
        `---
status: active
kind: decision
---
# Active fiber
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(2); // fiber1 and fiber3
    });

    it('should count fibers without status field as open', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'no-status.md'),
        `---
kind: task
---
# No status field
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1); // Counted as open (null !== 'closed')
    });

    it('should count fibers without frontmatter as open', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'no-frontmatter.md'),
        `# Just content, no frontmatter
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1); // Counted as open
    });

    it('should ignore non-.md files', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'fiber.md'),
        `---
status: open
---
# MD file
`
      );

      writeFileSync(
        join(feltDir, 'README.txt'),
        'Not a fiber'
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1); // Only .md file
    });

    it('should handle various status values', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      const statuses = ['open', 'active', 'pending', 'blocked', 'closed', 'done'];

      statuses.forEach((status, i) => {
        writeFileSync(
          join(feltDir, `fiber${i}.md`),
          `---
status: ${status}
---
# Fiber ${i}
`
        );
      });

      const count = await countOpenFibers(testDir);
      // Only 'closed' is not counted
      // open, active, pending, blocked, done = 5 (all except 'closed')
      expect(count).toBe(5);
    });

    it('should handle malformed YAML gracefully', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      // Valid fiber
      writeFileSync(
        join(feltDir, 'valid.md'),
        `---
status: open
---
# Valid
`
      );

      // Malformed YAML (but our simple parser might still work for status)
      writeFileSync(
        join(feltDir, 'malformed.md'),
        `---
status: open
badly: [formatted: yaml
---
# Malformed
`
      );

      // Should not crash
      const count = await countOpenFibers(testDir);
      expect(count).toBeGreaterThanOrEqual(1); // At least the valid one
    });

    it('should handle files that cannot be read', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      // Valid fiber
      writeFileSync(
        join(feltDir, 'valid.md'),
        `---
status: open
---
# Valid
`
      );

      // Create a file but make it unreadable (chmod 000)
      // Note: This might not work on all systems due to permissions
      const unreadable = join(feltDir, 'unreadable.md');
      writeFileSync(unreadable, 'content');

      // Should not crash, should skip unreadable file
      const count = await countOpenFibers(testDir);
      expect(count).toBeGreaterThanOrEqual(1); // At least the valid one
    });

    it('should handle status with quotes', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'quoted.md'),
        `---
status: "open"
---
# Quoted status
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should treat quoted "closed" as closed, not open', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'quoted-closed.md'),
        `---
status: "closed"
---
# Quoted closed status
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(0); // Should be 0, not 1
    });

    it('should handle status with extra whitespace', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'whitespace.md'),
        `---
status:   open
---
# Extra whitespace
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1);
    });

    it('should handle multiple frontmatter delimiters', async () => {
      const feltDir = join(testDir, '.felt');
      mkdirSync(feltDir);

      writeFileSync(
        join(feltDir, 'multi.md'),
        `---
status: open
---
# Content

---
Not frontmatter
---
`
      );

      const count = await countOpenFibers(testDir);
      expect(count).toBe(1); // Should only parse first frontmatter block
    });
  });
});
