import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { TmuxSessionTarget } from './TmuxSessionMessenger.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';
import {
  type TranscriptSource,
  type VoiceInkTranscriptSourceOptions,
  VoiceInkTranscriptSource,
} from './VoiceInkTranscriptSource.js';

export interface MeetingBridgeTarget extends TmuxSessionTarget {
  sessionId: string;
  originId: string;
  cwd: string;
}

export interface MeetingBridgeStartOptions {
  target: MeetingBridgeTarget;
  initialPrompt?: string;
  sourceType?: MeetingRunState['sourceType'];
  voiceInk?: VoiceInkTranscriptSourceOptions;
}

export interface MeetingRunState {
  meetingId: string;
  status: 'running' | 'stopped' | 'error';
  sourceType: 'voiceink' | 'manual';
  startedAt: number;
  stoppedAt?: number;
  sessionId: string;
  tmuxSession: string;
  originId: string;
  sshHost?: string;
  cityPath: string;
  transcriptPath: string;
  injectionsPath: string;
  updatesPath: string;
  metadataPath: string;
  bootstrapSentAt?: number;
  chunkCount: number;
  injectedCount: number;
  operatorUpdateCount: number;
  lastChunkAt?: number;
  lastChunkPreview?: string;
  lastOperatorUpdateAt?: number;
  lastOperatorUpdatePreview?: string;
  lastError?: string;
}

export interface MeetingBridgeState {
  activeMeeting: MeetingRunState | null;
  lastMeeting: MeetingRunState | null;
}

type MeetingBridgeStateListener = (state: MeetingBridgeState) => void;

export interface MeetingBridgeMessageSender {
  send(target: TmuxSessionTarget, message: string, options?: { pressEnter?: boolean }): void;
}

export interface MeetingTranscriptSourceFactory {
  createVoiceInkSource(
    options: VoiceInkTranscriptSourceOptions,
    callbacks: {
      onChunk: (chunk: unknown) => void;
      onError: (error: Error) => void;
      onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    },
  ): TranscriptSource;
}

interface NormalizedTranscriptChunk {
  chunkIndex: number;
  sourceChunkId: string | null;
  timestampLocal: string | null;
  durationSeconds: number | null;
  status: string | null;
  speaker: string | null;
  audioFileUrl: string | null;
  text: string;
  raw: unknown;
}

interface NormalizedOperatorUpdate {
  updateIndex: number;
  receivedAt: number;
  kind: string | null;
  text: string;
  raw: unknown;
}

export class MeetingBridge {
  private readonly baseDir: string;
  private readonly latestStatePath: string;
  private readonly messenger: MeetingBridgeMessageSender;
  private readonly sourceFactory: MeetingTranscriptSourceFactory;
  private readonly stateListeners = new Set<MeetingBridgeStateListener>();
  private activeSource: TranscriptSource | null = null;
  private state: MeetingBridgeState = {
    activeMeeting: null,
    lastMeeting: null,
  };

  constructor(options: {
    baseDir?: string;
    messenger?: MeetingBridgeMessageSender;
    sourceFactory?: MeetingTranscriptSourceFactory;
  } = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.portolan', 'meetings');
    this.latestStatePath = join(this.baseDir, 'latest-meeting.json');
    this.messenger = options.messenger ?? new TmuxSessionMessenger();
    this.sourceFactory = options.sourceFactory ?? {
      createVoiceInkSource: (voiceInkOptions, callbacks) => new VoiceInkTranscriptSource(voiceInkOptions, callbacks),
    };
    mkdirSync(this.baseDir, { recursive: true });
    this.state.lastMeeting = this.loadPersistedMeetingState();
  }

  getState(): MeetingBridgeState {
    return {
      activeMeeting: this.state.activeMeeting ? { ...this.state.activeMeeting } : null,
      lastMeeting: this.state.lastMeeting ? { ...this.state.lastMeeting } : null,
    };
  }

