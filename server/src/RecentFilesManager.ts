/**
 * RecentFilesManager - Track recently modified files for cities
 *
 * Polls file modification times independently so we can show
 * "Recently Edited" files in the CityPanel.
 *
 * Tracks by path (not session) since cities represent directories.
 *
 * For remote cities, persists file access history since `find` doesn't work over SSH.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface RecentFile {
  path: string;        // Relative path from city root
  fullPath: string;    // Full path for opening
  mtime: number;       // Modification time (epoch ms)
}

interface RecentFilesUpdate {
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

  // Persistence for remote cities (key = originId, value = recent files)
  private readonly dataDir: string;
  private readonly persistencePath: string;
  private remoteFilesHistory = new Map<string, RecentFile[]>();

  // Configuration
  private readonly POLL_INTERVAL_MS = 10000; // Poll every 10 seconds
  private readonly EXEC_TIMEOUT_MS = 10000;  // Timeout for find commands
  private readonly MAX_FILES = 20;           // Cache top N files per path

  constructor() {
    this.dataDir = join(homedir(), '.hexarchy');
    this.persistencePath = join(this.dataDir, 'recent-files.json');
    this.loadPersistence();
  }

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

  // ============================================================================
  // Persistence for remote cities
  // ============================================================================

  /**
   * Load persisted recent files from disk
   */
  private loadPersistence(): void {
    if (!existsSync(this.persistencePath)) {
      return;
    }

    try {
      const content = readFileSync(this.persistencePath, 'utf-8');
      const data = JSON.parse(content) as { version: 1; origins: Record<string, RecentFile[]> };

      if (data.version === 1 && data.origins) {
        for (const [originId, files] of Object.entries(data.origins)) {
          this.remoteFilesHistory.set(originId, files);
        }
        console.log(`[RecentFilesManager] Loaded ${this.remoteFilesHistory.size} remote origins`);
      }
    } catch (error) {
      console.error('[RecentFilesManager] Failed to load persistence:', error);
    }
  }

  /**
   * Save persisted recent files to disk
   */
  private savePersistence(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const origins: Record<string, RecentFile[]> = {};
    for (const [originId, files] of this.remoteFilesHistory.entries()) {
      origins[originId] = files;
    }

    const data = { version: 1 as const, origins };
    const tmpPath = this.persistencePath + '.tmp';

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      console.error('[RecentFilesManager] Failed to save persistence:', error);
    }
  }

  /**
   * Record a file access for a remote origin (called when files are opened)
   */
  recordRemoteFileAccess(originId: string, filePath: string, fullPath: string): void {
    if (originId === 'local') return; // Don't persist local files - use polling

    const files = this.remoteFilesHistory.get(originId) ?? [];
    const now = Date.now();

    // Remove existing entry for this file
    const filtered = files.filter(f => f.fullPath !== fullPath);

    // Add at the front with current timestamp
    const newEntry: RecentFile = {
      path: filePath,
      fullPath,
      mtime: now,
    };

    const updated = [newEntry, ...filtered].slice(0, this.MAX_FILES);
    this.remoteFilesHistory.set(originId, updated);
    this.savePersistence();
  }

  /**
   * Get persisted recent files for a remote origin
   */
  getRemoteFiles(originId: string): RecentFile[] {
    return this.remoteFilesHistory.get(originId) ?? [];
  }

  /**
   * Record a file edit from worker activity (Edit/Write tool usage).
   * Works for both local and remote cities.
   *
   * @param fullPath - Full path of the edited file
   * @param cityPath - Path of the city the file belongs to
   * @param originId - Origin ID ('local' or remote origin)
   */
  recordActivityEdit(fullPath: string, cityPath: string, originId: string): void {
    // Extract relative path from city root
    let relativePath = fullPath;
    if (fullPath.startsWith(cityPath + '/')) {
      relativePath = fullPath.slice(cityPath.length + 1);
    } else if (fullPath.startsWith(cityPath)) {
      relativePath = fullPath.slice(cityPath.length);
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
    }

    const now = Date.now();
    const entry: RecentFile = {
      path: relativePath,
      fullPath,
      mtime: now,
    };

    if (originId === 'local') {
      // For local cities, update the cache directly (polling will also catch it)
      const files = this.filesCache.get(cityPath) ?? [];
      const filtered = files.filter(f => f.fullPath !== fullPath);
      const updated = [entry, ...filtered].slice(0, this.MAX_FILES);
      this.filesCache.set(cityPath, updated);

      // Notify update handler
      if (this.onUpdate) {
        this.onUpdate({ path: cityPath, files: updated });
      }
    } else {
      // For remote cities, persist to history
      this.recordRemoteFileAccess(originId, relativePath, fullPath);
    }
  }

}
