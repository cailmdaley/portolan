/**
 * loomGlobalId tests — fiber id resolution under the loom monorepo's two
 * symlink topologies.
 *
 * Topology A (the common case): the loom contains an inbound symlink whose
 * target lives under the loom's own .felt tree. e.g.
 *   ~/loom/.felt/ai-futures/portolan/  →  realpath under ~/loom/.felt
 * The project mounts its `.felt/` as that subdirectory, so
 * realpath(cityPath/.felt) is under loomFelt and the relative-path math
 * yields a clean prefix.
 *
 * Topology B (outbound symlink, the wedding case): the loom has a top-level
 * symlink whose target lives *outside* the loom — typically because the
 * project's `.felt/` is in iCloud or another monorepo with its own remote.
 *   ~/loom/.felt/wedding  →  /Users/.../iCloud/.../wedding/.felt
 * realpath(cityPath/.felt) returns the absolute external path, the
 * relative-path math goes through `..`, and we have to find the symlink
 * by walking loomFelt's top-level entries.
 *
 * Pre-fix the outbound case fell back to the bare slug, which then failed
 * downstream in `shuttle-ctl install` (felt ls couldn't resolve the slug
 * from LOOM_HOME). This test pins the corrected behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveGlobalFiberId } from '../loomGlobalId.js';

let workRoot: string;
let originalLoomHome: string | undefined;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'loom-global-id-'));
  originalLoomHome = process.env.LOOM_HOME;
});

afterEach(() => {
  if (originalLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = originalLoomHome;
  rmSync(workRoot, { recursive: true, force: true });
});

describe('resolveGlobalFiberId', () => {
  it('returns slug unchanged when project IS the loom', () => {
    const loomHome = join(workRoot, 'loom');
    mkdirSync(join(loomHome, '.felt'), { recursive: true });
    process.env.LOOM_HOME = loomHome;

    expect(resolveGlobalFiberId(loomHome, 'some-fiber')).toBe('some-fiber');
  });

  it('prefixes nested slug for inbound-symlinked project (common case)', () => {
    // Topology A: project's .felt is a symlink whose target lives under loom.
    // Mirrors how portolan's .felt is symlinked into ~/loom/.felt/ai-futures/portolan.
    const loomHome = join(workRoot, 'loom');
    const loomFelt = join(loomHome, '.felt');
    const projectDir = join(workRoot, 'projects', 'portolan');
    const targetUnderLoom = join(loomFelt, 'ai-futures', 'portolan');
    mkdirSync(targetUnderLoom, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    symlinkSync(targetUnderLoom, join(projectDir, '.felt'));
    process.env.LOOM_HOME = loomHome;

    expect(resolveGlobalFiberId(projectDir, 'my-fiber')).toBe(
      'ai-futures/portolan/my-fiber',
    );
  });

  it('resolves outbound-symlinked project via top-level loom-symlink scan (wedding case)', () => {
    // Topology B: the loom has a symlink at its top level whose target is
    // outside the loom. realpath math goes through `..`, but the loom does
    // know the project — by the symlink's name.
    const loomHome = join(workRoot, 'loom');
    const loomFelt = join(loomHome, '.felt');
    mkdirSync(loomFelt, { recursive: true });
    const externalProject = join(workRoot, 'icloud-mirror', 'wedding');
    const externalFelt = join(externalProject, '.felt');
    mkdirSync(externalFelt, { recursive: true });
    // Project-side: a fiber file (not strictly needed for the resolver, but
    // makes the topology realistic).
    writeFileSync(
      join(externalFelt, 'dj-rico-contract.md'),
      '---\nname: dj rico contract\n---\n',
    );
    // Loom-side: outbound symlink pointing to the external project's .felt.
    symlinkSync(externalFelt, join(loomFelt, 'wedding'));
    process.env.LOOM_HOME = loomHome;

    expect(resolveGlobalFiberId(externalProject, 'dj-rico-contract')).toBe(
      'wedding/dj-rico-contract',
    );
  });

  it('falls back to bare slug when project lives outside loom with no symlink', () => {
    // Pathological: project isn't reachable from loom at all. We can't help
    // shuttle-ctl resolve this; pass the slug through and let it fail loudly.
    const loomHome = join(workRoot, 'loom');
    mkdirSync(join(loomHome, '.felt'), { recursive: true });
    const orphan = join(workRoot, 'orphan');
    mkdirSync(join(orphan, '.felt'), { recursive: true });
    process.env.LOOM_HOME = loomHome;

    expect(resolveGlobalFiberId(orphan, 'orphan-slug')).toBe('orphan-slug');
  });

  it('falls back to slug when cityPath/.felt does not exist', () => {
    const loomHome = join(workRoot, 'loom');
    mkdirSync(join(loomHome, '.felt'), { recursive: true });
    process.env.LOOM_HOME = loomHome;

    expect(
      resolveGlobalFiberId(join(workRoot, 'no-such-city'), 'whatever'),
    ).toBe('whatever');
  });
});
