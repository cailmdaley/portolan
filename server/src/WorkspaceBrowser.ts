import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { promisify } from 'util';
import { WebSocket } from 'ws';

import { CityManager } from './CityManager.js';
import { CityPersistence } from './CityPersistence.js';
import { shellEscape } from './ShellPathUtils.js';
import { OriginManager } from './OriginManager.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface SearchResult {
  type: 'file' | 'dir';
  path: string;
  fullPath: string;
  line?: number;
  match?: string;
}

interface DirectoryEntry {
  name: string;
  type: 'file' | 'dir';
}

type RemoteDirectoryExecutor = (originId: string, path: string) => Promise<DirectoryEntry[]>;

const NON_GIT_SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);

export class WorkspaceBrowser {
  private readonly activeSearches = new Map<string, ChildProcess>();
  private readonly gitRepoCache = new Map<string, boolean>();
  private hasFd: boolean | null = null;
  private hasRg: boolean | null = null;

  constructor(
    private readonly cityManager: CityManager,
    private readonly originManager: OriginManager,
    private readonly cityPersistence: CityPersistence,
    private readonly remoteDirectoryExecutor?: RemoteDirectoryExecutor,
  ) {
    void this.checkSearchTools();
  }

  getActiveSearchCount(): number {
    return this.activeSearches.size;
  }

