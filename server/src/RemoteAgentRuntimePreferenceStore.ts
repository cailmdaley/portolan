import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { RemoteAgentRuntime } from './OriginManager.js';

export interface RemoteAgentRuntimePreference {
  sshHost: string;
  runtime: RemoteAgentRuntime;
  updatedAt: string;
}

export interface RemoteAgentRuntimePreferenceDiagnostics {
  defaultRuntime: RemoteAgentRuntime;
  preferences: RemoteAgentRuntimePreference[];
}

interface PreferenceFile {
  version: 1;
  preferences: RemoteAgentRuntimePreference[];
}

export interface RemoteAgentRuntimePreferences {
  getDefaultRuntime(): RemoteAgentRuntime;
  getPreferredRuntime(sshHost: string): RemoteAgentRuntime | undefined;
  setPreferredRuntime(sshHost: string, runtime: RemoteAgentRuntime): void;
  getDiagnostics(): RemoteAgentRuntimePreferenceDiagnostics;
}

export class RemoteAgentRuntimePreferenceStore implements RemoteAgentRuntimePreferences {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly defaultRuntime: RemoteAgentRuntime;
  private preferences = new Map<string, RemoteAgentRuntimePreference>();

  constructor(
    filePath = join(homedir(), '.portolan', 'remote-agent-runtime-preferences.json'),
    defaultRuntime = defaultRemoteAgentRuntime(),
  ) {
    this.filePath = filePath;
    this.dataDir = dirname(filePath);
    this.defaultRuntime = defaultRuntime;
    this.load();
  }

  getDefaultRuntime(): RemoteAgentRuntime {
    return this.defaultRuntime;
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

  getDiagnostics(): RemoteAgentRuntimePreferenceDiagnostics {
    return {
      defaultRuntime: this.defaultRuntime,
      preferences: this.sortedPreferences(),
    };
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
      preferences: this.sortedPreferences(),
    };
    const tmpPath = `${this.filePath}.tmp`;

    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private sortedPreferences(): RemoteAgentRuntimePreference[] {
    return Array.from(this.preferences.values()).sort((a, b) => a.sshHost.localeCompare(b.sshHost));
  }
}

function isRemoteAgentRuntime(value: unknown): value is RemoteAgentRuntime {
  return value === 'node' || value === 'rust';
}

function defaultRemoteAgentRuntime(): RemoteAgentRuntime {
  const configured = process.env.PORTOLAN_REMOTE_AGENT_DEFAULT_RUNTIME;
  if (configured === undefined || configured === '') {
    return 'rust';
  }
  if (isRemoteAgentRuntime(configured)) {
    return configured;
  }
  console.warn(`[RemoteAgent] Ignoring invalid PORTOLAN_REMOTE_AGENT_DEFAULT_RUNTIME=${configured}; using rust`);
  return 'rust';
}
