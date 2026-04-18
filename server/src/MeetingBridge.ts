import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { TmuxSessionTarget } from './TmuxSessionMessenger.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';
import type {
  TranscriptSource,
  ParakeetTranscriptSourceOptions,
} from './ParakeetTranscriptSource.js';

export interface MeetingBridgeTarget extends TmuxSessionTarget {
  sessionId: string;
  originId: string;
  cwd: string;
}

export interface MeetingBridgeStartOptions {
  target: MeetingBridgeTarget;
  initialPrompt?: string;
  parakeet?: ParakeetTranscriptSourceOptions;
}

export interface MeetingTranscriptEntry {
  chunkIndex: number;
  receivedAt: number;
  revisionIndex?: number;
  sourceChunkId?: string;
  timestampLocal?: string;
  status?: string;
  speaker?: string;
  isPartial?: boolean;
  isRevision?: boolean;
  text: string;
}

export interface MeetingRunState {
  meetingId: string;
  status: 'running' | 'stopped' | 'error';
  startedAt: number;
  stoppedAt?: number;
  sessionId: string;
  tmuxSession: string;
  originId: string;
  sshHost?: string;
  cityPath: string;
  transcriptPath: string;
  transcriptMarkdownPath: string;
  currentMeetingSymlinkPath?: string;
  audioPath?: string;
  metadataPath: string;
  bootstrapSentAt?: number;
  bootstrapMessage?: string;
  chunkCount: number;
  lastChunkAt?: number;
  lastChunkPreview?: string;
  lastError?: string;
  recentTranscriptChunks: MeetingTranscriptEntry[];
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
  createParakeetSource(
    options: ParakeetTranscriptSourceOptions,
    callbacks: {
      onChunk: (chunk: unknown) => void;
      onError: (error: Error) => void;
      onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    },
  ): TranscriptSource;
}

interface NormalizedTranscriptChunk {
  chunkIndex: number;
  revisionIndex: number;
  sourceChunkId: string | null;
  timestampLocal: string | null;
  durationSeconds: number | null;
  status: string | null;
  speaker: string | null;
  isPartial: boolean;
  isRevision: boolean;
  text: string;
  raw: unknown;
}

const MAX_RECENT_TRANSCRIPT_CHUNKS = 6;

export class MeetingBridge {
  private readonly baseDir: string;
  private readonly latestStatePath: string;
  private readonly messenger: MeetingBridgeMessageSender;
  private readonly sourceFactory: MeetingTranscriptSourceFactory;
  private readonly stateListeners = new Set<MeetingBridgeStateListener>();
  private readonly chunkSources = new Map<string, { chunkIndex: number; revisionIndex: number; text: string; status: string | null }>();
  private readonly transcriptByIndex = new Map<number, { text: string; isPartial: boolean; speaker?: string }>();
  private activeSource: TranscriptSource | null = null;
  private state: MeetingBridgeState = {
    activeMeeting: null,
    lastMeeting: null,
  };

  constructor(options: {
    baseDir?: string;
    messenger?: MeetingBridgeMessageSender;
    sourceFactory?: Partial<MeetingTranscriptSourceFactory>;
  } = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.portolan', 'meetings');
    this.latestStatePath = join(this.baseDir, 'latest-meeting.json');
    this.messenger = options.messenger ?? new TmuxSessionMessenger();
    // The default createParakeetSource throws rather than spawning a real
    // daemon. Production wires in the real factory at construction time
    // (see server/src/index.ts). Tests that hit meeting start must inject a
    // fake. This guardrail exists because leaked parakeet-mlx daemons have
    // OOM'd the host twice: each loads ~2–3 GB, and a forgotten mock in even
    // one test can spawn ~20 of them across a run.
    this.sourceFactory = {
      createParakeetSource: () => {
        throw new Error(
          'MeetingBridge.createParakeetSource not injected — refusing to spawn a real Parakeet daemon. '
            + 'Production wires the factory in index.ts; tests must pass sourceFactory.createParakeetSource.',
        );
      },
      ...options.sourceFactory,
    };
    mkdirSync(this.baseDir, { recursive: true });
    this.state.lastMeeting = this.loadPersistedMeetingState();
  }

