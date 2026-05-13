/**
 * Agent-side Shuttle: felt-JSON projection + eligibility predicate.
 *
 * Constitution shuttle-remote-dispatch. The agent inlines a minimal port
 * of `Shuttle.computeEligibility` (server/src/Shuttle.ts) and a projection
 * from felt's JSON output onto the four fields Shuttle actually reads
 * (status, tags, depends_on, tempered). Both helpers live in agent.js so
 * the agent stays single-file scp-able. Per Phase 1 of
 * constitution-four-package-cleanup, the agent reads felt JSON rather than
 * re-parsing fiber YAML in TypeScript.
 *
 * This test covers the projection directly; the eligibility predicate is
 * small enough to test in place without round-tripping through the
 * server's `computeEligibility`.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';

const mockExecFileCalls: Array<{
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
}> = [];

const mockExecFile = vi.fn(
  (
    command: string,
    args: string[] = [],
    optionsOrCallback: Record<string, unknown> | ((err: Error | null, result?: unknown) => void) | undefined,
    callbackMaybe: ((err: Error | null, result?: unknown) => void) | undefined,
  ) => {
    const hasOptionsObject = typeof optionsOrCallback === 'object' && optionsOrCallback !== null;
    const options = hasOptionsObject ? optionsOrCallback : undefined;
    const callback = hasOptionsObject ? callbackMaybe : optionsOrCallback as
      | ((err: Error | null, result?: unknown) => void)
      | undefined;
    mockExecFileCalls.push({ command, args, options });
    if (typeof callback === 'function') {
      callback(null, { stdout: '', stderr: '' });
    }
    return {} as Record<string, unknown>;
  },
);

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  exec: vi.fn(),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_PATH = join(__dirname, '..', '..', 'agent.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agentMod: any;

beforeAll(async () => {
  agentMod = await import(AGENT_PATH);
});

beforeEach(() => {
  mockExecFile.mockClear();
  mockExecFileCalls.length = 0;
});

describe('agent: runKanbanMutation shuttle verbs', () => {
  it('passes explicit felt-host mutation shape for shuttle verbs', async () => {
    await agentMod.runKanbanMutation(
      { kind: 'shuttle', verb: 'pause', fiberId: 'shuttle/fiber' },
      '/tmp/felt/.felt/shuttle/fiber.md',
      '/remote/felt/host',
    );
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFileCalls[0]).toEqual({
      command: 'shuttle-ctl',
      args: ['--felt-store', '/remote/felt/host', 'pause', 'shuttle/fiber'],
      options: expect.objectContaining({
        cwd: '/remote/felt/host',
        env: expect.objectContaining({
          LOOM_HOME: '/remote/felt/host',
          HOME: expect.any(String),
        }),
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
    });
  });

  it('preserves per-verb shuttle args while still threading felt-store', async () => {
    await agentMod.runKanbanMutation(
      { kind: 'shuttle', verb: 'set-outcome', fiberId: 'shuttle/fiber', outcome: 'done' },
      '/tmp/felt/.felt/shuttle/fiber.md',
      '/remote/felt/host',
    );
    expect(mockExecFileCalls[0].args).toEqual([
      '--felt-store',
      '/remote/felt/host',
      'set-outcome',
      'shuttle/fiber',
      '--outcome',
      'done',
    ]);
  });
});

describe('agent: shuttleFiberFromFeltJson', () => {
  it('projects a fully-populated felt fiber JSON onto the eligibility shape', () => {
    const projected = agentMod.shuttleFiberFromFeltJson({
      id: 'cmbx',
      name: 'CMBx',
      status: 'active',
      tags: ['constitution', 'cmbx'],
      depends_on: [{ id: 'cmbx/setup' }],
      tempered: true,
    });
    expect(projected).toEqual({
      id: 'cmbx',
      status: 'active',
      tags: ['constitution', 'cmbx'],
      dependsOn: ['cmbx/setup'],
      tempered: true,
    });
  });

  it('extracts .id from depends_on objects (felt JSON shape)', () => {
    // felt JSON ships depends_on as `[{id: "..."}]` — see CLAUDE.md
    // "depends_on is objects, extract .id".
    const projected = agentMod.shuttleFiberFromFeltJson({
      id: 'work',
      tags: ['constitution'],
      depends_on: [{ id: 'a' }, { id: 'b/with/path' }],
    });
    expect(projected.dependsOn).toEqual(['a', 'b/with/path']);
  });

  it('also accepts bare-string depends_on for legacy fibers', () => {
    const projected = agentMod.shuttleFiberFromFeltJson({
      id: 'work',
      tags: ['constitution'],
      depends_on: ['a', 'b'],
    });
    expect(projected.dependsOn).toEqual(['a', 'b']);
  });

  it('returns null when fiber has no id', () => {
    expect(agentMod.shuttleFiberFromFeltJson({ name: 'x' })).toBeNull();
    expect(agentMod.shuttleFiberFromFeltJson(null)).toBeNull();
    expect(agentMod.shuttleFiberFromFeltJson([])).toBeNull();
  });

  it('returns sane defaults for sparse fibers', () => {
    expect(agentMod.shuttleFiberFromFeltJson({ id: 'x' })).toEqual({
      id: 'x',
      status: undefined,
      tags: [],
      dependsOn: [],
      tempered: undefined,
    });
  });

  it('preserves boolean false on tempered (not undefined)', () => {
    const projected = agentMod.shuttleFiberFromFeltJson({
      id: 'x',
      tempered: false,
    });
    expect(projected.tempered).toBe(false);
  });
});

describe('agent: shuttleIdFromPath', () => {
  it('resolves entry-point fibers', () => {
    expect(agentMod.shuttleIdFromPath('cmbx.md')).toBe('cmbx');
  });

  it('resolves directory-shaped fibers', () => {
    expect(agentMod.shuttleIdFromPath('cmbx/cmbx.md')).toBe('cmbx');
  });

  it('resolves nested container fibers', () => {
    expect(agentMod.shuttleIdFromPath('ai-futures/portolan/portolan.md')).toBe(
      'ai-futures/portolan',
    );
  });

  it('returns null for non-container .md', () => {
    expect(agentMod.shuttleIdFromPath('cmbx/notes.md')).toBeNull();
    expect(agentMod.shuttleIdFromPath('foo.txt')).toBeNull();
  });
});

describe('agent: isSafeRemoteFiberPath', () => {
  it('accepts relative container-fiber paths', () => {
    expect(agentMod.isSafeRemoteFiberPath('cmbx/cmbx.md')).toBe(true);
    expect(agentMod.isSafeRemoteFiberPath('ai-futures/portolan/portolan.md')).toBe(true);
  });

  it('rejects absolute, empty, and traversing paths', () => {
    expect(agentMod.isSafeRemoteFiberPath('')).toBe(false);
    expect(agentMod.isSafeRemoteFiberPath('/tmp/cmbx.md')).toBe(false);
    expect(agentMod.isSafeRemoteFiberPath('../cmbx.md')).toBe(false);
    expect(agentMod.isSafeRemoteFiberPath('cmbx/../cmbx.md')).toBe(false);
  });
});

describe('agent: remote file request helpers', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portolan-agent-file-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('rejects relative, traversing, missing, and directory file paths', () => {
    expect(() => agentMod.resolveRemoteFilePath('not-absolute.md')).toThrow(
      'path must be absolute: not-absolute.md',
    );
    expect(() => agentMod.resolveRemoteFilePath('/tmp/../etc')).toThrow(
      'invalid path: /tmp/../etc',
    );

    const missing = join(rootDir, 'missing.md');
    expect(() => agentMod.resolveRemoteFilePath(missing)).toThrow(`file missing: ${missing}`);

    const dirPath = join(rootDir, 'folder');
    mkdirSync(dirPath);
    expect(() => agentMod.resolveRemoteFilePath(dirPath)).toThrow(
      `path is not a file: ${dirPath}`,
    );
  });

  it('validates directory listing paths are absolute and safe', () => {
    expect(() => agentMod.resolveRemoteDirectoryPath('relative/path')).toThrow(
      'path must be absolute: relative/path',
    );
    expect(() => agentMod.resolveRemoteDirectoryPath('/tmp/../etc')).toThrow(
      'invalid path: /tmp/../etc',
    );

    const missing = join(rootDir, 'missing-dir');
    expect(() => agentMod.resolveRemoteDirectoryPath(missing)).toThrow(
      `directory missing: ${missing}`,
    );
  });

  it('reads and writes text through file-content request payloads', () => {
    const source = join(rootDir, 'source.md');
    writeFileSync(source, '# Notes\n');

    const readResult = agentMod.executeFileContentRequest({
      operation: 'read',
      path: source,
    });
    expect(readResult).toMatchObject({ ok: true, content: '# Notes\n' });
    expect(typeof readResult.mtimeMs).toBe('number');

    const target = join(rootDir, 'target.md');
    expect(agentMod.executeFileContentRequest({
      operation: 'write',
      path: target,
      content: 'updated\n',
    })).toEqual({ ok: true });
    expect(readFileSync(target, 'utf8')).toBe('updated\n');
  });

  it('returns binary project files as base64 plus byte length', () => {
    const filePath = join(rootDir, 'figure.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(filePath, bytes);

    expect(agentMod.executeProjectFileRequest({ path: filePath })).toEqual({
      ok: true,
      contentBase64: 'iVBORw==',
      byteLength: 4,
    });
  });

  it('expands ~/ paths for remote project-file reads', () => {
    const homeFile = join(homedir(), '.portolan-test-agent-project-file.bin');
    writeFileSync(homeFile, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    try {
      expect(agentMod.executeProjectFileRequest({
        path: '~/.portolan-test-agent-project-file.bin',
      })).toEqual({
        ok: true,
        contentBase64: 'JVBERg==',
        byteLength: 4,
      });
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  it('returns tapestry evidence JSON with mtimes', () => {
    const evidenceDir = join(rootDir, 'results', 'tapestry', 'spec_a');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, 'evidence.json'),
      '{"evidence":{"pte":0.12},"output":{"figure":"plot.png"}}',
    );

    const result = agentMod.executeTapestryEvidenceRequest({
      cityPath: rootDir,
      specNames: ['spec_a', 'missing'],
    });

    expect(result.ok).toBe(true);
    expect(result.evidences.spec_a.evidenceJson).toContain('"pte":0.12');
    expect(result.evidences.spec_a.mtimeMs).toBeGreaterThan(0);
    expect(result.evidences.missing).toBeNull();
  });

  it('reports file-content and project-file size errors before replying', () => {
    const writePath = join(rootDir, 'large.txt');
    expect(() => agentMod.executeFileContentRequest({
      operation: 'write',
      path: writePath,
      content: 'x'.repeat(10 * 1024 * 1024 + 1),
    })).toThrow('file content exceeds 10 MB');

    const projectPath = join(rootDir, 'large.bin');
    writeFileSync(projectPath, Buffer.alloc(50 * 1024 * 1024 + 1));
    expect(() => agentMod.executeProjectFileRequest({ path: projectPath })).toThrow(
      'project file exceeds 50 MB',
    );
  });

  it('searches filenames recursively with relative paths and absolute full paths', () => {
    mkdirSync(join(rootDir, 'notes'));
    writeFileSync(join(rootDir, 'notes', 'search-note.md'), 'note');
    writeFileSync(join(rootDir, 'notes', 'other.txt'), 'other');

    const searchResult = agentMod.executeSearchFilesRequest({
      path: rootDir,
      query: 'search',
      mode: 'filename',
    });

    expect(searchResult).toEqual({
      ok: true,
      results: [
        {
          type: 'file',
          path: 'notes/search-note.md',
          fullPath: join(rootDir, 'notes', 'search-note.md'),
        },
      ],
    });
  });

  it('searches file contents and returns first matching line', () => {
    const target = join(rootDir, 'log.txt');
    writeFileSync(target, 'alpha\nneedle line here\nomega', 'utf8');

    expect(agentMod.executeSearchFilesRequest({
      path: rootDir,
      query: 'line here',
      mode: 'content',
    })).toEqual({
      ok: true,
      results: [{
        type: 'file',
        path: 'log.txt',
        fullPath: target,
        line: 2,
        match: 'needle line here',
      }],
    });
  });

  it('limits search results and defaults mode to filename', () => {
    for (let i = 0; i < 100; i += 1) {
      writeFileSync(join(rootDir, `match-${i}.md`), 'x');
    }

    const searchResult = agentMod.executeSearchFilesRequest({
      path: rootDir,
      query: 'match',
    });

    expect(searchResult.ok).toBe(true);
    expect(searchResult.results).toHaveLength(50);
  });

  it('returns invalid path and mode as thrown search errors', () => {
    expect(() => agentMod.executeSearchFilesRequest({
      path: 'relative/path',
      query: 'match',
      mode: 'filename',
    })).toThrow('path must be absolute: relative/path');

    expect(() => agentMod.executeSearchFilesRequest({
      path: '/tmp/../etc',
      query: 'match',
      mode: 'filename',
    })).toThrow('invalid path: /tmp/../etc');

    expect(() => agentMod.executeSearchFilesRequest({
      path: rootDir,
      query: 'match',
      mode: 'weird',
    })).toThrow('unsupported search mode: weird');
  });

  it('returns sorted and filtered directory entries through list-directory requests', () => {
    mkdirSync(join(rootDir, 'alpha'));
    mkdirSync(join(rootDir, 'zeta'));
    writeFileSync(join(rootDir, 'b.txt'), 'file b');
    writeFileSync(join(rootDir, 'a.txt'), 'file a');
    mkdirSync(join(rootDir, '.git'));
    writeFileSync(join(rootDir, '.DS_Store'), 'skip me');

    expect(agentMod.executeListDirectoryRequest({ path: rootDir })).toEqual({
      ok: true,
      entries: [
        { name: 'alpha', type: 'dir' },
        { name: 'zeta', type: 'dir' },
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ],
    });
  });

  it('rejects invalid list-directory paths', () => {
    expect(() => agentMod.executeListDirectoryRequest({ path: 'relative/path' })).toThrow(
      'path must be absolute: relative/path',
    );
    expect(() => agentMod.executeListDirectoryRequest({ path: '/tmp/../etc' })).toThrow(
      'invalid path: /tmp/../etc',
    );
  });
});

describe('agent: computeShuttleEligibility', () => {
  const fiber = (overrides: Record<string, unknown>) => ({
    id: 'foo',
    status: 'active',
    tags: [],
    dependsOn: [],
    tempered: undefined,
    ...overrides,
  });

  it('selects constitution-tagged, unblocked, non-closed fibers', () => {
    const fibers = [
      fiber({ id: 'a', tags: ['constitution'] }),
      fiber({ id: 'b', tags: ['constitution'], status: 'closed' }),
      fiber({ id: 'c', tags: ['decision'] }),
      fiber({ id: 'd', tags: ['constitution'], status: 'active' }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible.map((f: { id: string }) => f.id).sort()).toEqual(['a', 'd']);
    expect(blocked.map((b: { fiberId: string }) => b.fiberId)).toEqual(['b']);
  });

  it('excludes draft-tagged fibers', () => {
    const fibers = [
      fiber({ id: 'ready', tags: ['constitution'] }),
      fiber({ id: 'parked', tags: ['constitution', 'draft'] }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible.map((f: { id: string }) => f.id)).toEqual(['ready']);
    expect(blocked[0].fiberId).toBe('parked');
    expect(blocked[0].reason).toContain('draft');
  });

  it('blocks on unsatisfied depends_on', () => {
    const fibers = [
      fiber({ id: 'dep', tags: ['constitution'] }),
      fiber({ id: 'work', tags: ['constitution'], dependsOn: ['dep'] }),
    ];
    const r1 = agentMod.computeShuttleEligibility(fibers, []);
    expect(r1.eligible.map((f: { id: string }) => f.id)).toEqual(['dep']);
    expect(r1.blocked[0].reason).toContain('dep');

    fibers[0].tempered = true;
    const r2 = agentMod.computeShuttleEligibility(fibers, []);
    expect(r2.eligible.map((f: { id: string }) => f.id).sort()).toEqual(['dep', 'work']);
    expect(r2.blocked).toEqual([]);
  });

  it('respects prefix scoping', () => {
    const fibers = [
      fiber({ id: 'in-scope/work', tags: ['constitution'] }),
      fiber({ id: 'in-scope', tags: ['constitution'] }),
      fiber({ id: 'other/work', tags: ['constitution'] }),
    ];
    const { eligible } = agentMod.computeShuttleEligibility(fibers, ['in-scope']);
    expect(eligible.map((f: { id: string }) => f.id).sort()).toEqual([
      'in-scope',
      'in-scope/work',
    ]);
  });

  it('partial prefix does not bleed into unrelated paths', () => {
    const fibers = [
      fiber({ id: 'shuttle-tests/work', tags: ['constitution'] }),
      fiber({ id: 'shuttle/work', tags: ['constitution'] }),
    ];
    const { eligible } = agentMod.computeShuttleEligibility(fibers, ['shuttle']);
    expect(eligible.map((f: { id: string }) => f.id)).toEqual(['shuttle/work']);
  });

  it('treats missing depends-on target as unsatisfied', () => {
    const fibers = [
      fiber({ id: 'orphan', tags: ['constitution'], dependsOn: ['ghost'] }),
    ];
    const { eligible, blocked } = agentMod.computeShuttleEligibility(fibers, []);
    expect(eligible).toEqual([]);
    expect(blocked[0].reason).toContain('ghost');
  });
});
