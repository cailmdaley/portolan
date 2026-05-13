import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface RustIndexedFileEntry {
  relativePath: string;
  type: 'dir' | 'file';
}

export interface RustFileIndexResult {
  entries: RustIndexedFileEntry[];
  truncated: boolean;
  timedOut: boolean;
  stderr: string;
  visitedDirs?: number;
  ignoredDirs?: number;
  unreadableDirs?: number;
  indexRefreshed?: boolean;
  indexAgeMs?: number;
  databasePath?: string;
}

interface RustWalkPayload {
  entries?: unknown;
  truncated?: unknown;
  visitedDirs?: unknown;
  ignoredDirs?: unknown;
  unreadableDirs?: unknown;
  indexRefreshed?: unknown;
  indexAgeMs?: unknown;
  databasePath?: unknown;
}

interface RustIndexerCommand {
  program: string;
  args: string[];
  cwd: string;
}

export function walkCityIndexWithRust(
  cityPath: string,
  maxEntries: number,
  timeoutMs: number,
): Promise<RustFileIndexResult> {
  const command = resolveRustIndexerCommand();
  return runIndexerCommand(
    command,
    ['walk', '--root', cityPath, '--max-entries', String(maxEntries)],
    timeoutMs,
  );
}

export function searchCityIndexWithRust(
  cityPath: string,
  query: string,
  limit: number,
  maxEntries: number,
  refreshTtlMs: number,
  timeoutMs: number,
): Promise<RustFileIndexResult> {
  const command = resolveRustIndexerCommand();
  return runIndexerCommand(
    command,
    [
      'search',
      '--root',
      cityPath,
      '--db',
      resolveRustIndexDatabase(cityPath),
      '--query',
      query,
      '--limit',
      String(limit),
      '--max-entries',
      String(maxEntries),
      '--refresh-ttl-ms',
      String(refreshTtlMs),
    ],
    timeoutMs,
  );
}

function runIndexerCommand(
  command: RustIndexerCommand,
  commandArgs: string[],
  timeoutMs: number,
): Promise<RustFileIndexResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command.program, [...command.args, ...commandArgs], { cwd: command.cwd });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ entries: [], truncated: false, timedOut: true, stderr });
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `portolan-index exited with code ${code ?? signal ?? 'unknown'}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }

      try {
        const payload = JSON.parse(stdout) as RustWalkPayload;
        resolve({
          entries: parseEntries(payload.entries),
          truncated: payload.truncated === true,
          timedOut: false,
          stderr,
          visitedDirs: parseDirectoryCount(payload.visitedDirs),
          ignoredDirs: parseDirectoryCount(payload.ignoredDirs),
          unreadableDirs: parseDirectoryCount(payload.unreadableDirs),
          indexRefreshed: parseBoolean(payload.indexRefreshed),
          indexAgeMs: typeof payload.indexAgeMs === 'number' ? payload.indexAgeMs : undefined,
          databasePath:
            typeof payload.databasePath === 'string' ? payload.databasePath : undefined,
        });
      } catch (error) {
        reject(
          new Error(
            `portolan-index returned invalid JSON: ${(error as { message?: string }).message ?? String(error)}`,
          ),
        );
      }
    });
  });
}

function resolveRustIndexerCommand(): RustIndexerCommand {
  const projectRoot = resolveProjectRoot();
  const override = process.env.PORTOLAN_INDEX_BIN;
  if (override) return { program: override, args: [], cwd: projectRoot };

  const crateRoot = join(projectRoot, 'crates', 'portolan-index');
  const binaryName = process.platform === 'win32' ? 'portolan-index.exe' : 'portolan-index';
  const bundledCandidate = join(dirname(fileURLToPath(import.meta.url)), 'native', binaryName);
  if (existsSync(bundledCandidate)) {
    return { program: bundledCandidate, args: [], cwd: projectRoot };
  }

  for (const profile of ['release', 'debug']) {
    const candidate = join(crateRoot, 'target', profile, binaryName);
    if (existsSync(candidate)) {
      return { program: candidate, args: [], cwd: projectRoot };
    }
  }

  return {
    program: 'cargo',
    args: ['run', '--quiet', '--manifest-path', join(crateRoot, 'Cargo.toml'), '--'],
    cwd: projectRoot,
  };
}

function resolveProjectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(here));
}

function resolveRustIndexDatabase(cityPath: string): string {
  const baseDir =
    process.env.PORTOLAN_INDEX_DIR ?? join(homedir(), '.portolan', 'data', 'file-indexes');
  mkdirSync(baseDir, { recursive: true });
  const digest = createHash('sha256').update(cityPath).digest('hex').slice(0, 24);
  return join(baseDir, `${digest}.sqlite`);
}

function parseEntries(value: unknown): RustIndexedFileEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('entries is not an array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('entry is not an object');
    }
    const record = entry as { relativePath?: unknown; type?: unknown };
    if (typeof record.relativePath !== 'string') {
      throw new Error('entry.relativePath is not a string');
    }
    if (record.type !== 'dir' && record.type !== 'file') {
      throw new Error('entry.type must be dir or file');
    }
    return { relativePath: record.relativePath, type: record.type };
  });
}

function parseDirectoryCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
