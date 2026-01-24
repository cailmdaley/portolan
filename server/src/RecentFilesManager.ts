/**
 * RecentFilesManager - Track recently modified files for cities
 *
 * Polls file modification times independently so we can show
 * "Recently Edited" files in the CityPanel.
 *
 * Tracks by path (not session) since cities represent directories.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface RecentFile {
  path: string;        // Relative path from city root
  fullPath: string;    // Full path for opening
  mtime: number;       // Modification time (epoch ms)
}

export interface RecentFilesUpdate {
  path: string;
  files: RecentFile[];
}

type UpdateHandler = (update: RecentFilesUpdate) => void;

// ============================================================================
// RecentFilesManager
// ============================================================================

export class RecentFilesManager {
  private filesCache = new Map<string, RecentFile[]>();
  private trackedPaths = new Set<string>();
  private pollInterval: NodeJS.Timeout | null = null;
  private onUpdate: UpdateHandler | null = null;

  // Configuration
  private readonly POLL_INTERVAL_MS = 10000; // Poll every 10 seconds
  private readonly EXEC_TIMEOUT_MS = 10000;  // Timeout for find commands
  private readonly MAX_FILES = 20;           // Cache top N files per path

  // Directories to exclude from search
  private readonly EXCLUDE_DIRS = [
    '.git',
    'node_modules',
    'dist',
    'build',
    '.felt',
    '__pycache__',
    '.venv',
    'venv',
    '.cache',
    'coverage',
    '.osgrep',
  ];

  // File patterns to exclude
  private readonly EXCLUDE_PATTERNS = [
    '*.pyc',
    '*.pyo',
    '*.so',
    '*.dylib',
    '*.o',
    '*.a',
    '.DS_Store',
    '*.swp',
    '*.swo',
  ];

  /**
   * Set callback for file updates
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
    // Immediately fetch files for new path
    this.fetchFiles(path);
  }

  /**
   * Stop tracking a path
   */
  untrack(path: string): void {
    this.trackedPaths.delete(path);
    this.filesCache.delete(path);
  }

  /**
   * Get cached files for a path
   */
  getFiles(path: string): RecentFile[] {
    return this.filesCache.get(path) ?? [];
  }

  /**
   * Get all cached files
   */
  getAllFiles(): Map<string, RecentFile[]> {
    return new Map(this.filesCache);
  }

  /**
   * Start polling for file changes
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
   * Force refresh files for a path
   */
  async refresh(path: string): Promise<RecentFile[]> {
    if (!this.trackedPaths.has(path)) return [];
    return this.fetchFiles(path);
  }

  /**
   * Poll all tracked paths
   */
  async pollAll(): Promise<void> {
    const promises = Array.from(this.trackedPaths).map((path) =>
      this.fetchFiles(path)
    );
    await Promise.all(promises);
  }

  /**
   * Fetch recent files for a directory
   */
  private async fetchFiles(path: string): Promise<RecentFile[]> {
    const files = await this.getRecentFiles(path);

    // Check if files changed
    const oldFiles = this.filesCache.get(path);
    const changed = !oldFiles || this.hasFilesChanged(oldFiles, files);

    this.filesCache.set(path, files);

    // Notify if changed
    if (changed && this.onUpdate) {
      this.onUpdate({ path, files });
    }

    return files;
  }

  /**
   * Check if file list has meaningfully changed
   */
  private hasFilesChanged(old: RecentFile[], current: RecentFile[]): boolean {
    if (old.length !== current.length) return true;

    // Compare top 5 files (most likely to change)
    for (let i = 0; i < Math.min(5, old.length); i++) {
      if (old[i].path !== current[i].path || old[i].mtime !== current[i].mtime) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get recent files for a directory using find + stat
   */
  private async getRecentFiles(directory: string): Promise<RecentFile[]> {
    try {
      // Build exclusion args for find
      const excludeDirArgs = this.EXCLUDE_DIRS
        .map(dir => `-name '${dir}' -prune -o`)
        .join(' ');

      const excludePatternArgs = this.EXCLUDE_PATTERNS
        .map(pat => `-not -name '${pat}'`)
        .join(' ');

      // find with stat format: mtime|path
      // Using %Y for mtime (epoch seconds)
      const cmd = `cd "${directory}" && find . \\( ${excludeDirArgs} -type f ${excludePatternArgs} -print \\) 2>/dev/null | head -500 | xargs -I {} stat -f '%m|%N' {} 2>/dev/null | sort -t'|' -k1 -rn | head -${this.MAX_FILES}`;

      const { stdout } = await execAsync(cmd, {
        timeout: this.EXEC_TIMEOUT_MS,
      });

      const files: RecentFile[] = [];
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const [mtimeStr, ...pathParts] = line.split('|');
        const relativePath = pathParts.join('|').replace(/^\.\//, '');
        const mtime = parseInt(mtimeStr, 10) * 1000; // Convert to ms

        if (relativePath && !isNaN(mtime)) {
          files.push({
            path: relativePath,
            fullPath: `${directory}/${relativePath}`,
            mtime,
          });
        }
      }

      return files;
    } catch (error) {
      // Log error but don't fail - return empty list
      console.error(`[RecentFilesManager] Failed to get files for ${directory}:`, error);
      return [];
    }
  }

  /**
   * Get recent files from a remote host via SSH
   */
  async getRemoteFiles(sshHost: string, directory: string): Promise<RecentFile[]> {
    try {
      // Build exclusion args for find
      const excludeDirArgs = this.EXCLUDE_DIRS
        .map(dir => `-name '${dir}' -prune -o`)
        .join(' ');

      const excludePatternArgs = this.EXCLUDE_PATTERNS
        .map(pat => `-not -name '${pat}'`)
        .join(' ');

      // Remote find with stat - use Linux stat format
      // Linux stat uses -c '%Y %n' instead of macOS -f '%m|%N'
      const remoteCmd = `cd '${directory}' && find . \\( ${excludeDirArgs} -type f ${excludePatternArgs} -print \\) 2>/dev/null | head -500 | while read f; do stat --format='%Y|%n' "\$f" 2>/dev/null; done | sort -t'|' -k1 -rn | head -${this.MAX_FILES}`;

      const { stdout } = await execAsync(`ssh ${sshHost} "${remoteCmd}"`, {
        timeout: this.EXEC_TIMEOUT_MS * 2, // Longer timeout for SSH
      });

      const files: RecentFile[] = [];
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const [mtimeStr, ...pathParts] = line.split('|');
        const relativePath = pathParts.join('|').replace(/^\.\//, '');
        const mtime = parseInt(mtimeStr, 10) * 1000; // Convert to ms

        if (relativePath && !isNaN(mtime)) {
          files.push({
            path: relativePath,
            fullPath: `${directory}/${relativePath}`,
            mtime,
          });
        }
      }

      return files;
    } catch (error) {
      console.error(`[RecentFilesManager] Failed to get remote files from ${sshHost}:${directory}:`, error);
      return [];
    }
  }
}
