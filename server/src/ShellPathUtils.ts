import { homedir } from 'os';

/**
 * Escape shell arguments for safe use in commands.
 * Wraps the argument in single quotes and escapes embedded single quotes.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
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
