import { spawn } from 'child_process';

export interface TranscriptSourceCallbacks {
  onChunk: (chunk: unknown) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface TranscriptSource {
  start(): void;
  stop(): void;
}

export interface JsonlTranscriptSourceProcessOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
  stopEscalationMs?: number;
}

const DEFAULT_STOP_ESCALATION_MS = 2000;

/**
 * Spawn a transcript daemon that writes one JSON object per stdout line.
 * The ASR-specific wrappers own argument construction; this class owns the
 * process lifecycle and JSONL parsing contract shared by all local providers.
 */
export class JsonlTranscriptSourceProcess implements TranscriptSource {
  private process: ReturnType<typeof spawn> | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private stopped = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: JsonlTranscriptSourceProcessOptions,
    private readonly callbacks: TranscriptSourceCallbacks,
  ) {}

  start(): void {
    if (this.process) return;

    const proc = spawn(this.options.command, this.options.args, {
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
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      if (!this.stopped && code !== 0 && stderr) {
        this.callbacks.onError(new Error(`${this.options.label} daemon exited (${code}): ${stderr}`));
      }
      this.callbacks.onExit(code, signal);
    });
  }

  stop(): void {
    this.stopped = true;
    const proc = this.process;
    if (!proc) return;
    proc.kill('SIGTERM');
    const stopEscalationMs = this.options.stopEscalationMs ?? DEFAULT_STOP_ESCALATION_MS;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.process === proc) {
        proc.kill('SIGKILL');
      }
    }, stopEscalationMs);
    if (typeof this.killTimer.unref === 'function') {
      this.killTimer.unref();
    }
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
        this.callbacks.onError(new Error(`Failed to parse ${this.options.label} daemon JSON: ${trimmed}`));
      }
    }
  }
}
