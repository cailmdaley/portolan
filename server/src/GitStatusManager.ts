/**
 * GitStatusManager - Track git status for cities (directories)
 *
 * Polls git status independently of Claude activity so we always
 * know the state of each city's working directory.
 *
 * Tracks by path (not session) since cities represent directories.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: { added: number; modified: number; deleted: number };
  unstaged: { added: number; modified: number; deleted: number };
  untracked: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  lastCommitTime: number | null;
  lastCommitMessage: string | null;
  isRepo: boolean;
  lastChecked: number;
}

interface GitStatusUpdate {
  path: string;
  status: GitStatus;
}

type UpdateHandler = (update: GitStatusUpdate) => void;

// ============================================================================
// GitStatusManager
// ============================================================================

export class GitStatusManager {
  private statusCache = new Map<string, GitStatus>();
  private trackedPaths = new Set<string>();
  private pollInterval: NodeJS.Timeout | null = null;
  private onUpdate: UpdateHandler | null = null;

  // Configuration
  private readonly POLL_INTERVAL_MS = 60000; // Poll every minute
  private readonly EXEC_TIMEOUT_MS = 5000; // Timeout for git commands

  /**
   * Set callback for status updates
   */
  setUpdateHandler(handler: UpdateHandler): void {
    this.onUpdate = handler;
  }

  /**
   * Register a city path to track
   */
  track(path: string): void {
    if (this.trackedPaths.has(path)) return;
    this.trackedPaths.add(path);
    // Immediately fetch status for new path
    this.fetchStatus(path);
  }

  /**
   * Stop tracking a path
   */
  untrack(path: string): void {
    this.trackedPaths.delete(path);
    this.statusCache.delete(path);
  }

  /**
   * Get cached status for a path
   */
  getStatus(path: string): GitStatus | null {
    return this.statusCache.get(path) ?? null;
  }

  /**
   * Start polling for git status
   */
  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      this.pollAll();
    }, this.POLL_INTERVAL_MS);
    // Initial poll
    this.pollAll();
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Force refresh status for a path
   */
  async refresh(path: string): Promise<GitStatus | null> {
    if (!this.trackedPaths.has(path)) return null;
    return this.fetchStatus(path);
  }

  /**
   * Poll all tracked paths
   */
  async pollAll(): Promise<void> {
    const promises = Array.from(this.trackedPaths).map((path) =>
      this.fetchStatus(path)
    );
    await Promise.all(promises);
  }

  /**
   * Fetch git status for a directory
   */
  private async fetchStatus(path: string): Promise<GitStatus> {
    const status = await this.getGitStatus(path);

    // Check if status changed
    const oldStatus = this.statusCache.get(path);
    const changed = !oldStatus || this.hasStatusChanged(oldStatus, status);

    this.statusCache.set(path, status);

    // Notify if changed
    if (changed && this.onUpdate) {
      this.onUpdate({ path, status });
    }

    return status;
  }

  /**
   * Check if status has meaningfully changed
   */
  private hasStatusChanged(old: GitStatus, current: GitStatus): boolean {
    return (
      old.branch !== current.branch ||
      old.ahead !== current.ahead ||
      old.behind !== current.behind ||
      old.totalFiles !== current.totalFiles ||
      old.linesAdded !== current.linesAdded ||
      old.linesRemoved !== current.linesRemoved ||
      old.lastCommitTime !== current.lastCommitTime
    );
  }

  /**
   * Get git status for a directory
   */
  private async getGitStatus(directory: string): Promise<GitStatus> {
    const emptyStatus: GitStatus = {
      branch: '',
      ahead: 0,
      behind: 0,
      staged: { added: 0, modified: 0, deleted: 0 },
      unstaged: { added: 0, modified: 0, deleted: 0 },
      untracked: 0,
      totalFiles: 0,
      linesAdded: 0,
      linesRemoved: 0,
      lastCommitTime: null,
      lastCommitMessage: null,
      isRepo: false,
      lastChecked: Date.now(),
    };

    try {
      // Check if it's a git repo
      await this.execGit(['rev-parse', '--git-dir'], directory);
    } catch {
      // Not a git repo
      return emptyStatus;
    }

    const status: GitStatus = {
      ...emptyStatus,
      isRepo: true,
    };

    // Run all git commands in parallel
    const [branchResult, statusResult, diffStagedResult, diffUnstagedResult, logResult] =
      await Promise.all([
        this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory).catch(() => ''),
        this.execGit(['status', '--porcelain'], directory).catch(() => ''),
        this.execGit(['diff', '--cached', '--shortstat'], directory).catch(() => ''),
        this.execGit(['diff', '--shortstat'], directory).catch(() => ''),
        this.execGit(['log', '-1', '--format=%ct|||%s'], directory).catch(() => ''),
      ]);

    // Parse branch
    status.branch = branchResult.trim();

    // Parse ahead/behind
    try {
      const abResult = await this.execGit(
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        directory
      );
      const [behind, ahead] = abResult.trim().split(/\s+/).map(Number);
      status.ahead = ahead || 0;
      status.behind = behind || 0;
    } catch {
      // No upstream configured
    }

    // Parse status --porcelain
    const statusLines = statusResult.trim().split('\n').filter(Boolean);
    for (const line of statusLines) {
      const staged = line[0];
      const unstaged = line[1];

      // Staged changes
      if (staged === 'A') status.staged.added++;
      else if (staged === 'M') status.staged.modified++;
      else if (staged === 'D') status.staged.deleted++;

      // Unstaged changes
      if (unstaged === 'M') status.unstaged.modified++;
      else if (unstaged === 'D') status.unstaged.deleted++;

      // Untracked
      if (staged === '?' && unstaged === '?') status.untracked++;
    }

    // Parse diff stats
    const parseDiffStat = (output: string): { added: number; removed: number } => {
      const match = output.match(/(\d+) insertion.*?(\d+) deletion/i);
      if (match) {
        return { added: parseInt(match[1], 10), removed: parseInt(match[2], 10) };
      }
      const addMatch = output.match(/(\d+) insertion/i);
      const delMatch = output.match(/(\d+) deletion/i);
      return {
        added: addMatch ? parseInt(addMatch[1], 10) : 0,
        removed: delMatch ? parseInt(delMatch[1], 10) : 0,
      };
    };

    const stagedDiff = parseDiffStat(diffStagedResult);
    const unstagedDiff = parseDiffStat(diffUnstagedResult);

    status.linesAdded = stagedDiff.added + unstagedDiff.added;
    status.linesRemoved = stagedDiff.removed + unstagedDiff.removed;

    // Total files
    status.totalFiles =
      status.staged.added +
      status.staged.modified +
      status.staged.deleted +
      status.unstaged.modified +
      status.unstaged.deleted +
      status.untracked;

    // Parse last commit. `%ct` is UNIX seconds; the HUD renders via
    // `Date.now() - lastCommitTime`, which is milliseconds — so convert here
    // rather than teaching every consumer about the seconds-vs-ms split.
    if (logResult) {
      const [timestamp, message] = logResult.trim().split('|||');
      const secs = parseInt(timestamp, 10);
      status.lastCommitTime = Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
      status.lastCommitMessage = message || null;
    }

    return status;
  }

  /**
   * Execute a git command in a directory using execFile (no shell).
   * Args should be passed as an array, not a string, to prevent command injection.
   */
  private async execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: this.EXEC_TIMEOUT_MS,
    });
    return stdout;
  }
}
