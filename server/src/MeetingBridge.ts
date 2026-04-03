import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { exec, execFile } from 'child_process';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';
import type { TmuxSessionTarget } from './TmuxSessionMessenger.js';
import { shellEscape } from './ShellPathUtils.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';
import {
  type TranscriptSource,
  type VoiceInkTranscriptSourceOptions,
  VoiceInkTranscriptSource,
} from './VoiceInkTranscriptSource.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

export interface MeetingTranscriptEntry {
  chunkIndex: number;
  receivedAt: number;
  sourceChunkId?: string;
  timestampLocal?: string;
  status?: string;
  speaker?: string;
  text: string;
}

export interface MeetingOperatorUpdateEntry {
  updateIndex: number;
  receivedAt: number;
  kind?: string;
  text: string;
}

export interface MeetingCandidateEventEntry {
  eventIndex: number;
  receivedAt: number;
  kind: string;
  title?: string;
  text: string;
  transcriptChunkIndices: number[];
  operatorUpdateIndices: number[];
  promotedAt?: number;
  promotedFiberId?: string;
}

export interface MeetingRetrievalRequestEntry {
  requestIndex: number;
  receivedAt: number;
  text: string;
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
  candidateEventsPath: string;
  candidatePromotionsPath: string;
  retrievalRequestsPath: string;
  metadataPath: string;
  bootstrapSentAt?: number;
  chunkCount: number;
  injectedCount: number;
  operatorUpdateCount: number;
  candidateEventCount: number;
  promotedCandidateEventCount: number;
  retrievalRequestCount: number;
  lastChunkAt?: number;
  lastChunkPreview?: string;
  lastOperatorUpdateAt?: number;
  lastOperatorUpdatePreview?: string;
  lastCandidateEventAt?: number;
  lastCandidateEventPreview?: string;
  lastPromotedCandidateAt?: number;
  lastPromotedCandidateFiberId?: string;
  lastRetrievalRequestAt?: number;
  lastRetrievalRequestPreview?: string;
  lastError?: string;
  recentTranscriptChunks: MeetingTranscriptEntry[];
  recentOperatorUpdates: MeetingOperatorUpdateEntry[];
  recentCandidateEvents: MeetingCandidateEventEntry[];
  recentRetrievalRequests: MeetingRetrievalRequestEntry[];
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

export interface MeetingFiberPromoter {
  createFiber(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    title: string;
    kind: string;
    body: string;
  }): Promise<string>;
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

interface NormalizedCandidateEvent {
  eventIndex: number;
  receivedAt: number;
  kind: string;
  title: string | null;
  text: string;
  transcriptChunkIndices: number[];
  operatorUpdateIndices: number[];
  promotedAt: number | null;
  promotedFiberId: string | null;
  raw: unknown;
}

interface NormalizedRetrievalRequest {
  requestIndex: number;
  receivedAt: number;
  text: string;
  raw: unknown;
}

const MAX_RECENT_MEETING_ITEMS = 6;

export class MeetingBridge {
  private readonly baseDir: string;
  private readonly latestStatePath: string;
  private readonly messenger: MeetingBridgeMessageSender;
  private readonly sourceFactory: MeetingTranscriptSourceFactory;
  private readonly fiberPromoter: MeetingFiberPromoter;
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
    fiberPromoter?: MeetingFiberPromoter;
  } = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.portolan', 'meetings');
    this.latestStatePath = join(this.baseDir, 'latest-meeting.json');
    this.messenger = options.messenger ?? new TmuxSessionMessenger();
    this.sourceFactory = options.sourceFactory ?? {
      createVoiceInkSource: (voiceInkOptions, callbacks) => new VoiceInkTranscriptSource(voiceInkOptions, callbacks),
    };
    this.fiberPromoter = options.fiberPromoter ?? new DefaultMeetingFiberPromoter();
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
    const candidateEventsPath = join(meetingDir, 'candidate-events.jsonl');
    const candidatePromotionsPath = join(meetingDir, 'candidate-promotions.jsonl');
    const retrievalRequestsPath = join(meetingDir, 'retrieval-requests.jsonl');
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
      candidateEventsPath,
      candidatePromotionsPath,
      retrievalRequestsPath,
      metadataPath,
      chunkCount: 0,
      injectedCount: 0,
      operatorUpdateCount: 0,
      candidateEventCount: 0,
      promotedCandidateEventCount: 0,
      retrievalRequestCount: 0,
      recentTranscriptChunks: [],
      recentOperatorUpdates: [],
      recentCandidateEvents: [],
      recentRetrievalRequests: [],
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

