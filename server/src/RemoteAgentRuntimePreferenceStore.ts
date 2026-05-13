import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { RemoteAgentRuntime } from './OriginManager.js';

export interface RemoteAgentRuntimePreference {
  sshHost: string;
  runtime: RemoteAgentRuntime;
  updatedAt: string;
}

interface PreferenceFile {
  version: 1;
  preferences: RemoteAgentRuntimePreference[];
}

export interface RemoteAgentRuntimePreferences {
  getPreferredRuntime(sshHost: string): RemoteAgentRuntime | undefined;
  setPreferredRuntime(sshHost: string, runtime: RemoteAgentRuntime): void;
  getDiagnostics(): RemoteAgentRuntimePreference[];
}

export class RemoteAgentRuntimePreferenceStore implements RemoteAgentRuntimePreferences {
  private readonly dataDir: string;
  private readonly filePath: string;
  private preferences = new Map<string, RemoteAgentRuntimePreference>();

  constructor(filePath = join(homedir(), '.portolan', 'remote-agent-runtime-preferences.json')) {
    this.filePath = filePath;
    this.dataDir = dirname(filePath);
    this.load();
  }

  getPreferredRuntime(sshHost: string): RemoteAgentRuntime | undefined {
    return this.preferences.get(sshHost)?.runtime;
  }

  setPreferredRuntime(sshHost: string, runtime: RemoteAgentRuntime): void {
    this.preferences.set(sshHost, {
      sshHost,
      runtime,
      updatedAt: new Date().toISOString(),
    });
    this.save();
  }

  getDiagnostics(): RemoteAgentRuntimePreference[] {
    return Array.from(this.preferences.values()).sort((a, b) => a.sshHost.localeCompare(b.sshHost));
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as PreferenceFile;
      if (data.version !== 1 || !Array.isArray(data.preferences)) return;

      for (const preference of data.preferences) {
        if (!isRemoteAgentRuntime(preference.runtime) || !preference.sshHost) continue;
        this.preferences.set(preference.sshHost, preference);
      }
      console.log(`[RemoteAgent] Loaded ${this.preferences.size} runtime preferences`);
    } catch (error) {
      console.error('[RemoteAgent] Failed to load runtime preferences:', error);
    }
  }

  private save(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    const data: PreferenceFile = {
      version: 1,
      preferences: this.getDiagnostics(),
    };
    const tmpPath = `${this.filePath}.tmp`;

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }
}

function isRemoteAgentRuntime(value: unknown): value is RemoteAgentRuntime {
  return value === 'node' || value === 'rust';
}
