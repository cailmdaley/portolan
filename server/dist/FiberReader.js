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
    const feltPath = join(cityPath, '.felt');
    // Check if .felt directory exists
    if (!existsSync(feltPath)) {
        return 0;
    }
    try {
        // Read all .md files in .felt directory
        const files = await readdir(feltPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        let openCount = 0;
        // Parse each file and check status
        for (const file of mdFiles) {
            const filePath = join(feltPath, file);
            try {
                const content = await readFile(filePath, 'utf-8');
                const status = parseFrontmatterStatus(content);
                // Count as open if status is not 'closed'
                if (status !== 'closed') {
                    openCount++;
                }
            }
            catch (err) {
                // Skip files that can't be read
                console.warn(`Failed to read fiber file ${filePath}:`, err);
            }
        }
        return openCount;
    }
    catch (err) {
        // If we can't read the directory, return 0
        console.warn(`Failed to read .felt directory at ${feltPath}:`, err);
        return 0;
    }
}
/**
 * Extracts the status field from YAML frontmatter.
 *
 * @param content File content with YAML frontmatter
 * @returns Status value or null if not found
 */
function parseFrontmatterStatus(content) {
    // Find frontmatter between first two --- markers
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
        return null;
    }
    const frontmatter = match[1];
    // Look for status: field (simple regex, good enough for felt's format)
    const statusMatch = frontmatter.match(/^status:\s*(.+)$/m);
    if (!statusMatch) {
        return null;
    }
    // Strip surrounding quotes (both single and double) after trimming
    const trimmed = statusMatch[1].trim();
    return trimmed.replace(/^["']|["']$/g, '');
}
//# sourceMappingURL=FiberReader.js.map