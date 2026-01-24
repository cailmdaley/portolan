/**
 * Activity utilities - shared between EventWatcher and agent.js
 *
 * NOTE: This is the source of truth. When updating extractSummary or
 * extractActivityDetails, also update the copy in agent.js (which can't
 * import this directly since it runs standalone on remote machines).
 */

/**
 * Detailed activity information for file viewer support
 */
export interface ActivityDetails {
  summary: string;           // Short display text (filename, command, pattern)
  fullPath?: string;         // Full file path for Read/Write/Edit
  toolInput?: Record<string, unknown>;  // Full tool parameters
}

/**
 * Extract a short summary from tool input for activity display
 */
export function extractSummary(tool: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return input.file_path ? String(input.file_path).split('/').pop() : undefined;
    case 'Bash':
      if (input.command) {
        const cmd = String(input.command);
        return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
      }
      return undefined;
    case 'Glob':
    case 'Grep':
      return input.pattern ? String(input.pattern) : undefined;
    case 'Task':
      return input.description ? String(input.description) : undefined;
    default:
      return undefined;
  }
}

/**
 * Extract detailed activity information including full paths for file viewer
 */
export function extractActivityDetails(tool: string, input?: Record<string, unknown>): ActivityDetails | undefined {
  if (!input) return undefined;

  const summary = extractSummary(tool, input);
  if (!summary) return undefined;

  const details: ActivityDetails = { summary };

  // Include full path for file operations
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      if (input.file_path) {
        details.fullPath = String(input.file_path);
      }
      break;
  }

  // Include toolInput for potential future use (line numbers, etc.)
  details.toolInput = input;

  return details;
}
