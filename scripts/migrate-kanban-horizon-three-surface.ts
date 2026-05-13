#!/usr/bin/env npx tsx
/**
 * migrate-kanban-horizon-three-surface.ts
 *
 * One-time schema migration for the three-surface kanban
 * (see [[ai-futures/portolan/constitution-kanban-three-surfaces]]):
 *
 *   horizon: later   → horizon: stashed                (cold defaults to false)
 *   horizon: someday → horizon: stashed, cold: true
 *
 * Walks every `.md` under one or more felt-store roots (defaults to
 * `~/loom/.felt` and the lightcone repo's `.felt`, which is loom's only
 * symlinked-in monorepo), parses the YAML frontmatter, and rewrites the
 * `horizon:` line in place when needed. Idempotent — a second run is a
 * no-op. Preserves frontmatter byte layout outside the touched lines.
 *
 * Usage:
 *   npx tsx scripts/migrate-kanban-horizon-three-surface.ts          # writes
 *   npx tsx scripts/migrate-kanban-horizon-three-surface.ts --dry-run
 *   npx tsx scripts/migrate-kanban-horizon-three-surface.ts <root> [<root> …]
 *
 * The script logs the diff for every fiber it would rewrite, and counts
 * total / migrated / already-correct at the end. Exit code 0 always
 * (idempotent passes are not errors). Run before deploying the
 * three-surface backend; once the type union narrows to
 * `now | soon | stashed`, fibers carrying `later` / `someday` will be
 * dropped to `effectiveHorizon: 'now'` by the parser and lose their
 * intended placement.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_ROOTS: readonly string[] = [
  join(homedir(), 'loom', '.felt'),
  join(homedir(), 'Documents', 'projects', 'LightconeResearch', 'lightcone', '.felt'),
];

interface Args {
  dryRun: boolean;
  roots: string[];
}

interface RewriteResult {
  kind: 'unchanged' | 'migrated';
  before?: string;
  after?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, roots: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: ${argv[1]} [--dry-run] [<root> …]`);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    } else out.roots.push(arg);
  }
  if (out.roots.length === 0) {
    for (const candidate of DEFAULT_ROOTS) {
      if (existsSync(candidate)) out.roots.push(candidate);
    }
  }
  return out;
}

/** Rewrite a single top-level frontmatter key. Returns the new line list,
 *  or null when the key is absent. Preserves indentation/whitespace around
 *  unrelated keys (we only touch the matched line). */
function rewriteHorizonAndCold(raw: string): RewriteResult {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!match) return { kind: 'unchanged' };

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const closingNewline = match[2] ?? '';
  const fmBlock = match[1];
  const body = raw.slice(match[0].length);
  const lines = fmBlock.length > 0 ? fmBlock.split(/\r?\n/) : [];

  // Find the top-level horizon: line. (Nested keys inside a block scalar
  // start with whitespace; we only match leading-anchor.)
  const horizonIdx = lines.findIndex((line) => /^horizon\s*:/.test(line));
  if (horizonIdx === -1) return { kind: 'unchanged' };

  const horizonLine = lines[horizonIdx];
  const valueMatch = horizonLine.match(/^horizon\s*:\s*(.*?)\s*$/);
  if (!valueMatch) return { kind: 'unchanged' };
  const value = valueMatch[1].replace(/^['"]|['"]$/g, '').trim();
  if (value !== 'later' && value !== 'someday') return { kind: 'unchanged' };

  // Compute the rewrite. someday → stashed + cold: true (someday is the
  // long-deferred "held-open" cluster). later → just stashed.
  const newHorizon = 'stashed';
  const newCold = value === 'someday';

  // Replace the horizon line in place.
  lines[horizonIdx] = `horizon: ${newHorizon}`;

  // Add `cold: true` only when this value calls for it AND it isn't already
  // present. (Re-running the migration on someday → stashed/cold:true would
  // otherwise stack a second cold entry.)
  if (newCold) {
    const coldIdx = lines.findIndex((line) => /^cold\s*:/.test(line));
    if (coldIdx === -1) {
      // Insert immediately after horizon so the two-line pair travels together.
      lines.splice(horizonIdx + 1, 0, 'cold: true');
    } else {
      lines[coldIdx] = 'cold: true';
    }
  }

  const after = `---${eol}${lines.join(eol)}${eol}---${closingNewline}${body}`;
  return { kind: 'migrated', before: raw, after };
}

function walkMarkdown(root: string): string[] {
  const acc: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Don't recurse into hidden subdirs, but the `.felt` root itself is
      // the entry point.
      if (entry.startsWith('.') && dir !== root) continue;
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(full);
      else if (s.isFile() && entry.endsWith('.md')) acc.push(full);
    }
  }
  return acc;
}

async function main(): Promise<void> {
  const { dryRun, roots } = parseArgs(process.argv.slice(2));
  if (roots.length === 0) {
    console.error('No felt-store roots found (tried defaults; pass paths as arguments).');
    process.exit(1);
  }

  console.log(`Migrating horizon: later/someday → stashed (+cold: true for someday)`);
  console.log(`Roots: ${roots.join(', ')}`);
  console.log(dryRun ? '(dry-run — no files will be written)' : '');

  let scanned = 0;
  let migrated = 0;
  const failures: { path: string; err: string }[] = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      console.warn(`  skip (missing): ${root}`);
      continue;
    }
    const files = walkMarkdown(root);
    for (const path of files) {
      scanned += 1;
      let raw: string;
      try {
        raw = await readFile(path, 'utf-8');
      } catch (err) {
        failures.push({ path, err: (err as Error).message });
        continue;
      }
      const result = rewriteHorizonAndCold(raw);
      if (result.kind === 'unchanged') continue;
      migrated += 1;
      console.log(`  → ${path}`);
      console.log(diffSummary(result.before!, result.after!));
      if (!dryRun) {
        try {
          await writeFile(path, result.after!, 'utf-8');
        } catch (err) {
          failures.push({ path, err: (err as Error).message });
        }
      }
    }
  }

  console.log('');
  console.log(`Scanned: ${scanned} markdown files`);
  console.log(`Rewritten: ${migrated}${dryRun ? ' (dry-run; no writes)' : ''}`);
  if (failures.length > 0) {
    console.error(`Failures: ${failures.length}`);
    for (const f of failures) console.error(`  ${f.path}: ${f.err}`);
    process.exit(1);
  }
}

function diffSummary(before: string, after: string): string {
  // Lightweight: show only the lines that changed between before and
  // after's frontmatter. Operating on the touched frontmatter is enough
  // for the migration log; we don't need full diff machinery.
  const beforeFm = before.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const afterFm = after.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const beforeLines = beforeFm.split(/\r?\n/);
  const afterLines = afterFm.split(/\r?\n/);
  const out: string[] = [];
  const all = new Set([...beforeLines, ...afterLines]);
  for (const line of all) {
    if (!beforeLines.includes(line)) out.push(`    + ${line}`);
    else if (!afterLines.includes(line)) out.push(`    - ${line}`);
  }
  return out.join('\n');
}

// Allow re-use from tests; only run main() when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { rewriteHorizonAndCold, walkMarkdown };
