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

  it('defaults ordinary remote activation to Rust', () => {
    const store = new RemoteAgentRuntimePreferenceStore(storePath());

    expect(store.getDefaultRuntime()).toBe('rust');
    expect(store.getDiagnostics()).toEqual({
      defaultRuntime: 'rust',
      preferences: [],
    });
  });

  it('persists runtime preferences by ssh host', () => {
    const path = storePath();
    const first = new RemoteAgentRuntimePreferenceStore(path);

    first.setPreferredRuntime('candide', 'rust');
    first.setPreferredRuntime('cineca', 'node');

    const second = new RemoteAgentRuntimePreferenceStore(path);
    expect(second.getPreferredRuntime('candide')).toBe('rust');
    expect(second.getPreferredRuntime('cineca')).toBe('node');
    expect(second.getDiagnostics()).toEqual({
      defaultRuntime: 'rust',
      preferences: [
        expect.objectContaining({ sshHost: 'candide', runtime: 'rust' }),
        expect.objectContaining({ sshHost: 'cineca', runtime: 'node' }),
      ],
    });
  });

  it('normalizes login-node ssh hosts to one runtime preference', () => {
    const path = storePath();
    const first = new RemoteAgentRuntimePreferenceStore(path);

    first.setPreferredRuntime('cineca-login01', 'node');
    first.setPreferredRuntime('candide', 'rust');

    const second = new RemoteAgentRuntimePreferenceStore(path);
    expect(second.getPreferredRuntime('cineca')).toBe('node');
    expect(second.getPreferredRuntime('cineca-login02')).toBe('node');
    expect(second.getDiagnostics()).toEqual({
      defaultRuntime: 'rust',
      preferences: [
        expect.objectContaining({ sshHost: 'candide', runtime: 'rust' }),
        expect.objectContaining({ sshHost: 'cineca', runtime: 'node' }),
      ],
    });
  });

  it('accepts an explicit Node default for rollback-oriented launches', () => {
    const store = new RemoteAgentRuntimePreferenceStore(storePath(), 'node');

    expect(store.getDefaultRuntime()).toBe('node');
    expect(store.getDiagnostics()).toEqual({
      defaultRuntime: 'node',
      preferences: [],
    });
  });
});