  handleSearchFiles(
    ws: WebSocket,
    cityId: string,
    query: string,
    searchId: string,
    mode: 'filename' | 'content' = 'filename',
  ): void {
    const searchBase = searchId.replace(/-(?:name|content)$/, '');
    const searchKeyPrefix = `${cityId}:${searchBase}`;
    for (const [key, proc] of this.activeSearches) {
      if (key.startsWith(`${cityId}:`) && !key.startsWith(searchKeyPrefix)) {
        proc.kill();
        this.activeSearches.delete(key);
      }
    }

    const city = this.cityManager.getCityById(cityId);
    if (!city) {
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: 'City not found' }));
      return;
    }

    if (!query.trim()) {
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [] }));
      return;
    }

    const searchKey = `${cityId}:${searchId}`;
    if (city.originId === 'local') {
      this.searchLocal(ws, city.path, query, searchId, searchKey, mode);
      return;
    }

    const origin = this.originManager.getOrigin(city.originId);
    const persistedCity = this.cityPersistence.getCityById(city.id);
    const sshHost = origin?.sshHost || persistedCity?.sshHost;
    if (!sshHost) {
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: 'No SSH host for remote city' }));
      return;
    }

    this.searchRemote(ws, sshHost, city.path, query, searchId, searchKey, mode);
  }

  async handleListDirectory(ws: WebSocket, cityId: string, path: string): Promise<void> {
    const city = this.cityManager.getCityById(cityId);
    if (!city) {
      ws.send(JSON.stringify({ type: 'directoryListing', cityId, path, entries: [], error: 'City not found' }));
      return;
    }

    try {
      const safePath = resolve(path);
      const safeCity = resolve(city.path);
      if (!(safePath === safeCity || safePath.startsWith(`${safeCity}/`))) {
        throw new Error('Path is outside city root');
      }

      let entries: DirectoryEntry[] = [];
      if (city.originId === 'local') {
        entries = await this.listLocalDirectory(city.path, safePath);
      } else {
        const origin = this.originManager.getOrigin(city.originId);
        const persistedCity = this.cityPersistence.getCityById(city.id);
        const sshHost = origin?.sshHost || persistedCity?.sshHost;
        let remoteExecutorUsed = false;
        let remoteExecutorError: Error | null = null;
        if (this.remoteDirectoryExecutor && origin) {
          try {
            entries = await this.remoteDirectoryExecutor(origin.id, safePath);
            remoteExecutorUsed = true;
          } catch (error) {
            remoteExecutorError = error instanceof Error ? error : new Error(String(error));
            console.warn(
              '[WorkspaceBrowser] remote directory listing via agent failed; falling back to SSH',
              remoteExecutorError.message,
            );
          }
        }
        if (!remoteExecutorUsed) {
          if (!sshHost) {
            if (remoteExecutorError) {
              throw new Error(`Remote agent listing failed and no SSH host is configured: ${remoteExecutorError.message}`);
            }
            throw new Error('No SSH host for remote city');
          }
          entries = await this.listRemoteDirectory(sshHost, safePath);
        }
      }

      ws.send(JSON.stringify({ type: 'directoryListing', cityId, path: safePath, entries }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Could not read directory';
      ws.send(JSON.stringify({ type: 'directoryListing', cityId, path, entries: [], error: msg }));
    }
  }

  private async checkSearchTools(): Promise<void> {
    if (this.hasFd === null) {
      try {
        await execAsync('which fd');
        this.hasFd = true;
      } catch {
        this.hasFd = false;
      }
    }

    if (this.hasRg === null) {
      try {
        await execAsync('which rg');
        this.hasRg = true;
      } catch {
        this.hasRg = false;
      }
    }
  }

  private parseSearchResults(stdout: string, cityPath: string, mode: 'filename' | 'content'): SearchResult[] {
    const results: SearchResult[] = [];
    const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 50);

    for (const line of lines) {
      if (mode === 'filename') {
        const isDir = line.endsWith('/');
        const cleanedPath = isDir ? line.slice(0, -1) : line;
        const relativePath = cleanedPath.startsWith('./') ? cleanedPath.slice(2) : cleanedPath;
        results.push({
          type: isDir ? 'dir' : 'file',
          path: relativePath,
          fullPath: `${cityPath}/${relativePath}`,
        });
        continue;
      }

      const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/);
      if (match) {
        results.push({
          type: 'file',
          path: match[1],
          fullPath: `${cityPath}/${match[1]}`,
          line: parseInt(match[2], 10),
          match: match[3].trim().slice(0, 100),
        });
      }
    }

    return results;
  }

  private searchLocal(
    ws: WebSocket,
    cityPath: string,
    query: string,
    searchId: string,
    searchKey: string,
    mode: 'filename' | 'content',
  ): void {
    let proc: ChildProcess;
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (mode === 'filename') {
      if (this.hasFd) {
        proc = spawn('fd', [
          '--type', 'f',
          '--type', 'd',
          '--follow',
          '--full-path',
          '--hidden',
          '--no-ignore',
          '--exclude', '.git',
          '--exclude', '.felt',
          '--exclude', 'node_modules',
          '--exclude', '__pycache__',
          '--color', 'never',
          query,
        ], { cwd: cityPath });
      } else {
        const cmd = `find -L . \\( -name '.git' -o -name '.felt' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o \\( -type f -o -type d \\) -print 2>/dev/null | while IFS= read -r path; do if [ -d "$path" ]; then printf '%s/\\n' "$path"; else printf '%s\\n' "$path"; fi; done | grep -i '${safeQuery}' | head -50`;
        proc = spawn('sh', ['-c', cmd], { cwd: cityPath });
      }
    } else if (this.hasRg) {
      proc = spawn('rg', [
        '--line-number',
        '--no-heading',
        '--color', 'never',
        '--max-count', '1',
        '--follow',
        '--no-ignore',
        '--glob', '!.git',
        '--glob', '!node_modules',
        '--glob', '!__pycache__',
        query,
      ], { cwd: cityPath });
    } else {
      const cmd = `grep -Rn --include='*' -I '${safeQuery}' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ 2>/dev/null | head -50`;
      proc = spawn('sh', ['-c', cmd], { cwd: cityPath });
    }

    this.activeSearches.set(searchKey, proc);

    let stdout = '';
    let timedOut = false;
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      console.log(`[Search] Timeout for ${searchKey}, returning partial results`);
    }, 10000);

    proc.on('close', () => {
      clearTimeout(timeout);
      this.activeSearches.delete(searchKey);
      const results = this.parseSearchResults(stdout, cityPath, mode);
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results, timedOut }));
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      this.activeSearches.delete(searchKey);
      console.error('Search error:', error);
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: error.message }));
    });
  }

  private searchRemote(
    ws: WebSocket,
    sshHost: string,
    cityPath: string,
    query: string,
    searchId: string,
    searchKey: string,
    mode: 'filename' | 'content',
  ): void {
    const escapedPath = shellEscape(cityPath);
    const escapedQuery = shellEscape(query);
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\'"]/g, '\\$&');

    let remoteCmd: string;
    if (mode === 'filename') {
      remoteCmd = `(fd --type f --type d --follow --full-path --hidden --no-ignore --exclude .git --exclude .felt --exclude node_modules --exclude __pycache__ --color never ${escapedQuery} 2>/dev/null || find -L . \\( -name '.git' -o -name '.felt' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o \\( -type f -o -type d \\) -print 2>/dev/null | while IFS= read -r path; do if [ -d "$path" ]; then printf '%s/\\n' "$path"; else printf '%s\\n' "$path"; fi; done | grep -i '${safeQuery}') | head -50`;
    } else {
      remoteCmd = `(rg --line-number --no-heading --color never --max-count 1 --follow --no-ignore --glob '!.git' --glob '!node_modules' --glob '!__pycache__' ${escapedQuery} 2>/dev/null || grep -Rn --include='*' -I '${safeQuery}' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ 2>/dev/null) | head -50`;
    }

    const remoteScript = `cd ${escapedPath} && ${remoteCmd}`;
    const proc = spawn('ssh', [sshHost, remoteScript]);
    this.activeSearches.set(searchKey, proc);

    let stdout = '';
    let timedOut = false;
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      console.log(`[Search] Remote timeout for ${searchKey}, returning partial results`);
    }, 15000);

    proc.on('close', () => {
      clearTimeout(timeout);
      this.activeSearches.delete(searchKey);
      const results = this.parseSearchResults(stdout, cityPath, mode);
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results, timedOut }));
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      this.activeSearches.delete(searchKey);
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: error.message }));
    });
  }

  private sortDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  private parseLsName(raw: string): { name: string; type: 'file' | 'dir' } | null {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return null;
    const last = trimmed.charAt(trimmed.length - 1);
    const isDir = last === '/';
    const name = trimmed.replace(/[\\/@*|=]+$/, '');
    if (!name || NON_GIT_SKIP.has(name)) return null;
    return { name, type: isDir ? 'dir' : 'file' };
  }

  private async isGitRepo(cityPath: string): Promise<boolean> {
    const cached = this.gitRepoCache.get(cityPath);
    if (cached !== undefined) return cached;

    try {
      const { stdout } = await execFileAsync('git', ['-C', cityPath, 'rev-parse', '--is-inside-work-tree'], { timeout: 3000 });
      const result = stdout.trim() === 'true';
      this.gitRepoCache.set(cityPath, result);
      return result;
    } catch {
      this.gitRepoCache.set(cityPath, false);
      return false;
    }
  }

  private async isIgnoredByGit(cityPath: string, relPath: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', cityPath, 'check-ignore', '-q', relPath], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async readPhysicalDirectoryEntries(targetPath: string): Promise<DirectoryEntry[]> {
    const dirents = await readdir(targetPath, { withFileTypes: true });
    const entries: DirectoryEntry[] = [];

    for (const dirent of dirents) {
      if (NON_GIT_SKIP.has(dirent.name)) continue;
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, type: 'dir' });
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ name: dirent.name, type: 'file' });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        try {
          const target = await stat(join(targetPath, dirent.name));
          entries.push({ name: dirent.name, type: target.isDirectory() ? 'dir' : 'file' });
        } catch {
          entries.push({ name: dirent.name, type: 'file' });
        }
      }
    }

    return entries;
  }

  private async listLocalDirectory(cityPath: string, targetPath: string): Promise<DirectoryEntry[]> {
    const safeRoot = resolve(cityPath);
    const safeTarget = resolve(targetPath);
    const relTarget = relative(safeRoot, safeTarget);
    if (relTarget.startsWith('..') || relTarget.includes('/../')) {
      throw new Error('Path is outside city root');
    }

    const physicalEntries = await this.readPhysicalDirectoryEntries(safeTarget);
    if (await this.isGitRepo(cityPath)) {
      const visible = await Promise.all(
        physicalEntries.map(async (entry) => {
          const relPath = relTarget ? `${relTarget}/${entry.name}` : entry.name;
          return await this.isIgnoredByGit(cityPath, relPath) ? null : entry;
        }),
      );
      return this.sortDirectoryEntries(visible.filter((entry): entry is DirectoryEntry => Boolean(entry)));
    }

    return this.sortDirectoryEntries(physicalEntries);
  }

  private async listRemoteDirectory(sshHost: string, targetPath: string): Promise<DirectoryEntry[]> {
    const escapedPath = shellEscape(targetPath);
    const fdScript = `cd ${escapedPath} && ((fd --follow --max-depth 1 --type d --color never . | sed 's|^\\./||;s|$|/' && fd --follow --max-depth 1 --type f --type l --color never . | sed 's|^\\./||') 2>/dev/null || true)`;
    const lsScript = `cd ${escapedPath} && ls -1ALF 2>/dev/null`;

    const parseEntries = (stdout: string): DirectoryEntry[] => {
      const entriesByName = new Map<string, DirectoryEntry>();
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim().replace(/^\.\//, '');
        if (!line || line === '.') continue;

        let parsed: { name: string; type: 'file' | 'dir' } | null = null;
        if (line.endsWith('/')) {
          parsed = this.parseLsName(line);
        } else {
          const plainName = line.replace(/[\\/@*|=]+$/, '');
          if (plainName && !NON_GIT_SKIP.has(plainName)) {
            parsed = { name: plainName, type: 'file' };
          }
        }

        if (!parsed) continue;
        const existing = entriesByName.get(parsed.name);
        if (!existing || (existing.type === 'file' && parsed.type === 'dir')) {
          entriesByName.set(parsed.name, parsed);
        }
      }

      return this.sortDirectoryEntries([...entriesByName.values()]);
    };

    const { stdout: fdStdout } = await execFileAsync('ssh', [sshHost, fdScript], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    const fdEntries = parseEntries(fdStdout);
    if (fdEntries.length > 0) return fdEntries;

    const { stdout: lsStdout } = await execFileAsync('ssh', [sshHost, lsScript], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    return parseEntries(lsStdout);
  }
}
