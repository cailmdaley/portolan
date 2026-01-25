import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
/**
 * Counts open fibers for a city by reading its .felt/ directory.
 *
 * @param cityPath Absolute path to the city directory
 * @returns Number of fibers with status !== 'closed'
 */
export async function countOpenFibers(cityPath) {
    const fibers = await getOpenFibers(cityPath);
    return fibers.length;
}
/**
 * Gets all open fibers for a city.
 *
 * @param cityPath Absolute path to the city directory
 * @returns Array of fibers with status !== 'closed', sorted by active first, then by priority
 */
export async function getOpenFibers(cityPath) {
    const feltPath = join(cityPath, '.felt');
    // Check if .felt directory exists
    if (!existsSync(feltPath)) {
        return [];
    }
    try {
        const files = await readdir(feltPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        const fibers = [];
        for (const file of mdFiles) {
            const filePath = join(feltPath, file);
            try {
                const content = await readFile(filePath, 'utf-8');
                const fiber = parseFiber(file, content);
                // Only include non-closed fibers
                if (fiber.status !== 'closed') {
                    fibers.push(fiber);
                }
            }
            catch (err) {
                console.warn(`Failed to read fiber file ${filePath}:`, err);
            }
        }
        // Sort: active first, then open by priority (ascending)
        return fibers.sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active')
                return -1;
            if (a.status !== 'active' && b.status === 'active')
                return 1;
            return a.priority - b.priority;
        });
    }
    catch (err) {
        console.warn(`Failed to read .felt directory at ${feltPath}:`, err);
        return [];
    }
}
/**
 * Gets recently closed fibers for a city.
 *
 * @param cityPath Absolute path to the city directory
 * @param limit Maximum number of fibers to return
 * @returns Array of closed fibers sorted by closed date descending
 */
export async function getRecentlyClosed(cityPath, limit) {
    const feltPath = join(cityPath, '.felt');
    if (!existsSync(feltPath)) {
        return [];
    }
    try {
        const files = await readdir(feltPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        const closedFibers = [];
        for (const file of mdFiles) {
            const filePath = join(feltPath, file);
            try {
                const content = await readFile(filePath, 'utf-8');
                const fiber = parseFiber(file, content);
                if (fiber.status === 'closed') {
                    closedFibers.push(fiber);
                }
            }
            catch (err) {
                console.warn(`Failed to read fiber file ${filePath}:`, err);
            }
        }
        // Sort by closed date descending (most recent first)
        const sorted = closedFibers.sort((a, b) => {
            const dateA = a.closedAt ? new Date(a.closedAt).getTime() : 0;
            const dateB = b.closedAt ? new Date(b.closedAt).getTime() : 0;
            return dateB - dateA;
        });
        return sorted.slice(0, limit);
    }
    catch (err) {
        console.warn(`Failed to read .felt directory at ${feltPath}:`, err);
        return [];
    }
}
/**
 * Parse a fiber file into a Fiber object.
 *
 * @param filename The filename (e.g., "my-fiber-abc123.md")
 * @param content File content with YAML frontmatter
 * @returns Fiber object
 */
function parseFiber(filename, content) {
    const id = filename.replace(/\.md$/, '');
    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter = fmMatch ? fmMatch[1] : '';
    const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
    // Parse frontmatter fields
    const getField = (name) => {
        const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
        if (!match)
            return undefined;
        return match[1].trim().replace(/^["']|["']$/g, '');
    };
    return {
        id,
        title: getField('title') || id,
        status: getField('status') || 'open',
        kind: getField('kind') || 'task',
        priority: parseInt(getField('priority') || '2', 10),
        createdAt: getField('created') || '',
        closedAt: getField('closed') || undefined,
        reason: getField('reason') || undefined,
        body: body || undefined,
    };
}
//# sourceMappingURL=FiberReader.js.map