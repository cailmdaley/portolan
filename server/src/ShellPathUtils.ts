import { homedir } from 'os';

/**
 * Escape shell arguments for safe use in commands.
 * Wraps the argument in single quotes and escapes embedded single quotes.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Build an exact tmux target referring to a session.
 * tmux treats bare targets as exact-or-prefix matches; the "=" prefix forces exact.
 * The trailing ":" disambiguates the target as a session reference — pane-target
 * commands (paste-buffer, send-keys) otherwise try to match "=name" as a literal
 * pane name and fail with "can't find pane".
 */
export function exactTmuxTarget(sessionName: string): string {
  return shellEscape(`=${sessionName}:`);
}

/**
 * Expand ~ to the current user's home directory.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return filepath.replace('~', homedir());
  }
  return filepath;
}
