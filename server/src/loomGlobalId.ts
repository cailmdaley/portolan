/**
 * Resolve a project-local fiber id to a loom-global id for shuttle-ctl calls.
 *
 * shuttle-ctl resolves fibers relative to LOOM_HOME/.felt/ (the global loom).
 * Most cities expose their `.felt/` to the loom by symlinking *into* the
 * loom (e.g. `~/loom/.felt/portolan` is itself a symlink whose target is
 * `~/Documents/projects/portolan/.felt`). For those, the global prefix is
 * the relative path from `loomFelt` to the realpath of `cityPath/.felt`.
 *
 * Some cities live *outside* the loom and are reachable only via an outbound
 * symlink at the top of `loomFelt` (e.g. `~/loom/.felt/wedding -> /Users/.../iCloud/.../wedding/.felt`).
 * For those, `realpathSync` resolves to a path outside `loomFelt`, the
 * relative-path math goes through `..`, and we have to find the symlink
 * by name instead — scan `loomFelt`'s top-level entries for a symlink whose
 * realpath matches `projectFelt`, and use that link's name as the prefix.
 *
 * Falls back to the bare slug when neither resolution succeeds; shuttle-ctl
 * will then try its own `felt ls -j` fallback (which has its own slug-vs-name
 * matching limitations — see gotcha-shuttle-install-slug-resolution).
 */

import { readdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, relative } from 'path';

function getLoomPaths(): { loomHome: string; loomFelt: string } {
  const loomHome = process.env.LOOM_HOME || join(homedir(), 'loom');
  return { loomHome, loomFelt: join(loomHome, '.felt') };
}

/**
 * Walk the top-level entries of `loomFelt` and build a map from each
 * symlink target's realpath to the symlink's name. Used to resolve
 * outbound-symlinked projects (the wedding case).
 *
 * Computed per-call rather than cached because the loom directory is small
 * (tens of entries) and stashing only happens on user action — caching would
 * just risk staleness when a new symlink is added.
 */
function buildOutboundSymlinkMap(loomFelt: string): Map<string, string> {
  const map = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(loomFelt);
  } catch {
    return map;
  }
  for (const name of entries) {
    const entryPath = join(loomFelt, name);
    try {
      const real = realpathSync(entryPath);
      if (real !== entryPath) {
        map.set(real, name);
      }
    } catch {
      // Broken symlink or permission denied — skip.
    }
  }
  return map;
}

/**
 * Resolve a project-local slug to its loom-global id (e.g. `wedding/dj-rico-contract`).
 * See module docstring for the two resolution paths.
 */
export function resolveGlobalFiberId(cityPath: string, localSlug: string): string {
  const { loomFelt } = getLoomPaths();
  // Realpath both sides so symlinks anywhere in the prefix (notably macOS's
  // /var → /private/var) don't poison the relative-path math.
  let loomFeltReal: string;
  try {
    loomFeltReal = realpathSync(loomFelt);
  } catch {
    loomFeltReal = loomFelt;
  }
  let projectFelt: string;
  try {
    projectFelt = realpathSync(join(cityPath, '.felt'));
  } catch {
    return localSlug;
  }

  // Path 1: project sits under the loom (the common case). The project's
  // realpath either IS loomFelt or lives under it.
  const prefix = relative(loomFeltReal, projectFelt);
  if (!prefix) return localSlug;
  if (!prefix.startsWith('..')) return `${prefix}/${localSlug}`;

  // Path 2: project lives outside the loom, reachable via an outbound
  // symlink at the top of loomFelt. Find that symlink by realpath.
  const outboundName = buildOutboundSymlinkMap(loomFelt).get(projectFelt);
  if (outboundName) return `${outboundName}/${localSlug}`;

  // No resolution — let the bare slug propagate. shuttle-ctl will fail
  // explicitly rather than silently mis-installing.
  return localSlug;
}
