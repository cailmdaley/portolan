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

function shuttleFiberLeaf(fiberId: string): string {
  const trimmed = fiberId.replace(/\/+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split('/');
  return parts[parts.length - 1] ?? '';
}

export function shuttleSessionName(fiberId: string): string {
  return `${shuttleFiberLeaf(fiberId)}-shuttle`;
}

export function isShuttleSession(sessionName: string): boolean {
  return sessionName.endsWith('-shuttle');
}

/** Returns the set of tmux session names matching Shuttle's canonical worker shape. */
export function listShuttleSessions(): string[] {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map(s => s.trim()).filter(isShuttleSession);
  } catch {
    return [];
  }
}