    const target: MeetingBridgeTarget = {
      sessionId: active.sessionId,
      tmuxSession: active.tmuxSession,
      originId: active.originId,
      cwd: active.cityPath,
      sshHost: active.sshHost,
    };
    this.handleChunk(target, active, rawChunk);
    return cloneMeetingRunState(active);
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
    return cloneMeetingRunState(active);
  }

  ingestCandidateEvent(rawEvent: unknown): MeetingRunState {
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
    this.handleCandidateEvent(target, active, rawEvent);
    return cloneMeetingRunState(active);
  }

  ingestRetrievalRequest(rawRequest: unknown): MeetingRunState {
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
    this.handleRetrievalRequest(target, active, rawRequest);
    return cloneMeetingRunState(active);
  }

  async promoteCandidateEvent(eventIndex: number): Promise<MeetingRunState> {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }

    if (!Number.isInteger(eventIndex) || eventIndex < 1) {
      throw new Error(`Meeting candidate event not found: ${eventIndex}`);
    }

    const event = this.readCandidateEvent(active, eventIndex);
    if (!event) {
      throw new Error(`Meeting candidate event not found: ${eventIndex}`);
    }
    if (event.promotedFiberId) {
      throw new Error(`Meeting candidate event already promoted: ${eventIndex}`);
    }

    const title = this.buildPromotedFiberTitle(event);
    const kind = this.mapCandidateKindToFiberKind(event.kind);
    const body = this.buildPromotedFiberBody(active, event);
    const fiberId = await this.fiberPromoter.createFiber({
      cityPath: active.cityPath,
      originId: active.originId,
      sshHost: active.sshHost,
      title,
      kind,
      body,
    });

    const promotedAt = Date.now();
    active.promotedCandidateEventCount += 1;
    active.lastPromotedCandidateAt = promotedAt;
    active.lastPromotedCandidateFiberId = fiberId;

    const recentEvent = active.recentCandidateEvents.find((entry) => entry.eventIndex === eventIndex);
    if (recentEvent) {
      recentEvent.promotedAt = promotedAt;
      recentEvent.promotedFiberId = fiberId;
    }

    appendJsonLine(active.candidatePromotionsPath, {
      meetingId: active.meetingId,
      eventIndex,
      promotedAt,
      fiberId,
      title,
      kind,
    });
    this.writeMetadata(active);
    this.emitStateChanged();
    return cloneMeetingRunState(active);
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
      run.recentTranscriptChunks = appendRecentItem(run.recentTranscriptChunks, {
        chunkIndex: chunk.chunkIndex,
        receivedAt: run.lastChunkAt,
        sourceChunkId: chunk.sourceChunkId ?? undefined,
        timestampLocal: chunk.timestampLocal ?? undefined,
        status: chunk.status ?? undefined,
        speaker: chunk.speaker ?? undefined,
        text: chunk.text,
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
      run.recentOperatorUpdates = appendRecentItem(run.recentOperatorUpdates, {
        updateIndex: update.updateIndex,
        receivedAt: update.receivedAt,
        kind: update.kind ?? undefined,
        text: update.text,
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

  private handleCandidateEvent(target: MeetingBridgeTarget, run: MeetingRunState, rawEvent: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const event = this.normalizeCandidateEvent(rawEvent, run);
      run.candidateEventCount = event.eventIndex;
      run.lastCandidateEventAt = event.receivedAt;
      run.lastCandidateEventPreview = event.title
        ? `${event.kind}: ${event.title}`
        : `${event.kind}: ${event.text.slice(0, 160)}`;

      appendJsonLine(run.candidateEventsPath, {
        meetingId: run.meetingId,
        eventIndex: event.eventIndex,
        receivedAt: event.receivedAt,
        kind: event.kind,
        title: event.title,
        text: event.text,
        transcriptChunkIndices: event.transcriptChunkIndices,
        operatorUpdateIndices: event.operatorUpdateIndices,
        promotedAt: event.promotedAt,
        promotedFiberId: event.promotedFiberId,
        raw: event.raw,
      });
      run.recentCandidateEvents = appendRecentItem(run.recentCandidateEvents, {
        eventIndex: event.eventIndex,
        receivedAt: event.receivedAt,
        kind: event.kind,
        title: event.title ?? undefined,
        text: event.text,
        transcriptChunkIndices: [...event.transcriptChunkIndices],
        operatorUpdateIndices: [...event.operatorUpdateIndices],
        promotedAt: event.promotedAt ?? undefined,
        promotedFiberId: event.promotedFiberId ?? undefined,
      });

      const message = this.buildCandidateEventMessage(run, event);
      this.messenger.send(target, message, { pressEnter: true });
      run.injectedCount += 1;
      appendJsonLine(run.injectionsPath, {
        kind: 'candidate-event',
        eventIndex: event.eventIndex,
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

  private handleRetrievalRequest(target: MeetingBridgeTarget, run: MeetingRunState, rawRequest: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const request = this.normalizeRetrievalRequest(rawRequest, run.retrievalRequestCount + 1);
      run.retrievalRequestCount = request.requestIndex;
      run.lastRetrievalRequestAt = request.receivedAt;
      run.lastRetrievalRequestPreview = request.text.slice(0, 160);

      appendJsonLine(run.retrievalRequestsPath, {
        meetingId: run.meetingId,
        requestIndex: request.requestIndex,
        receivedAt: request.receivedAt,
        text: request.text,
        raw: request.raw,
      });
      run.recentRetrievalRequests = appendRecentItem(run.recentRetrievalRequests, {
        requestIndex: request.requestIndex,
        receivedAt: request.receivedAt,
        text: request.text,
      });

      const message = this.buildRetrievalRequestMessage(run, request);
      this.messenger.send(target, message, { pressEnter: true });
      run.injectedCount += 1;
      appendJsonLine(run.injectionsPath, {
        kind: 'retrieval-request',
        requestIndex: request.requestIndex,
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

  private readCandidateEvent(run: MeetingRunState, eventIndex: number): NormalizedCandidateEvent | null {
    const promotions = new Map<number, { promotedAt: number | null; promotedFiberId: string | null }>();
    for (const entry of readJsonLines(run.candidatePromotionsPath)) {
      if (!isRecord(entry)) continue;
      const promotedEventIndex = maybeNumber(entry.eventIndex);
      if (promotedEventIndex === null) continue;
      promotions.set(promotedEventIndex, {
        promotedAt: maybeNumber(entry.promotedAt),
        promotedFiberId: maybeString(entry.fiberId),
      });
    }

    for (const entry of readJsonLines(run.candidateEventsPath)) {
      const parsed = this.parseCandidateEventLogEntry(entry);
      if (parsed?.eventIndex === eventIndex) {
        const promotion = promotions.get(eventIndex);
        if (promotion) {
          parsed.promotedAt = promotion.promotedAt;
          parsed.promotedFiberId = promotion.promotedFiberId;
        }
        return parsed;
      }
    }
    return null;
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

  private normalizeCandidateEvent(rawEvent: unknown, run: MeetingRunState): NormalizedCandidateEvent {
    const record = isRecord(rawEvent) ? rawEvent : {};
    const text = maybeString(record.text) ?? maybeString(rawEvent) ?? '';
    if (!text) {
      throw new Error('Meeting candidate event text is empty');
    }

    const transcriptChunkIndices = normalizeCandidateProvenanceIndices(
      record.transcriptChunkIndices,
      run.chunkCount,
      'transcript chunk',
    );
    const operatorUpdateIndices = normalizeCandidateProvenanceIndices(
      record.operatorUpdateIndices,
      run.operatorUpdateCount,
      'operator update',
    );
    if (transcriptChunkIndices.length === 0 && operatorUpdateIndices.length === 0) {
      throw new Error('Meeting candidate event requires transcript or operator provenance');
    }

    return {
      eventIndex: run.candidateEventCount + 1,
      receivedAt: Date.now(),
      kind: maybeString(record.kind) ?? 'note',
      title: maybeString(record.title),
      text,
      transcriptChunkIndices,
      operatorUpdateIndices,
      promotedAt: null,
      promotedFiberId: null,
      raw: rawEvent,
    };
  }

  private normalizeRetrievalRequest(rawRequest: unknown, requestIndex: number): NormalizedRetrievalRequest {
    const record = isRecord(rawRequest) ? rawRequest : {};
    const text = maybeString(record.text) ?? maybeString(rawRequest) ?? '';
    if (!text) {
      throw new Error('Meeting retrieval request text is empty');
    }

    return {
      requestIndex,
      receivedAt: Date.now(),
      text,
      raw: rawRequest,
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

  private buildCandidateEventMessage(run: MeetingRunState, event: NormalizedCandidateEvent): string {
    const lines = [
      '[Portolan Meeting Candidate Event]',
      `meeting_id: ${run.meetingId}`,
      `event_index: ${event.eventIndex}`,
      `kind: ${event.kind}`,
      `received_at: ${event.receivedAt}`,
    ];

    if (event.title) lines.push(`title: ${event.title}`);
    if (event.transcriptChunkIndices.length > 0) {
      lines.push(`transcript_chunk_indices: ${event.transcriptChunkIndices.join(', ')}`);
    }
    if (event.operatorUpdateIndices.length > 0) {
      lines.push(`operator_update_indices: ${event.operatorUpdateIndices.join(', ')}`);
    }
    lines.push('This item was explicitly captured by a human from the live meeting. Keep it linked to the cited transcript provenance unless corrected.');
    lines.push('text:');
    lines.push(event.text);
    lines.push('[/Portolan Meeting Candidate Event]');
    return lines.join('\n');
  }

  private buildPromotedFiberTitle(event: NormalizedCandidateEvent): string {
    if (event.title) return event.title;
    const prefix = event.kind === 'question'
      ? 'Meeting question'
      : event.kind === 'decision'
        ? 'Meeting decision'
        : event.kind === 'action-item'
          ? 'Meeting action item'
          : 'Meeting note';
    return `${prefix}: ${event.text.slice(0, 80).trim()}`.replace(/\s+/g, ' ');
  }

  private buildPromotedFiberBody(run: MeetingRunState, event: NormalizedCandidateEvent): string {
    const lines = [
      event.text.trim(),
      '',
      '## Meeting provenance',
      '',
      `- meeting id: ${run.meetingId}`,
      `- candidate event: ${event.eventIndex}`,
      `- meeting metadata: ${run.metadataPath}`,
      `- candidate events log: ${run.candidateEventsPath}`,
    ];

    if (event.transcriptChunkIndices.length > 0) {
      lines.push(`- transcript chunks: ${event.transcriptChunkIndices.join(', ')}`);
      lines.push(`- transcript log: ${run.transcriptPath}`);
    }
    if (event.operatorUpdateIndices.length > 0) {
      lines.push(`- operator updates: ${event.operatorUpdateIndices.join(', ')}`);
      lines.push(`- operator update log: ${run.updatesPath}`);
    }

    return lines.join('\n');
  }

  private mapCandidateKindToFiberKind(kind: string): string {
    if (kind === 'question') return 'question';
    if (kind === 'decision') return 'decision';
    return 'task';
  }

  private parseCandidateEventLogEntry(value: unknown): NormalizedCandidateEvent | null {
    if (!isRecord(value)) return null;
    const eventIndex = maybeNumber(value.eventIndex);
    const receivedAt = maybeNumber(value.receivedAt);
    const kind = maybeString(value.kind);
    const text = maybeString(value.text);
    if (eventIndex === null || receivedAt === null || kind === null || text === null) return null;
    return {
      eventIndex,
      receivedAt,
      kind,
      title: maybeString(value.title),
      text,
      transcriptChunkIndices: maybeNumberList(value.transcriptChunkIndices) ?? [],
      operatorUpdateIndices: maybeNumberList(value.operatorUpdateIndices) ?? [],
      promotedAt: maybeNumber(value.promotedAt),
      promotedFiberId: maybeString(value.promotedFiberId),
      raw: value,
    };
  }

  private buildRetrievalRequestMessage(run: MeetingRunState, request: NormalizedRetrievalRequest): string {
    return [
      '[Portolan Meeting Retrieval Request]',
      `meeting_id: ${run.meetingId}`,
      `request_index: ${request.requestIndex}`,
      `received_at: ${request.receivedAt}`,
      'Treat this as an explicit request to retrieve existing evidence, artifacts, fibers, plots, papers, or decisions before proposing new computation.',
      'request:',
      request.text,
      '[/Portolan Meeting Retrieval Request]',
    ].join('\n');
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

function maybeNumberList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value
    .map((entry) => maybeNumber(entry))
    .filter((entry): entry is number => entry !== null);
  return numbers.length > 0 ? numbers : [];
}

function normalizeCandidateProvenanceIndices(value: unknown, maxIndex: number, label: string): number[] {
  const indices = maybeNumberList(value) ?? [];
  const normalized = Array.from(new Set(indices)).sort((left, right) => left - right);
  for (const index of normalized) {
    if (!Number.isInteger(index) || index < 1 || index > maxIndex) {
      throw new Error(`Meeting candidate event cites invalid ${label} index: ${index}`);
    }
  }
  return normalized;
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
  const candidateEventsPath = maybeString(value.candidateEventsPath);
  const candidatePromotionsPath = maybeString(value.candidatePromotionsPath);
  const retrievalRequestsPath = maybeString(value.retrievalRequestsPath);
  const metadataPath = maybeString(value.metadataPath);
  const chunkCount = maybeNumber(value.chunkCount);
  const injectedCount = maybeNumber(value.injectedCount);
  const operatorUpdateCount = maybeNumber(value.operatorUpdateCount);
  const candidateEventCount = maybeNumber(value.candidateEventCount);
  const promotedCandidateEventCount = maybeNumber(value.promotedCandidateEventCount);
  const retrievalRequestCount = maybeNumber(value.retrievalRequestCount);

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
  const resolvedCandidateEventsPath = candidateEventsPath ?? join(dirname(metadataPath), 'candidate-events.jsonl');
  const resolvedCandidatePromotionsPath = candidatePromotionsPath ?? join(dirname(metadataPath), 'candidate-promotions.jsonl');
  const resolvedRetrievalRequestsPath = retrievalRequestsPath ?? join(dirname(metadataPath), 'retrieval-requests.jsonl');

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
    candidateEventsPath: resolvedCandidateEventsPath,
    candidatePromotionsPath: resolvedCandidatePromotionsPath,
    retrievalRequestsPath: resolvedRetrievalRequestsPath,
    metadataPath,
    bootstrapSentAt: maybeNumber(value.bootstrapSentAt) ?? undefined,
    chunkCount,
    injectedCount,
    operatorUpdateCount: operatorUpdateCount ?? 0,
    candidateEventCount: candidateEventCount ?? 0,
    promotedCandidateEventCount: promotedCandidateEventCount ?? 0,
    retrievalRequestCount: retrievalRequestCount ?? 0,
    lastChunkAt: maybeNumber(value.lastChunkAt) ?? undefined,
    lastChunkPreview: maybeString(value.lastChunkPreview) ?? undefined,
    lastOperatorUpdateAt: maybeNumber(value.lastOperatorUpdateAt) ?? undefined,
    lastOperatorUpdatePreview: maybeString(value.lastOperatorUpdatePreview) ?? undefined,
    lastCandidateEventAt: maybeNumber(value.lastCandidateEventAt) ?? undefined,
    lastCandidateEventPreview: maybeString(value.lastCandidateEventPreview) ?? undefined,
    lastPromotedCandidateAt: maybeNumber(value.lastPromotedCandidateAt) ?? undefined,
    lastPromotedCandidateFiberId: maybeString(value.lastPromotedCandidateFiberId) ?? undefined,
    lastRetrievalRequestAt: maybeNumber(value.lastRetrievalRequestAt) ?? undefined,
    lastRetrievalRequestPreview: maybeString(value.lastRetrievalRequestPreview) ?? undefined,
    lastError: maybeString(value.lastError) ?? undefined,
    recentTranscriptChunks: parseTranscriptEntries(value.recentTranscriptChunks),
    recentOperatorUpdates: parseOperatorUpdateEntries(value.recentOperatorUpdates),
    recentCandidateEvents: parseCandidateEventEntries(value.recentCandidateEvents),
    recentRetrievalRequests: parseRetrievalRequestEntries(value.recentRetrievalRequests),
  };
}

function maybeMeetingStatus(value: unknown): MeetingRunState['status'] | null {
  return value === 'running' || value === 'stopped' || value === 'error' ? value : null;
}

function maybeSourceType(value: unknown): MeetingRunState['sourceType'] | null {
  return value === 'voiceink' || value === 'manual' ? value : null;
}

function cloneMeetingRunState(run: MeetingRunState): MeetingRunState {
  return {
    ...run,
    recentTranscriptChunks: run.recentTranscriptChunks.map((chunk) => ({ ...chunk })),
    recentOperatorUpdates: run.recentOperatorUpdates.map((update) => ({ ...update })),
    recentCandidateEvents: run.recentCandidateEvents.map((event) => ({
      ...event,
      transcriptChunkIndices: [...event.transcriptChunkIndices],
      operatorUpdateIndices: [...event.operatorUpdateIndices],
    })),
    recentRetrievalRequests: run.recentRetrievalRequests.map((request) => ({ ...request })),
  };
}

function appendRecentItem<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-MAX_RECENT_MEETING_ITEMS);
}

function parseTranscriptEntries(value: unknown): MeetingTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const chunkIndex = maybeNumber(entry.chunkIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const text = maybeString(entry.text);
    if (chunkIndex === null || receivedAt === null || text === null) return [];
    return [{
      chunkIndex,
      receivedAt,
      sourceChunkId: maybeString(entry.sourceChunkId) ?? undefined,
      timestampLocal: maybeString(entry.timestampLocal) ?? undefined,
      status: maybeString(entry.status) ?? undefined,
      speaker: maybeString(entry.speaker) ?? undefined,
      text,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

function parseOperatorUpdateEntries(value: unknown): MeetingOperatorUpdateEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const updateIndex = maybeNumber(entry.updateIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const text = maybeString(entry.text);
    if (updateIndex === null || receivedAt === null || text === null) return [];
    return [{
      updateIndex,
      receivedAt,
      kind: maybeString(entry.kind) ?? undefined,
      text,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

function parseCandidateEventEntries(value: unknown): MeetingCandidateEventEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const eventIndex = maybeNumber(entry.eventIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const kind = maybeString(entry.kind);
    const text = maybeString(entry.text);
    if (eventIndex === null || receivedAt === null || kind === null || text === null) return [];
    return [{
      eventIndex,
      receivedAt,
      kind,
      title: maybeString(entry.title) ?? undefined,
      text,
      transcriptChunkIndices: maybeNumberList(entry.transcriptChunkIndices) ?? [],
      operatorUpdateIndices: maybeNumberList(entry.operatorUpdateIndices) ?? [],
      promotedAt: maybeNumber(entry.promotedAt) ?? undefined,
      promotedFiberId: maybeString(entry.promotedFiberId) ?? undefined,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

function parseRetrievalRequestEntries(value: unknown): MeetingRetrievalRequestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const requestIndex = maybeNumber(entry.requestIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const text = maybeString(entry.text);
    if (requestIndex === null || receivedAt === null || text === null) return [];
    return [{
      requestIndex,
      receivedAt,
      text,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

class DefaultMeetingFiberPromoter implements MeetingFiberPromoter {
  async createFiber(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    title: string;
    kind: string;
    body: string;
  }): Promise<string> {
    const feltCmd = `cd ${shellEscape(options.cityPath)} && felt add ${shellEscape(options.title)} -t ${shellEscape(options.kind)} -b ${shellEscape(options.body)}`;
    if (options.originId === 'local') {
      const { stdout } = await execAsync(feltCmd, { timeout: 10000, maxBuffer: 1024 * 1024 });
      return stdout.trim();
    }
    if (!options.sshHost) {
      throw new Error('Remote origin not found');
    }
    const { stdout } = await execFileAsync('ssh', [options.sshHost, feltCmd], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }
}

function readJsonLines(path: string): unknown[] {
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return [];
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}
