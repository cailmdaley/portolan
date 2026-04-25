import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

// Mock child_process before importing GitStatusManager. GitStatusManager wraps
// `execFile` in `promisify`, which expects the standard `(error, stdout, stderr)`
// callback signature; `util.promisify(execFile)` reads child_process's
// `[promisify.custom]` symbol to return `{stdout, stderr}` shape. We have to
// mirror that custom shim on the mock or every git command throws TypeError.
vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  // util.promisify checks for this symbol and uses the custom impl when present.
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options: unknown,
  ) => new Promise((resolve, reject) => {
    mockExecFile(file, args, options, (err: Error | null, stdout: string, stderr: string) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
  return {
    execFile: mockExecFile,
  };
});

import * as childProcess from 'child_process';
import { GitStatusManager } from '../GitStatusManager.js';

const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Build an execFile mock that returns canned outputs for specific git args.
 * `responses` keys are space-joined args; values are stdout strings.
 */
function mockGitResponses(responses: Record<string, string>) {
  mockExecFile.mockImplementation(
    (_file: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
      const key = args.join(' ');
      if (key in responses) {
        callback(null, responses[key], '');
      } else if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        callback(null, '.git\n', '');
      } else {
        callback(null, '', '');
      }
      return {} as unknown;
    },
  );
}

describe('GitStatusManager porcelain parsing', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('counts unstaged-only modifications correctly when the first line starts with a leading space', async () => {
    // Reproduces vellum-dogfood: HUD reported staged:~1 unstaged:~7 against
    // 8 unstaged ` M file` rows. Root cause was `statusResult.trim()` stripping
    // the leading space of the first line, shifting XY left and miscounting
    // the first ` M` as an `M ` (staged-only).
    mockGitResponses({
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'status --porcelain': [
        ' M docs',
        ' M server/dist/FiberReader.d.ts',
        ' M server/dist/FiberReader.d.ts.map',
        ' M server/dist/FiberReader.js',
        ' M server/dist/FiberReader.js.map',
        ' M server/dist/index.js',
        ' M server/dist/index.js.map',
        ' M server/node_modules/.vite/vitest/results.json',
        '?? .tmp/',
        '?? public/sprites/cities/portolan-deepzoom-prototype.png',
        '',
      ].join('\n'),
      'diff --cached --shortstat': '',
      'diff --shortstat': ' 8 files changed, 77 insertions(+), 21 deletions(-)\n',
    });

    const manager = new GitStatusManager();
    manager.track('/tmp/test-repo');
    const status = await manager.refresh('/tmp/test-repo');

    expect(status).not.toBeNull();
    expect(status!.staged).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(status!.unstaged.modified).toBe(8);
    expect(status!.unstaged.deleted).toBe(0);
    expect(status!.untracked).toBe(2);
  });

  it('counts staged and unstaged sides separately on mixed lines', async () => {
    mockGitResponses({
      'rev-parse --abbrev-ref HEAD': 'main\n',
      // M  staged-only modification
      // MM staged AND unstaged modification
      // A  newly added staged
      // D  staged deletion
      //  D unstaged deletion
      // ?? untracked
      'status --porcelain': [
        'M  staged-only.txt',
        'MM both-sides.txt',
        'A  added.txt',
        'D  deleted-staged.txt',
        ' D deleted-unstaged.txt',
        '?? untracked.txt',
        '',
      ].join('\n'),
      'diff --cached --shortstat': '',
      'diff --shortstat': '',
    });

    const manager = new GitStatusManager();
    manager.track('/tmp/test-repo');
    const status = await manager.refresh('/tmp/test-repo');

    expect(status).not.toBeNull();
    expect(status!.staged).toEqual({ added: 1, modified: 2, deleted: 1 });
    expect(status!.unstaged.modified).toBe(1);
    expect(status!.unstaged.deleted).toBe(1);
    expect(status!.untracked).toBe(1);
  });

  it('returns empty status for non-git directories', async () => {
    mockExecFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (args[0] === 'rev-parse') {
          callback(new Error('not a git repo'), '', '');
        } else {
          callback(null, '', '');
        }
        return {} as unknown;
      },
    );

    const manager = new GitStatusManager();
    manager.track('/tmp/not-a-repo');
    const status = await manager.refresh('/tmp/not-a-repo');

    expect(status).not.toBeNull();
    expect(status!.isRepo).toBe(false);
    expect(status!.staged).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(status!.unstaged).toEqual({ added: 0, modified: 0, deleted: 0 });
  });
});