  onStateChange(listener: MeetingBridgeStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  start(options: MeetingBridgeStartOptions): MeetingRunState {
    this.stop();

    const startedAt = Date.now();
    const meetingId = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${sanitizeSegment(options.target.tmuxSession)}`;
    const meetingDir = join(
      this.baseDir,
      `${meetingId}-${sanitizeSegment(basename(options.target.cwd) || 'meeting')}`,
    );
    mkdirSync(meetingDir, { recursive: true });

    const transcriptPath = join(meetingDir, 'transcript.jsonl');
    const injectionsPath = join(meetingDir, 'injections.jsonl');
    const updatesPath = join(meetingDir, 'operator-updates.jsonl');
    const metadataPath = join(meetingDir, 'meeting.json');

    const run: MeetingRunState = {
      meetingId,
      status: 'running',
      sourceType: options.sourceType ?? 'voiceink',
      startedAt,
      sessionId: options.target.sessionId,
      tmuxSession: options.target.tmuxSession,
      originId: options.target.originId,
      sshHost: options.target.sshHost,
      cityPath: options.target.cwd,
      transcriptPath,
      injectionsPath,
      updatesPath,
      metadataPath,
      chunkCount: 0,
      injectedCount: 0,
      operatorUpdateCount: 0,
    };

    this.state.activeMeeting = run;
    this.state.lastMeeting = { ...run };
    this.writeMetadata(run);

    try {
      const bootstrapMessage = options.initialPrompt?.trim() || this.buildBootstrapPrompt(run);
      this.messenger.send(options.target, bootstrapMessage, { pressEnter: true });
      run.bootstrapSentAt = Date.now();
      run.injectedCount += 1;
      appendJsonLine(injectionsPath, {
        kind: 'bootstrap',
        sentAt: run.bootstrapSentAt,
        message: bootstrapMessage,
      });
      this.writeMetadata(run);

      if (run.sourceType === 'voiceink') {
        const source = this.sourceFactory.createVoiceInkSource(options.voiceInk ?? {}, {
          onChunk: (chunk) => this.handleChunk(options.target, run, chunk),
          onError: (error) => this.handleError(run, error),
          onExit: () => {
            if (this.state.activeMeeting?.meetingId !== run.meetingId) return;
            if (run.status === 'running') {
              this.finishRun(run, 'stopped');
            }
          },
        });
        this.activeSource = source;
        source.start();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      run.lastError = err.message;
      this.finishRun(run, 'error');
      throw err;
    }

    this.emitStateChanged();
    return { ...run };
  }

  stop(): MeetingRunState | null {
    const active = this.state.activeMeeting;
    if (!active) {
      return this.state.lastMeeting ? { ...this.state.lastMeeting } : null;
    }

    const source = this.activeSource;
    this.activeSource = null;
    if (source) {
      source.stop();
    }

    if (active.status === 'running') {
      this.finishRun(active, 'stopped');
    }
    return { ...active };
  }

  ingestChunk(rawChunk: unknown): MeetingRunState {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }

    const target: MeetingBridgeTarget = {
      sessionId: active.sessionId,
      tmuxSession: active.tmuxSession,
      originId: active.originId,
      cwd: active.cityPath,
      sshHost: active.sshHost,
    };
    this.handleChunk(target, active, rawChunk);
    return { ...active };
  }

  ingestOperatorUpdate(rawUpdate: unknown): MeetingRunState {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }

    const target: MeetingBridgeTarget = {
      sessionId: active.sessionId,
      tmuxSession: active.tmuxSession,
      originId: active.originId,
      cwd: active.cityPath,
      sshHost: active.sshHost,
    };
    this.handleOperatorUpdate(target, active, rawUpdate);
    return { ...active };
  }

  private handleChunk(target: MeetingBridgeTarget, run: MeetingRunState, rawChunk: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const chunk = this.normalizeChunk(rawChunk, run.chunkCount + 1);
      run.chunkCount = chunk.chunkIndex;
      run.lastChunkAt = Date.now();
      run.lastChunkPreview = chunk.text.slice(0, 160) || chunk.sourceChunkId || undefined;

      appendJsonLine(run.transcriptPath, {
        meetingId: run.meetingId,
        receivedAt: run.lastChunkAt,
        chunkIndex: chunk.chunkIndex,
        sourceChunkId: chunk.sourceChunkId,
        timestampLocal: chunk.timestampLocal,
        durationSeconds: chunk.durationSeconds,
        status: chunk.status,
        speaker: chunk.speaker,
        audioFileUrl: chunk.audioFileUrl,
        text: chunk.text,
        raw: chunk.raw,
      });

      if (chunk.text.trim().length > 0) {
        const message = this.buildTranscriptMessage(run, chunk);
        this.messenger.send(target, message, { pressEnter: true });
        run.injectedCount += 1;
        appendJsonLine(run.injectionsPath, {
          kind: 'transcript-chunk',
          chunkIndex: chunk.chunkIndex,
          sourceChunkId: chunk.sourceChunkId,
          sentAt: Date.now(),
          message,
        });
      }

      this.writeMetadata(run);
      this.emitStateChanged();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleError(run, err);
    }
  }

  private handleOperatorUpdate(target: MeetingBridgeTarget, run: MeetingRunState, rawUpdate: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const update = this.normalizeOperatorUpdate(rawUpdate, run.operatorUpdateCount + 1);
      run.operatorUpdateCount = update.updateIndex;
      run.lastOperatorUpdateAt = update.receivedAt;
      run.lastOperatorUpdatePreview = update.text.slice(0, 160);

      appendJsonLine(run.updatesPath, {
        meetingId: run.meetingId,
        updateIndex: update.updateIndex,
        receivedAt: update.receivedAt,
        kind: update.kind,
        text: update.text,
        raw: update.raw,
      });

      const message = this.buildOperatorUpdateMessage(run, update);
      this.messenger.send(target, message, { pressEnter: true });
      run.injectedCount += 1;
      appendJsonLine(run.injectionsPath, {
        kind: 'operator-update',
        updateIndex: update.updateIndex,
        sentAt: Date.now(),
        message,
      });

      this.writeMetadata(run);
      this.emitStateChanged();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw err;
    }
  }

  private handleError(run: MeetingRunState, error: Error): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId) return;
    const source = this.activeSource;
    this.activeSource = null;
    if (source) {
      source.stop();
    }
    run.lastError = error.message;
    this.finishRun(run, 'error');
  }

  private finishRun(run: MeetingRunState, status: 'stopped' | 'error'): void {
    run.status = status;
    run.stoppedAt = Date.now();
    this.activeSource = null;
    this.state.activeMeeting = null;
    this.state.lastMeeting = { ...run };
    this.writeMetadata(run);
    this.emitStateChanged();
  }

  private emitStateChanged(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private writeMetadata(run: MeetingRunState): void {
    writeFileSync(run.metadataPath, JSON.stringify(run, null, 2));
    writeFileSync(this.latestStatePath, JSON.stringify(run, null, 2));
  }

  private loadPersistedMeetingState(): MeetingRunState | null {
    const persisted = this.readPersistedRun(this.latestStatePath) ?? this.findLatestRunFromMeetingDirs();
    if (!persisted) return null;

    if (persisted.status === 'running') {
      return {
        ...persisted,
        status: 'stopped',
        stoppedAt: persisted.stoppedAt ?? Date.now(),
      };
    }

    return persisted;
  }

  private findLatestRunFromMeetingDirs(): MeetingRunState | null {
    let latest: { run: MeetingRunState; sortKey: number } | null = null;

    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = join(this.baseDir, entry.name, 'meeting.json');
      const run = this.readPersistedRun(metadataPath);
      if (!run) continue;
      const sortKey = run.stoppedAt ?? run.startedAt ?? this.safeMtimeMs(metadataPath);
      if (!latest || sortKey > latest.sortKey) {
        latest = { run, sortKey };
      }
    }

    return latest?.run ?? null;
  }

  private readPersistedRun(path: string): MeetingRunState | null {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parseMeetingRunState(raw);
    } catch {
      return null;
    }
  }

  private safeMtimeMs(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  private normalizeChunk(rawChunk: unknown, chunkIndex: number): NormalizedTranscriptChunk {
    const record = isRecord(rawChunk) ? rawChunk : {};
    return {
      chunkIndex,
      sourceChunkId: maybeString(record.id),
      timestampLocal: maybeString(record.timestamp_local),
      durationSeconds: maybeNumber(record.duration_s),
      status: maybeString(record.status),
      speaker: maybeString(record.speaker),
      audioFileUrl: maybeString(record.audio_file_url),
      text: selectTranscriptText(record),
      raw: rawChunk,
    };
  }

  private normalizeOperatorUpdate(rawUpdate: unknown, updateIndex: number): NormalizedOperatorUpdate {
    const record = isRecord(rawUpdate) ? rawUpdate : {};
    const text = maybeString(record.text) ?? maybeString(rawUpdate) ?? '';
    if (!text) {
      throw new Error('Meeting update text is empty');
    }

    return {
      updateIndex,
      receivedAt: Date.now(),
      kind: maybeString(record.kind),
      text,
      raw: rawUpdate,
    };
  }

  private buildBootstrapPrompt(run: MeetingRunState): string {
    return [
      'Portolan meeting assistant mode is now active.',
      `Meeting ID: ${run.meetingId}`,
      `Project path: ${run.cityPath}`,
      `Transcript ingress: ${run.sourceType}`,
      'I will send transcript chunks from local capture as they arrive.',
      'Treat each chunk as tentative transcript evidence, not a settled conclusion.',
      'Maintain a rolling account of candidate decisions, open questions, corrections, and retrieval opportunities.',
      'Prefer retrieving existing local artifacts, fibers, plots, and evidence before proposing fresh computation.',
      'Do not silently harden speculation into accepted claims.',
    ].join('\n');
  }

  private buildTranscriptMessage(run: MeetingRunState, chunk: NormalizedTranscriptChunk): string {
    const lines = [
      '[Portolan Meeting Transcript Chunk]',
      `meeting_id: ${run.meetingId}`,
      `chunk_index: ${chunk.chunkIndex}`,
      `source: ${run.sourceType}`,
    ];

    if (chunk.sourceChunkId) lines.push(`source_chunk_id: ${chunk.sourceChunkId}`);
    if (chunk.timestampLocal) lines.push(`timestamp_local: ${chunk.timestampLocal}`);
    if (chunk.durationSeconds !== null) lines.push(`duration_s: ${chunk.durationSeconds}`);
    if (chunk.status) lines.push(`status: ${chunk.status}`);
    if (chunk.speaker) lines.push(`speaker: ${chunk.speaker}`);
    if (chunk.audioFileUrl) lines.push(`audio_file_url: ${chunk.audioFileUrl}`);
    lines.push('transcript:');
    lines.push(chunk.text);
    lines.push('[/Portolan Meeting Transcript Chunk]');
    return lines.join('\n');
  }

  private buildOperatorUpdateMessage(run: MeetingRunState, update: NormalizedOperatorUpdate): string {
    const lines = [
      '[Portolan Meeting Operator Update]',
      `meeting_id: ${run.meetingId}`,
      `update_index: ${update.updateIndex}`,
      `received_at: ${update.receivedAt}`,
    ];

    if (update.kind) lines.push(`kind: ${update.kind}`);
    lines.push('Treat this as an explicit human steering update for the live meeting narrative.');
    lines.push('update:');
    lines.push(update.text);
    lines.push('[/Portolan Meeting Operator Update]');
    return lines.join('\n');
  }
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'meeting';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function maybeString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function selectTranscriptText(record: Record<string, unknown>): string {
  const enhanced = maybeString(record.enhanced_text);
  if (enhanced) return enhanced;
  return maybeString(record.text) ?? '';
}

function parseMeetingRunState(value: unknown): MeetingRunState | null {
  if (!isRecord(value)) return null;

  const meetingId = maybeString(value.meetingId);
  const status = maybeMeetingStatus(value.status);
  const sourceType = maybeSourceType(value.sourceType);
  const startedAt = maybeNumber(value.startedAt);
  const sessionId = maybeString(value.sessionId);
  const tmuxSession = maybeString(value.tmuxSession);
  const originId = maybeString(value.originId);
  const cityPath = maybeString(value.cityPath);
  const transcriptPath = maybeString(value.transcriptPath);
  const injectionsPath = maybeString(value.injectionsPath);
  const updatesPath = maybeString(value.updatesPath);
  const metadataPath = maybeString(value.metadataPath);
  const chunkCount = maybeNumber(value.chunkCount);
  const injectedCount = maybeNumber(value.injectedCount);
  const operatorUpdateCount = maybeNumber(value.operatorUpdateCount);

  if (
    !meetingId
    || !status
    || !sourceType
    || startedAt === null
    || !sessionId
    || !tmuxSession
    || !originId
    || !cityPath
    || !transcriptPath
    || !injectionsPath
    || !metadataPath
    || chunkCount === null
    || injectedCount === null
  ) {
    return null;
  }

  const resolvedUpdatesPath = updatesPath ?? join(dirname(metadataPath), 'operator-updates.jsonl');

  return {
    meetingId,
    status,
    sourceType,
    startedAt,
    stoppedAt: maybeNumber(value.stoppedAt) ?? undefined,
    sessionId,
    tmuxSession,
    originId,
    sshHost: maybeString(value.sshHost) ?? undefined,
    cityPath,
    transcriptPath,
    injectionsPath,
    updatesPath: resolvedUpdatesPath,
    metadataPath,
    bootstrapSentAt: maybeNumber(value.bootstrapSentAt) ?? undefined,
    chunkCount,
    injectedCount,
    operatorUpdateCount: operatorUpdateCount ?? 0,
    lastChunkAt: maybeNumber(value.lastChunkAt) ?? undefined,
    lastChunkPreview: maybeString(value.lastChunkPreview) ?? undefined,
    lastOperatorUpdateAt: maybeNumber(value.lastOperatorUpdateAt) ?? undefined,
    lastOperatorUpdatePreview: maybeString(value.lastOperatorUpdatePreview) ?? undefined,
    lastError: maybeString(value.lastError) ?? undefined,
  };
}

function maybeMeetingStatus(value: unknown): MeetingRunState['status'] | null {
  return value === 'running' || value === 'stopped' || value === 'error' ? value : null;
}

function maybeSourceType(value: unknown): MeetingRunState['sourceType'] | null {
  return value === 'voiceink' || value === 'manual' ? value : null;
}
