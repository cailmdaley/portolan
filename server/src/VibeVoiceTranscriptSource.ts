import {
  JsonlTranscriptSourceProcess,
  type TranscriptSource,
  type TranscriptSourceCallbacks,
} from './JsonlTranscriptSourceProcess.js';

export interface VibeVoiceTranscriptSourceOptions {
  pythonPath?: string;
  daemonPath?: string;
  model?: string;
  mode?: 'audio' | 'script';
  audioPath?: string;
  scriptPath?: string;
  prompt?: string;
  device?: 'auto' | 'cuda' | 'cpu' | 'mps' | 'xpu';
  dtype?: 'auto' | 'bfloat16' | 'float16' | 'float32';
  maxNewTokens?: number;
  acousticTokenizerChunkSize?: number;
  tokenizerChunkSize?: number;
  utteranceIdPrefix?: string;
  stopEscalationMs?: number;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_VIBEVOICE_STOP_ESCALATION_MS = 10 * 60 * 1000;

export class VibeVoiceTranscriptSource implements TranscriptSource {
  private readonly source: JsonlTranscriptSourceProcess;

  constructor(
    private readonly options: VibeVoiceTranscriptSourceOptions,
    callbacks: TranscriptSourceCallbacks,
  ) {
    const pythonPath = this.options.pythonPath ?? defaultPythonPath();
    const daemonPath = this.options.daemonPath ?? defaultDaemonPath();
    this.source = new JsonlTranscriptSourceProcess({
      command: pythonPath,
      args: [daemonPath, ...buildDaemonArgs(this.options)],
      env: this.options.env,
      label: 'VibeVoice',
      stopEscalationMs: this.options.stopEscalationMs ?? DEFAULT_VIBEVOICE_STOP_ESCALATION_MS,
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
  return process.env.PORTOLAN_VIBEVOICE_PYTHON
    ?? process.env.PORTOLAN_PARAKEET_PYTHON
    ?? 'python3';
}

function defaultDaemonPath(): string {
  return new URL('../voice-ingress/vibevoice_asr_daemon.py', import.meta.url).pathname;
}

export function buildDaemonArgs(options: VibeVoiceTranscriptSourceOptions): string[] {
  const args: string[] = [];
  const mode = options.mode ?? 'audio';
  if (mode === 'audio') {
    if (!options.audioPath) {
      throw new Error('vibevoice audio mode requires audioPath');
    }
    args.push('--audio', options.audioPath);
  } else if (mode === 'script') {
    if (!options.scriptPath) {
      throw new Error('vibevoice script mode requires scriptPath');
    }
    args.push('--script', options.scriptPath);
  }
  if (options.model) args.push('--model', options.model);
  if (options.prompt) args.push('--prompt', options.prompt);
  if (options.device) args.push('--device', options.device);
  if (options.dtype) args.push('--dtype', options.dtype);
  if (options.maxNewTokens !== undefined) args.push('--max-new-tokens', String(options.maxNewTokens));
  const acousticTokenizerChunkSize = options.acousticTokenizerChunkSize ?? options.tokenizerChunkSize;
  if (acousticTokenizerChunkSize !== undefined) {
    args.push('--acoustic-tokenizer-chunk-size', String(acousticTokenizerChunkSize));
  }
  if (options.utteranceIdPrefix) args.push('--id-prefix', options.utteranceIdPrefix);
  if (options.extraArgs) args.push(...options.extraArgs);
  return args;
}
