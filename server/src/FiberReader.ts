import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';

export interface Fiber {
  id: string;        // slug path under .felt/ — bare for top-level (`foo`) or
                     // slash-joined for nested (`foo/bar`). Matches what
                     // `felt ls --json` emits for nested fibers.
  name: string;      // frontmatter `name:` (ASTRA vocabulary)
  status: string;    // open, active, closed
  kind: string;      // task, decision, question, spec
  priority: number;  // default 2
  createdAt: string; // ISO date from frontmatter
  body?: string;     // markdown body after frontmatter
  outcome?: string;  // outcome from frontmatter
  closedAt?: string; // ISO date from frontmatter
  tags?: string[];   // e.g. ["tapestry:cosebis_data_vector"]
  dependsOn?: string[]; // fiber IDs this depends on
  tempered?: boolean;   // human-acceptance signal — agent never sets this itself; Shuttle reads it as the dependency-satisfied edge
  /** True when the fiber has a `shuttle:` frontmatter block. The dispatch signal lives here. */
  hasShuttleBlock?: boolean;
  parentId?: string | null; // parent fiber id (derived from slug path); null for top-level
  isRoot?: boolean;  // entry-point fiber: bare `.felt/<slug>.md` (appears via loom symlink)
}

// ── Internal ───────────────────────────────────────────────────────

/**
 * Read and parse all directory-based fibers in a city's .felt/ directory.
 * Each fiber is a directory containing `<slug>/<slug>.md`.
 * All public functions delegate to this, then filter/sort as needed.
 */
async function readAllFibers(cityPath: string): Promise<Fiber[]> {
  const feltPath = join(cityPath, '.felt');

  if (!existsSync(feltPath)) {
    return [];
  }

  const fibers: Fiber[] = [];
  try {
    await walkFibers(feltPath, feltPath, [], fibers);
  } catch (err) {
    console.warn(`Failed to read .felt directory at ${feltPath}:`, err);
    return [];
  }
  return fibers;
}

/**
 * Recursively walk `.felt/` collecting fibers. Recognizes two shapes:
 *   - Entry-point (root) fiber: bare `.felt/<slug>.md` at the root. Appears
 *     via the loom symlink — the outer `<project>/` directory gets consumed
 *     by the symlink, leaving the container file bare at `.felt/` root.
 *   - Directory-based fiber: `<dir>/<dir>.md`. A container fiber sits
 *     alongside its child sub-directories (each of which is itself a fiber
 *     by the same rule), forming a tree.
 */
async function walkFibers(
  feltRoot: string,
  currentDir: string,
  pathSegments: string[],
  out: Fiber[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  const isFeltRoot = pathSegments.length === 0;

  if (isFeltRoot) {
    // Bare <slug>.md at .felt/ root → entry-point fiber. Top-level folder
    // fibers are rendered as separate tree roots beneath it (not as
    // children), so parentId stays null there.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const slug = entry.name.slice(0, -3);
      try {
        const content = await readFile(join(currentDir, entry.name), 'utf-8');
        const fiber = parseFiber(slug, content);
        fiber.isRoot = true;
        fiber.parentId = null;
        out.push(fiber);
      } catch {
        // skip unreadable
      }
    }
  } else {
    const dirName = pathSegments[pathSegments.length - 1];
    const match = entries.find(e => e.isFile() && e.name === `${dirName}.md`);
    if (match) {
      try {
        const content = await readFile(join(currentDir, match.name), 'utf-8');
        const id = pathSegments.join('/');
        const fiber = parseFiber(id, content);
        fiber.parentId = pathSegments.length > 1 ? pathSegments.slice(0, -1).join('/') : null;
        fiber.isRoot = false;
        out.push(fiber);
      } catch {
        // skip
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkFibers(feltRoot, join(currentDir, entry.name), [...pathSegments, entry.name], out);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Counts open fibers for a city by reading its .felt/ directory.
 */
export async function countOpenFibers(cityPath: string): Promise<number> {
  const fibers = await getOpenFibers(cityPath);
  return fibers.length;
}

/**
 * Gets all open fibers for a city.
 * Returns fibers with status !== 'closed', sorted by active first, then by priority.
 */
export async function getOpenFibers(cityPath: string): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);

  return fibers
    .filter(f => f.status !== 'closed')
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return a.priority - b.priority;
    });
}

