import { spawn } from 'child_process';

export interface VoiceInkTranscriptSourceOptions {
  dbPath?: string;
  pollSeconds?: number;
  includeHistory?: boolean;
}

export interface TranscriptSourceCallbacks {
  onChunk: (chunk: unknown) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface TranscriptSource {
  start(): void;
  stop(): void;
}

export class VoiceInkTranscriptSource implements TranscriptSource {
  private process: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private stopped = false;

  constructor(
    private readonly options: VoiceInkTranscriptSourceOptions,
    private readonly callbacks: TranscriptSourceCallbacks,
  ) {}

  start(): void {
    if (this.process) return;

    const scriptUrl = new URL('../../scripts/tail-voiceink-transcripts.sh', import.meta.url);
    const args = [scriptUrl.pathname];

    if (this.options.includeHistory) {
      args.push('--all');
    }
    if (this.options.dbPath) {
      args.push('--db', this.options.dbPath);
    }
    if (this.options.pollSeconds !== undefined) {
      args.push('--poll-seconds', String(this.options.pollSeconds));
    }

    const proc = spawn('bash', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (!this.stopped && stderr) {
        this.callbacks.onError(new Error(`VoiceInk transcript source exited: ${stderr}`));
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
        this.callbacks.onError(new Error(`Failed to parse VoiceInk transcript JSON: ${trimmed}`));
      }
    }
  }
}
