/**
 * CLI Provider — abstracts which coding agent CLI is in use.
 *
 * Currently supports "claude", "codex", and "pi".
 * Set PORTOLAN_CLI=codex to detect/launch Codex instead of Claude.
 */

export interface CliProvider {
  /** Short name for identification (e.g. "claude", "codex") */
  cliName: string;
  /** Process names to match via ps/pgrep (e.g. ["claude"] or ["codex", "node"]) */
  processNames: string[];
  /** Command to launch the CLI in autonomous mode */
  launchCmd: (opts?: { continue?: boolean; chrome?: boolean }) => string;
  /** Shell to use for local tmux sessions */
  localShell: string;
  /** Shell to use for remote tmux sessions */
  remoteShell: string;
}

const claude: CliProvider = {
  cliName: 'claude',
  processNames: ['claude'],
  launchCmd: ({ continue: cont, chrome } = {}) => {
    let cmd = 'claude --dangerously-skip-permissions';
    if (cont) cmd += ' -c';
    if (chrome) cmd += ' --chrome';
    return cmd;
  },
  localShell: 'zsh',
  remoteShell: 'bash',
};

const codex: CliProvider = {
  cliName: 'codex',
  processNames: ['codex'],
  launchCmd: ({ continue: cont } = {}) => {
    let cmd = 'codex --dangerously-bypass-approvals-and-sandbox';
    if (cont) cmd += ' --resume';
    return cmd;
  },
  localShell: 'zsh',
  remoteShell: 'bash',
};

const pi: CliProvider = {
  cliName: 'pi',
  processNames: ['pi'],
  launchCmd: ({ continue: cont } = {}) => {
    let cmd = 'pi';
    if (cont) cmd += ' --continue';
    return cmd;
  },
  localShell: 'zsh',
  remoteShell: 'bash',
};

export const providers: Record<string, CliProvider> = { claude, codex, pi };

/** Get a provider by name, defaulting to claude */
export function getProvider(name: string): CliProvider {
  return providers[name.toLowerCase()] || claude;
}

/** Default provider (from PORTOLAN_CLI env var) */
const defaultName = (process.env.PORTOLAN_CLI || 'claude').toLowerCase();
export const cliProvider: CliProvider = providers[defaultName] || claude;

/** All process names across all providers */
const allProcessNames = Object.values(providers).flatMap(p => p.processNames);

/** Check if a process comm string matches any known CLI */
export function isCliProcess(comm: string): boolean {
  return allProcessNames.some(n => comm.includes(n));
}

/** Detect which CLI a process comm string matches */
export function detectCli(comm: string): string | undefined {
  for (const provider of Object.values(providers)) {
    if (provider.processNames.some(n => comm.includes(n))) {
      return provider.cliName;
    }
  }
  return undefined;
}

/** pgrep -x pattern for matching any CLI child processes */
export function pgrepPattern(): string {
  const unique = [...new Set(allProcessNames)];
  if (unique.length === 1) return unique[0];
  return unique.join('\\|');
}
