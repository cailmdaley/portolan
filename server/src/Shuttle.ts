/**
 * Shuttle — tmux probe utilities for the kanban running-worker indicator.
 *
 * The engine lives in the standalone Elixir application
 * (~/Documents/projects/shuttle/). Portolan no longer dispatches
 * workers; it only needs to detect live tmux sessions for UI badging.
 *
 * See constitution-shuttle-standalone Stage 6.
 */

import { execSync } from 'child_process';

/** Returns the set of tmux session names matching `shuttle-*`. */
export function listShuttleSessions(): string[] {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(s => s.startsWith('shuttle-'));
  } catch {
    return [];
  }
}

export function shuttleSessionName(fiberId: string): string {
  return `shuttle-${fiberId}`;
}
