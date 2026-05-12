import { spawn } from 'child_process';
import { existsSync } from 'fs';
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
}

interface RustWalkPayload {
  entries?: unknown;
  truncated?: unknown;
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
  return new Promise((resolve, reject) => {
    const proc = spawn(
      command.program,
      [...command.args, '--root', cityPath, '--max-entries', String(maxEntries)],
      { cwd: command.cwd },
    );

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
  if (override) return { program: override, args: ['walk'], cwd: projectRoot };

  const crateRoot = join(projectRoot, 'crates', 'portolan-index');
  const binaryName = process.platform === 'win32' ? 'portolan-index.exe' : 'portolan-index';
  const bundledCandidate = join(dirname(fileURLToPath(import.meta.url)), 'native', binaryName);
  if (existsSync(bundledCandidate)) {
    return { program: bundledCandidate, args: ['walk'], cwd: projectRoot };
  }

  for (const profile of ['release', 'debug']) {
    const candidate = join(crateRoot, 'target', profile, binaryName);
    if (existsSync(candidate)) {
      return { program: candidate, args: ['walk'], cwd: projectRoot };
    }
  }

  return {
    program: 'cargo',
    args: ['run', '--quiet', '--manifest-path', join(crateRoot, 'Cargo.toml'), '--', 'walk'],
    cwd: projectRoot,
  };
}

function resolveProjectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(here));
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