/**
 * Gets recently closed fibers for a city.
 */
export async function getRecentlyClosed(cityPath: string, limit: number): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);

  return fibers
    .filter(f => f.status === 'closed')
    .sort((a, b) => {
      const dateA = a.closedAt ? new Date(a.closedAt).getTime() : 0;
      const dateB = b.closedAt ? new Date(b.closedAt).getTime() : 0;
      return dateB - dateA;
    })
    .slice(0, limit);
}

/**
 * Gets all fibers (any status) matching a tag prefix.
 */
export async function getFibersByTag(cityPath: string, tagPrefix: string): Promise<Fiber[]> {
  const fibers = await readAllFibers(cityPath);
  return fibers.filter(f => f.tags?.some(t => t.startsWith(tagPrefix)));
}

/**
 * Gets all fibers for a city regardless of status.
 */
export async function getAllFibers(cityPath: string): Promise<Fiber[]> {
  return readAllFibers(cityPath);
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse a fiber file into a Fiber object.
 *
 * @param id The fiber ID (slug, e.g., "my-fiber")
 * @param content File content with YAML frontmatter
 */
export function parseFiber(id: string, content: string): Fiber {

  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();

  // Parse the frontmatter once with a real YAML parser so we get block
  // scalars (`|`, `|-`, `>`), multi-line flow strings, and proper unquoting
  // for free. The previous regex-based approach treated `outcome: |-`
  // as a literal string `"|-"` and silently corrupted any multi-line
  // outcome — see ai-futures/portolan/gotchas/constitution-draft-prefix-in-title
  // for the surfacing.
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(frontmatter);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Bad YAML → empty frontmatter. The fiber still gets included with
    // defaults (matches the old regex parser's silent-skip behavior).
  }

  // Single-value field. Coerces Date (from ISO timestamps in YAML) back
  // to ISO string so downstream consumers see strings consistently.
  const getField = (name: string): string | undefined => {
    const v = fm[name];
    if (v === null || v === undefined) return undefined;
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
  };

  // List field (YAML sequence). Strings get trimmed; other types are
  // coerced via String().
  const getListField = (name: string): string[] | undefined => {
    const v = fm[name];
    if (!Array.isArray(v)) return undefined;
    return v.map(item => String(item).trim());
  };

  // Normalize tags: split comma-separated values within a single YAML list item
  // into individual tags. Handles "claim, tapestry:foo" → ["claim", "tapestry:foo"]
  const rawTags = getListField('tags');
  const tags = rawTags?.flatMap(t => t.includes(',') ? t.split(',').map(s => s.trim()).filter(Boolean) : [t]);
  const dependsOn = getListField('depends-on') ?? getListField('depends_on');

  // tempered: human-acceptance signal. Parsed permissively — frontmatter
  // convention is `tempered: true` but YAML truthiness is forgiving.
  const temperedRaw = getField('tempered');
  const tempered = temperedRaw === undefined
    ? undefined
    : /^(true|yes|1)$/i.test(temperedRaw);

  // hasShuttleBlock: true when the fiber carries a shuttle: frontmatter block.
  // This is the dispatch-eligibility signal post-migration (replaces the
  // constitution/draft tag predicate). Non-null object means the block is present.
  const shuttleRaw = fm['shuttle'];
  const hasShuttleBlock = shuttleRaw !== null && shuttleRaw !== undefined && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);

  return {
    id,
    name: getField('name') || id,
    status: getField('status') || '',
    kind: getField('kind') || 'task',
    priority: parseInt(getField('priority') || '2', 10),
    createdAt: getField('created-at') || getField('created') || '',
    closedAt: getField('closed-at') || getField('closed') || undefined,
    outcome: getField('outcome') || undefined,
    body: body || undefined,
    tags: tags,
    dependsOn: dependsOn,
    tempered: tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
  };
}
