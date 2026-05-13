import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HttpApi } from '../HttpApi.js';
import { makeMultiCityLookup, stubPersistenceLookup, httpRequest } from './test-utils.js';

const TEST_DIR = join(homedir(), '.portolan-test-httpapi-playground');

const mockExecFileCalls: Array<{
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
}> = [];

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  exec: vi.fn(),
}));

describe('HttpApi — /playground-list and /playground endpoints', () => {
  const remoteCityPath = join(TEST_DIR, 'remote-project');
  const stubCityLookup = makeMultiCityLookup([
    {
      id: 'remote-city',
      path: remoteCityPath,
      name: 'Remote City',
      originId: 'remote-candide',
    },
  ]);
  const stubOriginLookup = {
    getOrigin: (id: string) => (id === 'remote-candide' ? { id, type: 'remote' } : null),
  };
  const stubPersistence = {
    ...stubPersistenceLookup,
    getCityById: () => null,
  };

  beforeEach(() => {
    mkdirSync(remoteCityPath, { recursive: true });
    mockExecFile.mockClear();
    mockExecFileCalls.length = 0;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('uses remote list-directory executor first for remote playground listing', async () => {
    const listCalls: Array<{ originId: string; path: string }> = [];
    const api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistence as any,
      {
        remoteDirectoryExecutor: async (originId, path) => {
          listCalls.push({ originId, path });
          return [
            { name: 'z.html', type: 'file' },
            { name: 'notes.txt', type: 'file' },
            { name: 'a.html', type: 'file' },
            { name: 'dir', type: 'dir' },
          ];
        },
      },
    );

    const res = await httpRequest(api, 'GET', '/playground-list?cityId=remote-city');

    expect(res.status).toBe(200);
    expect(res.data.playgrounds).toEqual(['a.html', 'z.html']);
    expect(listCalls).toEqual([{
      originId: 'remote-candide',
      path: `${remoteCityPath}/.portolan/playgrounds`,
    }]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('uses remote file-content executor first for remote playground reads', async () => {
    const readCalls: Array<{ originId: string; path: string; operation: string }> = [];
    const api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistence as any,
      {
        remoteFileContentExecutor: async (request) => {
          readCalls.push(request);
          return { content: '<html><body>agent</body></html>' };
        },
      },
    );

    const res = await httpRequest(api, 'GET', '/playground?cityId=remote-city&name=playground.html');

    expect(res.status).toBe(200);
    expect(res.data).toContain('<html><body>agent</body></html>');
    expect(readCalls).toEqual([{
      originId: 'remote-candide',
      path: `${remoteCityPath}/.portolan/playgrounds/playground.html`,
      operation: 'read',
    }]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls back to SSH for remote playground listing when the executor fails', async () => {
    const api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistence as any,
      {
        remoteDirectoryExecutor: async () => {
          throw new Error('agent list unavailable');
        },
      },
    );
    mockExecFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result: { stdout: string; stderr: string }, _stderr: string) => void,
    ) => {
      const stdout = [
        `${remoteCityPath}/.portolan/playgrounds/aa.html`,
        `${remoteCityPath}/.portolan/playgrounds/zz.html`,
      ].join('\n');
      mockExecFileCalls.push({
        command: _command,
        args: _args,
        options: _options,
      });
      callback(null, { stdout, stderr: '' });
      return {} as Record<string, unknown>;
    });

    const res = await httpRequest(api, 'GET', '/playground-list?cityId=remote-city');

    expect(res.status).toBe(200);
    expect(res.data.playgrounds).toEqual(['aa.html', 'zz.html']);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1][0]).toBe('candide');
  });

  it('falls back to SSH for remote playground reads when the executor fails', async () => {
    const readCalls: Array<{ originId: string; path: string; operation: string }> = [];
    const api = new HttpApi(
      stubCityLookup as any,
      stubOriginLookup as any,
      stubPersistence as any,
      {
        remoteFileContentExecutor: async (request) => {
          readCalls.push(request);
          throw new Error('agent content unavailable');
        },
      },
    );
    mockExecFile.mockImplementation((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      mockExecFileCalls.push({
        command: _command,
        args: _args,
        options: _options,
      });
      callback(null, { stdout: '<html><body>ssh</body></html>', stderr: '' });
      return {} as Record<string, unknown>;
    });

    const res = await httpRequest(api, 'GET', '/playground?cityId=remote-city&name=playground.html');

    expect(res.status).toBe(200);
    expect(res.data).toContain('<html><body>ssh</body></html>');
    expect(readCalls).toEqual([{
      originId: 'remote-candide',
      path: `${remoteCityPath}/.portolan/playgrounds/playground.html`,
      operation: 'read',
    }]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[1][0]).toBe('candide');
    expect(mockExecFile.mock.calls[0]?.[1][1]).toContain('cat');
  });
});
