import { spawn } from 'child_process';
import type { TranscriptSource, TranscriptSourceCallbacks } from './VoiceInkTranscriptSource.js';

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
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class ParakeetTranscriptSource implements TranscriptSource {
  private process: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private stopped = false;

  constructor(
    private readonly options: ParakeetTranscriptSourceOptions,
    private readonly callbacks: TranscriptSourceCallbacks,
  ) {}

  start(): void {
    if (this.process) return;

    const pythonPath = this.options.pythonPath ?? defaultPythonPath();
    const daemonPath = this.options.daemonPath ?? defaultDaemonPath();
    const args = [daemonPath, ...buildDaemonArgs(this.options)];

    const proc = spawn(pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.options.env ?? process.env,
    });
    this.process = proc;

    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.flushStdoutLines();
    });

    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
    });

    proc.on('error', (error) => {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });

    proc.on('exit', (code, signal) => {
      this.flushStdoutLines(true);
      const stderr = this.stderrBuffer.trim();
      this.process = null;
      if (!this.stopped && code !== 0 && stderr) {
        this.callbacks.onError(new Error(`Parakeet daemon exited (${code}): ${stderr}`));
      }
      this.callbacks.onExit(code, signal);
    });
  }

  stop(): void {
    this.stopped = true;
    if (!this.process) return;
    this.process.kill();
    this.process = null;
  }

  private flushStdoutLines(flushRemainder = false): void {
    const parts = this.stdoutBuffer.split('\n');
    const lines = flushRemainder ? parts : parts.slice(0, -1);
    this.stdoutBuffer = flushRemainder ? '' : (parts.at(-1) ?? '');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.callbacks.onChunk(JSON.parse(trimmed));
      } catch {
        this.callbacks.onError(new Error(`Failed to parse Parakeet daemon JSON: ${trimmed}`));
      }
    }
  }
}

function defaultPythonPath(): string {
  return process.env.PORTOLAN_PARAKEET_PYTHON ?? '/opt/homebrew/bin/python3.13';
}

function defaultDaemonPath(): string {
  return new URL('../voice-ingress/parakeet_daemon.py', import.meta.url).pathname;
}

function buildDaemonArgs(options: ParakeetTranscriptSourceOptions): string[] {
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
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}
