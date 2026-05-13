import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAgentRuntimePreferenceStore } from '../RemoteAgentRuntimePreferenceStore.js';

describe('RemoteAgentRuntimePreferenceStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'portolan-runtime-pref-'));
    tempDirs.push(dir);
    return join(dir, 'preferences.json');
  }

  it('persists runtime preferences by ssh host', () => {
    const path = storePath();
    const first = new RemoteAgentRuntimePreferenceStore(path);

    first.setPreferredRuntime('candide', 'rust');
    first.setPreferredRuntime('cineca', 'node');

    const second = new RemoteAgentRuntimePreferenceStore(path);
    expect(second.getPreferredRuntime('candide')).toBe('rust');
    expect(second.getPreferredRuntime('cineca')).toBe('node');
    expect(second.getDiagnostics()).toEqual([
      expect.objectContaining({ sshHost: 'candide', runtime: 'rust' }),
      expect.objectContaining({ sshHost: 'cineca', runtime: 'node' }),
    ]);
  });
});
