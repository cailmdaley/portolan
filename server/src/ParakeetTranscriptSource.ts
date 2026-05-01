import {
  JsonlTranscriptSourceProcess,
  type TranscriptSource,
  type TranscriptSourceCallbacks,
} from './JsonlTranscriptSourceProcess.js';

export type { TranscriptSource, TranscriptSourceCallbacks } from './JsonlTranscriptSourceProcess.js';

export interface ParakeetTranscriptSourceOptions {
  pythonPath?: string;
  daemonPath?: string;
  model?: string;
  mode?: 'mic' | 'audio' | 'script';
  audioPath?: string;
  scriptPath?: string;
  chunkMs?: number;
  partialIntervalMs?: number;
  silenceMs?: number;
  device?: string;
  utteranceIdPrefix?: string;
  saveAudioPath?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class ParakeetTranscriptSource implements TranscriptSource {
  private readonly source: JsonlTranscriptSourceProcess;

  constructor(
    private readonly options: ParakeetTranscriptSourceOptions,
    callbacks: TranscriptSourceCallbacks,
  ) {
    const pythonPath = this.options.pythonPath ?? defaultPythonPath();
    const daemonPath = this.options.daemonPath ?? defaultDaemonPath();
    this.source = new JsonlTranscriptSourceProcess({
      command: pythonPath,
      args: [daemonPath, ...buildDaemonArgs(this.options)],
      env: this.options.env,
      label: 'Parakeet',
    }, callbacks);
  }

  start(): void {
    this.source.start();
  }

  stop(): void {
    this.source.stop();
  }
}

function defaultPythonPath(): string {
  return process.env.PORTOLAN_PARAKEET_PYTHON ?? '/opt/homebrew/bin/python3.13';
}

function defaultDaemonPath(): string {
  return new URL('../voice-ingress/parakeet_daemon.py', import.meta.url).pathname;
}

export function buildDaemonArgs(options: ParakeetTranscriptSourceOptions): string[] {
  const args: string[] = [];
  const mode = options.mode ?? 'mic';
  if (mode === 'mic') {
    args.push('--mic');
    if (options.device) args.push('--device', options.device);
  } else if (mode === 'audio') {
    if (!options.audioPath) {
      throw new Error('parakeet audio mode requires audioPath');
    }
    args.push('--audio', options.audioPath);
  } else if (mode === 'script') {
    if (!options.scriptPath) {
      throw new Error('parakeet script mode requires scriptPath');
    }
    args.push('--script', options.scriptPath);
  }
  if (options.model) args.push('--model', options.model);
  if (options.chunkMs !== undefined) args.push('--chunk-ms', String(options.chunkMs));
  if (options.partialIntervalMs !== undefined) args.push('--partial-interval-ms', String(options.partialIntervalMs));
  if (options.silenceMs !== undefined) args.push('--silence-ms', String(options.silenceMs));
  if (options.utteranceIdPrefix) args.push('--id-prefix', options.utteranceIdPrefix);
  if (options.saveAudioPath) args.push('--save-audio', options.saveAudioPath);
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}
