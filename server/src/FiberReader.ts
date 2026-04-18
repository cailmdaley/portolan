import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export interface Fiber {
  id: string;        // filename without .md extension
  title: string;     // from frontmatter
  status: string;    // open, active, closed
  kind: string;      // task, decision, question, spec
  priority: number;  // default 2
  createdAt: string; // ISO date from frontmatter
  body?: string;     // markdown body after frontmatter
  outcome?: string;  // outcome from frontmatter
  closedAt?: string; // ISO date from frontmatter
  tags?: string[];   // e.g. ["tapestry:cosebis_data_vector"]
  dependsOn?: string[]; // fiber IDs this depends on
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

  try {
    const entries = await readdir(feltPath, { withFileTypes: true });
    const fibers: Fiber[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const fiberPath = join(feltPath, slug, `${slug}.md`);
      try {
        const content = await readFile(fiberPath, 'utf-8');
        fibers.push(parseFiber(slug, content));
      } catch {
        // Not every directory is a fiber (e.g., no matching .md)
      }
    }

    return fibers;
  } catch (err) {
    console.warn(`Failed to read .felt directory at ${feltPath}:`, err);
    return [];
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

  // Parse single-line frontmatter field
  const getField = (name: string): string | undefined => {
    const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    if (!match) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, '');
  };

  // Parse YAML list field (indented "- item" lines after field header)
  const getListField = (name: string): string[] | undefined => {
    const regex = new RegExp(`^${name}:\\s*\\n((?:[ \\t]+- .+\\n?)*)`, 'm');
    const match = frontmatter.match(regex);
    if (!match) return undefined;
    const items = match[1].match(/^\s+- (.+)$/gm);
    if (!items) return undefined;
    return items.map(line => line.replace(/^\s+- /, '').trim().replace(/^["']|["']$/g, ''));
  };

  // Normalize tags: split comma-separated values within a single YAML list item
  // into individual tags. Handles "claim, tapestry:foo" → ["claim", "tapestry:foo"]
  const rawTags = getListField('tags');
  const tags = rawTags?.flatMap(t => t.includes(',') ? t.split(',').map(s => s.trim()).filter(Boolean) : [t]);
  const dependsOn = getListField('depends-on');

  return {
    id,
    title: getField('name') || getField('title') || id,
    status: getField('status') || 'open',
    kind: getField('kind') || 'task',
    priority: parseInt(getField('priority') || '2', 10),
    createdAt: getField('created-at') || getField('created') || '',
    closedAt: getField('closed-at') || getField('closed') || undefined,
    outcome: getField('outcome') || undefined,
    body: body || undefined,
    tags: tags,
    dependsOn: dependsOn,
  };
}