  getState(): MeetingBridgeState {
    return {
      activeMeeting: this.state.activeMeeting ? cloneMeetingRunState(this.state.activeMeeting) : null,
      lastMeeting: this.state.lastMeeting ? cloneMeetingRunState(this.state.lastMeeting) : null,
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
    this.chunkSources.clear();
    this.transcriptByIndex.clear();

    const startedAt = Date.now();
    const meetingId = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${sanitizeSegment(options.target.tmuxSession)}`;
    const meetingDir = join(
      this.baseDir,
      `${meetingId}-${sanitizeSegment(basename(options.target.cwd) || 'meeting')}`,
    );
    mkdirSync(meetingDir, { recursive: true });

    const transcriptPath = join(meetingDir, 'transcript.jsonl');
    const transcriptMarkdownPath = join(meetingDir, 'transcript.md');
    const metadataPath = join(meetingDir, 'meeting.json');

    const run: MeetingRunState = {
      meetingId,
      status: 'running',
      startedAt,
      sessionId: options.target.sessionId,
      tmuxSession: options.target.tmuxSession,
      originId: options.target.originId,
      sshHost: options.target.sshHost,
      cityPath: options.target.cwd,
      transcriptPath,
      transcriptMarkdownPath,
      metadataPath,
      chunkCount: 0,
      recentTranscriptChunks: [],
    };

    this.state.activeMeeting = run;
    this.state.lastMeeting = { ...run };
    writeFileSync(transcriptMarkdownPath, '');
    this.installCurrentMeetingSymlink(run);
    this.writeMetadata(run);

    try {
      const parakeetOptions = this.withParakeetDefaults(options.parakeet ?? {}, meetingDir);
      run.audioPath = parakeetOptions.saveAudioPath;

      const bootstrapMessage = options.initialPrompt?.trim() || this.buildBootstrapPrompt(run);
      this.messenger.send(options.target, bootstrapMessage, { pressEnter: true });
      run.bootstrapSentAt = Date.now();
      run.bootstrapMessage = bootstrapMessage;
      this.writeMetadata(run);

      const source = this.sourceFactory.createParakeetSource(parakeetOptions, {
        onChunk: (chunk) => this.handleChunk(run, chunk),
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
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      run.lastError = err.message;
      this.finishRun(run, 'error');
      throw err;
    }

    this.emitStateChanged();
    return cloneMeetingRunState(run);
  }

  stop(): MeetingRunState | null {
    const active = this.state.activeMeeting;
    if (!active) {
      return this.state.lastMeeting ? cloneMeetingRunState(this.state.lastMeeting) : null;
    }

    const source = this.activeSource;
    this.activeSource = null;
    if (source) {
      source.stop();
    }

    if (active.status === 'running') {
      this.finishRun(active, 'stopped');
    }
    return cloneMeetingRunState(active);
  }

  ingestChunk(rawChunk: unknown): MeetingRunState {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }
    this.handleChunk(active, rawChunk);
    return cloneMeetingRunState(active);
  }

  ingestChunks(rawChunks: unknown[]): MeetingRunState {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }
    for (const rawChunk of rawChunks) {
      this.handleChunk(active, rawChunk);
    }
    return cloneMeetingRunState(active);
  }

  private handleChunk(run: MeetingRunState, rawChunk: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const chunk = this.normalizeChunk(rawChunk, run.chunkCount + 1);
      this.recordChunkSource(chunk);
      run.chunkCount = Math.max(run.chunkCount, chunk.chunkIndex);
      run.lastChunkAt = Date.now();
      run.lastChunkPreview = chunk.text.slice(0, 160) || chunk.sourceChunkId || undefined;

      appendJsonLine(run.transcriptPath, {
        meetingId: run.meetingId,
        receivedAt: run.lastChunkAt,
        chunkIndex: chunk.chunkIndex,
        revisionIndex: chunk.revisionIndex,
        sourceChunkId: chunk.sourceChunkId,
        timestampLocal: chunk.timestampLocal,
        durationSeconds: chunk.durationSeconds,
        status: chunk.status,
        speaker: chunk.speaker,
        isPartial: chunk.isPartial,
        isRevision: chunk.isRevision,
        text: chunk.text,
        raw: chunk.raw,
      });
      run.recentTranscriptChunks = upsertRecentTranscriptItem(run.recentTranscriptChunks, {
        chunkIndex: chunk.chunkIndex,
        receivedAt: run.lastChunkAt,
        revisionIndex: chunk.revisionIndex,
        sourceChunkId: chunk.sourceChunkId ?? undefined,
        timestampLocal: chunk.timestampLocal ?? undefined,
        status: chunk.status ?? undefined,
        speaker: chunk.speaker ?? undefined,
        isPartial: chunk.isPartial || undefined,
        isRevision: chunk.isRevision || undefined,
        text: chunk.text,
      });

      // File-backed delivery: chunks accumulate in transcript.md, read by the
      // worker's /loop tick via the cwd-local symlink. No per-chunk messenger
      // injection — that would thrash the agent's turn boundaries.
      this.transcriptByIndex.set(chunk.chunkIndex, {
        text: chunk.text,
        isPartial: !!chunk.isPartial,
        speaker: chunk.speaker ?? undefined,
      });
      this.writeTranscriptMarkdown(run);
      this.writeMetadata(run);
      this.emitStateChanged();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleError(run, err);
    }
  }

  private writeTranscriptMarkdown(run: MeetingRunState): void {
    const indices = [...this.transcriptByIndex.keys()].sort((a, b) => a - b);
    const paragraphs: string[] = [];
    for (const index of indices) {
      const entry = this.transcriptByIndex.get(index);
      if (!entry) continue;
      const trimmed = entry.text.trim();
      if (!trimmed) continue;
      const speaker = entry.speaker?.trim();
      const body = speaker ? `${speaker}: ${trimmed}` : trimmed;
      paragraphs.push(entry.isPartial ? `${body} …` : body);
    }
    const body = paragraphs.length > 0 ? `${paragraphs.join('\n\n')}\n` : '';
    writeFileSync(run.transcriptMarkdownPath, body);
  }

  private installCurrentMeetingSymlink(run: MeetingRunState): void {
    if (run.originId !== 'local') return;
    try {
      if (!statSync(run.cityPath).isDirectory()) return;
    } catch {
      return;
    }
    const dotPortolanDir = join(run.cityPath, '.portolan');
    const symlinkPath = join(dotPortolanDir, 'current-meeting.md');
    try {
      mkdirSync(dotPortolanDir, { recursive: true });
      try {
        lstatSync(symlinkPath);
        unlinkSync(symlinkPath);
      } catch {
        // Nothing to clean up.
      }
      symlinkSync(run.transcriptMarkdownPath, symlinkPath);
      run.currentMeetingSymlinkPath = symlinkPath;
    } catch {
      // Best effort; a missing/unwritable cwd must not break the meeting.
    }
  }

  private teardownCurrentMeetingSymlink(run: MeetingRunState): void {
    if (!run.currentMeetingSymlinkPath) return;
    try {
      const stats = lstatSync(run.currentMeetingSymlinkPath);
      if (stats.isSymbolicLink()) {
        unlinkSync(run.currentMeetingSymlinkPath);
      }
    } catch {
      // Already gone.
    }
    run.currentMeetingSymlinkPath = undefined;
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
    this.chunkSources.clear();
    this.transcriptByIndex.clear();
    this.teardownCurrentMeetingSymlink(run);
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

  private withParakeetDefaults(
    options: ParakeetTranscriptSourceOptions,
    meetingDir: string,
  ): ParakeetTranscriptSourceOptions {
    // Archive raw mic PCM alongside transcript.jsonl so a handoff can replay the
    // same meeting through different models or tuning without re-recording. Mic
    // mode only — --audio already has the source file, --script has no audio.
    const mode = options.mode ?? 'mic';
    if (mode === 'mic' && options.saveAudioPath === undefined) {
      return { ...options, saveAudioPath: join(meetingDir, 'audio.wav') };
    }
    return options;
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
    const sourceChunkId = maybeString(record.id);
    const prior = sourceChunkId ? this.chunkSources.get(sourceChunkId) : null;
    const status = maybeString(record.status);
    return {
      chunkIndex: prior?.chunkIndex ?? chunkIndex,
      revisionIndex: (prior?.revisionIndex ?? 0) + 1,
      sourceChunkId,
      timestampLocal: maybeString(record.timestamp_local),
      durationSeconds: maybeNumber(record.duration_s),
      status,
      speaker: maybeString(record.speaker),
      isPartial: isPartialTranscriptStatus(status),
      isRevision: !!prior,
      text: selectTranscriptText(record),
      raw: rawChunk,
    };
  }

  private recordChunkSource(chunk: NormalizedTranscriptChunk): void {
    if (!chunk.sourceChunkId) return;
    this.chunkSources.set(chunk.sourceChunkId, {
      chunkIndex: chunk.chunkIndex,
      revisionIndex: chunk.revisionIndex,
      text: chunk.text,
      status: chunk.status,
    });
  }

  private buildBootstrapPrompt(run: MeetingRunState): string {
    const transcriptRef = run.currentMeetingSymlinkPath
      ? '.portolan/current-meeting.md'
      : run.transcriptMarkdownPath;
    const fallbackNote = run.currentMeetingSymlinkPath
      ? ` (absolute: ${run.transcriptMarkdownPath})`
      : '';
    return [
      'A live meeting is now streaming to a transcript file you can read on demand.',
      '',
      `Transcript: ${transcriptRef}${fallbackNote}`,
      '',
      'Partials end with "…" and settle into plain text as each utterance is confirmed. Treat passages as tentative transcript evidence, not settled conclusions.',
      '',
      'If you want to monitor the meeting in the background, consider starting a `/loop` tick — for example `/loop` (self-paced) — that re-reads the transcript each iteration and acts only when there is something worth acting on. Actionable moments to watch for:',
      '  • a **plot** worth pulling up (send the path to this worker)',
      '  • a **todo** worth adding',
      '  • a quick **computation** or **check** worth running',
      '  • a **fiber** worth updating or creating via `felt`',
      '  • a **decision** worth filing',
      '',
      'Do not interrupt the humans. Do not respond unless there is something worth acting on. Do not poll the transcript continuously outside of `/loop` — read it on demand when the humans reference it or when a `/loop` tick fires.',
      '',
      'If you would rather leave `/loop` off, that is fine: simply read the transcript file when asked.',
    ].join('\n');
  }
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maybeString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maybeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function maybeMeetingStatus(value: unknown): MeetingRunState['status'] | null {
  return value === 'running' || value === 'stopped' || value === 'error' ? value : null;
}

function selectTranscriptText(record: Record<string, unknown>): string {
  const primary = maybeString(record.text);
  if (primary) return primary;
  const partial = maybeString(record.partial);
  if (partial) return partial;
  return '';
}

function isPartialTranscriptStatus(status: string | null): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase();
  return normalized === 'partial' || normalized === 'tentative' || normalized === 'interim';
}

function upsertRecentTranscriptItem(
  items: MeetingTranscriptEntry[],
  item: MeetingTranscriptEntry,
): MeetingTranscriptEntry[] {
  const filtered = items.filter((existing) => existing.chunkIndex !== item.chunkIndex);
  filtered.push(item);
  filtered.sort((a, b) => a.receivedAt - b.receivedAt);
  return filtered.slice(-MAX_RECENT_TRANSCRIPT_CHUNKS);
}

function cloneMeetingRunState(run: MeetingRunState): MeetingRunState {
  return {
    ...run,
    recentTranscriptChunks: run.recentTranscriptChunks.map((item) => ({ ...item })),
  };
}

function parseTranscriptEntries(value: unknown): MeetingTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: MeetingTranscriptEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const chunkIndex = maybeNumber(raw.chunkIndex);
    const receivedAt = maybeNumber(raw.receivedAt);
    const text = maybeString(raw.text);
    if (chunkIndex === null || receivedAt === null || text === null) continue;
    entries.push({
      chunkIndex,
      receivedAt,
      text,
      revisionIndex: maybeNumber(raw.revisionIndex) ?? undefined,
      sourceChunkId: maybeString(raw.sourceChunkId) ?? undefined,
      timestampLocal: maybeString(raw.timestampLocal) ?? undefined,
      status: maybeString(raw.status) ?? undefined,
      speaker: maybeString(raw.speaker) ?? undefined,
      isPartial: maybeBoolean(raw.isPartial) ?? undefined,
      isRevision: maybeBoolean(raw.isRevision) ?? undefined,
    });
  }
  return entries;
}

function parseMeetingRunState(value: unknown): MeetingRunState | null {
  if (!isRecord(value)) return null;
  const meetingId = maybeString(value.meetingId);
  const status = maybeMeetingStatus(value.status);
  const startedAt = maybeNumber(value.startedAt);
  const sessionId = maybeString(value.sessionId);
  const tmuxSession = maybeString(value.tmuxSession);
  const originId = maybeString(value.originId);
  const cityPath = maybeString(value.cityPath);
  const transcriptPath = maybeString(value.transcriptPath);
  const transcriptMarkdownPath = maybeString(value.transcriptMarkdownPath);
  const metadataPath = maybeString(value.metadataPath);
  if (
    !meetingId
    || !status
    || startedAt === null
    || !sessionId
    || !tmuxSession
    || !originId
    || !cityPath
    || !transcriptPath
    || !transcriptMarkdownPath
    || !metadataPath
  ) {
    return null;
  }
  return {
    meetingId,
    status,
    startedAt,
    stoppedAt: maybeNumber(value.stoppedAt) ?? undefined,
    sessionId,
    tmuxSession,
    originId,
    sshHost: maybeString(value.sshHost) ?? undefined,
    cityPath,
    transcriptPath,
    transcriptMarkdownPath,
    currentMeetingSymlinkPath: maybeString(value.currentMeetingSymlinkPath) ?? undefined,
    audioPath: maybeString(value.audioPath) ?? undefined,
    metadataPath,
    bootstrapSentAt: maybeNumber(value.bootstrapSentAt) ?? undefined,
    bootstrapMessage: maybeString(value.bootstrapMessage) ?? undefined,
    chunkCount: maybeNumber(value.chunkCount) ?? 0,
    lastChunkAt: maybeNumber(value.lastChunkAt) ?? undefined,
    lastChunkPreview: maybeString(value.lastChunkPreview) ?? undefined,
    lastError: maybeString(value.lastError) ?? undefined,
    recentTranscriptChunks: parseTranscriptEntries(value.recentTranscriptChunks),
  };
}
