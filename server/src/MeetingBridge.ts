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
import {
  type ParakeetTranscriptSourceOptions,
  ParakeetTranscriptSource,
} from './ParakeetTranscriptSource.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

export interface MeetingOperatorUpdateEntry {
  updateIndex: number;
  receivedAt: number;
  kind?: string;
  text: string;
}

export interface MeetingAssistantResponseEntry {
  responseIndex: number;
  receivedAt: number;
  timestamp?: string;
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
  promotedAstraDecisionId?: string;
}

export interface MeetingRetrievalRequestEntry {
  requestIndex: number;
  receivedAt: number;
  text: string;
}

export interface MeetingRetrievedEvidenceEntry {
  evidenceIndex: number;
  receivedAt: number;
  requestIndex?: number;
  type: 'fiber' | 'file';
  title: string;
  fiberId?: string;
  path?: string;
  line?: number;
  match?: string;
}

export interface MeetingBriefPromotionEntry {
  promotionIndex: number;
  receivedAt: number;
  title: string;
  fiberId: string;
  astraAnalysisId?: string;
  astraPath?: string;
}

export interface MeetingLiveBriefItem {
  eventIndex: number;
  receivedAt: number;
  kind: string;
  title?: string;
  text: string;
  transcriptChunkIndices: number[];
  operatorUpdateIndices: number[];
  promotedAt?: number;
  promotedFiberId?: string;
  promotedAstraDecisionId?: string;
}

export interface MeetingLiveBrief {
  currentNarrative?: MeetingOperatorUpdateEntry;
  decisions: MeetingLiveBriefItem[];
  openQuestions: MeetingLiveBriefItem[];
  actionItems: MeetingLiveBriefItem[];
  acceptedNotes: MeetingLiveBriefItem[];
  evidenceInView: MeetingRetrievedEvidenceEntry[];
}

export interface MeetingRunState {
  meetingId: string;
  status: 'running' | 'stopped' | 'error';
  sourceType: 'voiceink' | 'manual' | 'parakeet';
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
  injectionsPath: string;
  updatesPath: string;
  assistantResponsesPath: string;
  candidateEventsPath: string;
  candidatePromotionsPath: string;
  retrievalRequestsPath: string;
  retrievalEvidencePath: string;
  briefPromotionsPath: string;
  liveDocumentPath: string;
  liveAstraPath: string;
  liveAstraAnalysisId: string;
  metadataPath: string;
  bootstrapSentAt?: number;
  chunkCount: number;
  injectedCount: number;
  operatorUpdateCount: number;
  assistantResponseCount: number;
  candidateEventCount: number;
  promotedCandidateEventCount: number;
  retrievalRequestCount: number;
  retrievalEvidenceCount: number;
  briefPromotionCount: number;
  lastChunkAt?: number;
  lastChunkPreview?: string;
  lastOperatorUpdateAt?: number;
  lastOperatorUpdatePreview?: string;
  lastAssistantResponseAt?: number;
  lastAssistantResponsePreview?: string;
  lastCandidateEventAt?: number;
  lastCandidateEventPreview?: string;
  lastPromotedCandidateAt?: number;
  lastPromotedCandidateFiberId?: string;
  lastPromotedCandidateAstraDecisionId?: string;
  lastRetrievalRequestAt?: number;
  lastRetrievalRequestPreview?: string;
  lastRetrievedEvidenceAt?: number;
  lastRetrievedEvidencePreview?: string;
  lastBriefPromotionAt?: number;
  lastBriefPromotionFiberId?: string;
  lastBriefPromotionAstraAnalysisId?: string;
  lastLiveAstraSyncAt?: number;
  lastError?: string;
  recentTranscriptChunks: MeetingTranscriptEntry[];
  recentOperatorUpdates: MeetingOperatorUpdateEntry[];
  recentAssistantResponses: MeetingAssistantResponseEntry[];
  recentCandidateEvents: MeetingCandidateEventEntry[];
  recentRetrievalRequests: MeetingRetrievalRequestEntry[];
  recentRetrievedEvidence: MeetingRetrievedEvidenceEntry[];
  recentBriefPromotions: MeetingBriefPromotionEntry[];
  liveBrief: MeetingLiveBrief;
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
  createParakeetSource(
    options: ParakeetTranscriptSourceOptions,
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

export interface MeetingAstraPromoter {
  upsertDecision(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    decisionId: string;
    label: string;
    rationale: string;
    tags: string[];
    defaultOption: string;
    options: Record<string, { label: string; description: string }>;
  }): Promise<{ decisionId: string; astraPath: string }>;
  upsertMeetingBrief(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    analysisId: string;
    title: string;
    description: string;
    tags: string[];
    inputs: Array<Record<string, unknown>>;
    findings: Record<string, Record<string, unknown>>;
    decisions: Record<string, Record<string, unknown>>;
  }): Promise<{ analysisId: string; astraPath: string }>;
  syncLiveMeetingBrief?(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    analysisId: string;
    title: string;
    description: string;
    tags: string[];
    inputs: Array<Record<string, unknown>>;
    findings: Record<string, Record<string, unknown>>;
    decisions: Record<string, Record<string, unknown>>;
  }): Promise<{ analysisId: string; astraPath: string }>;
}

interface NormalizedTranscriptChunk {
  chunkIndex: number;
  revisionIndex: number;
  sourceChunkId: string | null;
  timestampLocal: string | null;
  durationSeconds: number | null;
  status: string | null;
  speaker: string | null;
  audioFileUrl: string | null;
  isPartial: boolean;
  isRevision: boolean;
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

interface NormalizedAssistantResponse {
  responseIndex: number;
  receivedAt: number;
  timestamp: string | null;
  sourceKey: string;
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
  promotedAstraDecisionId: string | null;
  raw: unknown;
}

interface NormalizedRetrievalRequest {
  requestIndex: number;
  receivedAt: number;
  text: string;
  raw: unknown;
}

interface NormalizedRetrievedEvidence {
  evidenceIndex: number;
  receivedAt: number;
  requestIndex: number | null;
  type: 'fiber' | 'file';
  title: string;
  fiberId: string | null;
  path: string | null;
  line: number | null;
  match: string | null;
  raw: unknown;
}

const MAX_RECENT_MEETING_ITEMS = 6;

export class MeetingBridge {
  private readonly baseDir: string;
  private readonly latestStatePath: string;
  private readonly messenger: MeetingBridgeMessageSender;
  private readonly sourceFactory: MeetingTranscriptSourceFactory;
  private readonly fiberPromoter: MeetingFiberPromoter;
  private readonly astraPromoter: MeetingAstraPromoter;
  private readonly stateListeners = new Set<MeetingBridgeStateListener>();
  private readonly chunkSources = new Map<string, { chunkIndex: number; revisionIndex: number; text: string; status: string | null }>();
  private readonly transcriptByIndex = new Map<number, { text: string; isPartial: boolean; speaker?: string }>();
  private readonly assistantResponseSources = new Set<string>();
  private activeSource: TranscriptSource | null = null;
  private state: MeetingBridgeState = {
    activeMeeting: null,
    lastMeeting: null,
  };

  constructor(options: {
    baseDir?: string;
    messenger?: MeetingBridgeMessageSender;
    sourceFactory?: Partial<MeetingTranscriptSourceFactory>;
    fiberPromoter?: MeetingFiberPromoter;
    astraPromoter?: MeetingAstraPromoter;
  } = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.portolan', 'meetings');
    this.latestStatePath = join(this.baseDir, 'latest-meeting.json');
    this.messenger = options.messenger ?? new TmuxSessionMessenger();
    this.sourceFactory = {
      createVoiceInkSource: (voiceInkOptions, callbacks) => new VoiceInkTranscriptSource(voiceInkOptions, callbacks),
      createParakeetSource: (parakeetOptions, callbacks) => new ParakeetTranscriptSource(parakeetOptions, callbacks),
      ...options.sourceFactory,
    };
    this.fiberPromoter = options.fiberPromoter ?? new DefaultMeetingFiberPromoter();
    this.astraPromoter = options.astraPromoter ?? new DefaultMeetingAstraPromoter();
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
    this.assistantResponseSources.clear();

    const startedAt = Date.now();
    const meetingId = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${sanitizeSegment(options.target.tmuxSession)}`;
    const meetingDir = join(
      this.baseDir,
      `${meetingId}-${sanitizeSegment(basename(options.target.cwd) || 'meeting')}`,
    );
    mkdirSync(meetingDir, { recursive: true });

    const transcriptPath = join(meetingDir, 'transcript.jsonl');
    const transcriptMarkdownPath = join(meetingDir, 'transcript.md');
    const injectionsPath = join(meetingDir, 'injections.jsonl');
    const updatesPath = join(meetingDir, 'operator-updates.jsonl');
    const assistantResponsesPath = join(meetingDir, 'assistant-responses.jsonl');
    const candidateEventsPath = join(meetingDir, 'candidate-events.jsonl');
    const candidatePromotionsPath = join(meetingDir, 'candidate-promotions.jsonl');
    const retrievalRequestsPath = join(meetingDir, 'retrieval-requests.jsonl');
    const retrievalEvidencePath = join(meetingDir, 'retrieved-evidence.jsonl');
    const briefPromotionsPath = join(meetingDir, 'brief-promotions.jsonl');
    const liveDocumentPath = this.resolveLiveDocumentPath(options.target.cwd, meetingDir);
    const liveAstraPath = join(options.target.cwd, 'astra.yaml');
    const liveAstraAnalysisId = this.buildLiveAstraAnalysisId(meetingId);
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
      transcriptMarkdownPath,
      injectionsPath,
      updatesPath,
      assistantResponsesPath,
      candidateEventsPath,
      candidatePromotionsPath,
      retrievalRequestsPath,
      retrievalEvidencePath,
      briefPromotionsPath,
      liveDocumentPath,
      liveAstraPath,
      liveAstraAnalysisId,
      metadataPath,
      chunkCount: 0,
      injectedCount: 0,
      operatorUpdateCount: 0,
      assistantResponseCount: 0,
      candidateEventCount: 0,
      promotedCandidateEventCount: 0,
      retrievalRequestCount: 0,
      retrievalEvidenceCount: 0,
      briefPromotionCount: 0,
      lastBriefPromotionAstraAnalysisId: undefined,
      lastLiveAstraSyncAt: undefined,
      recentTranscriptChunks: [],
      recentOperatorUpdates: [],
      recentAssistantResponses: [],
      recentCandidateEvents: [],
      recentRetrievalRequests: [],
      recentRetrievedEvidence: [],
      recentBriefPromotions: [],
      liveBrief: buildMeetingLiveBrief({
        recentOperatorUpdates: [],
        recentCandidateEvents: [],
        recentRetrievedEvidence: [],
      }),
    };

    this.state.activeMeeting = run;
    this.state.lastMeeting = { ...run };
    writeFileSync(transcriptMarkdownPath, '');
    this.installCurrentMeetingSymlink(run);
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
      } else if (run.sourceType === 'parakeet') {
        const parakeetOptions = this.withParakeetDefaults(options.parakeet ?? {}, meetingDir);
        const source = this.sourceFactory.createParakeetSource(parakeetOptions, {
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

  ingestChunks(rawChunks: unknown[]): MeetingRunState {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }

    for (const rawChunk of rawChunks) {
      this.handleChunk({
        sessionId: active.sessionId,
        tmuxSession: active.tmuxSession,
        originId: active.originId,
        cwd: active.cityPath,
        sshHost: active.sshHost,
      }, active, rawChunk);
    }

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

  ingestAssistantResponses(
    target: Pick<MeetingBridgeTarget, 'sessionId' | 'tmuxSession' | 'originId'>,
    rawResponses: unknown,
    metadata: { transcriptPath?: string; hookSessionId?: string } = {},
  ): MeetingRunState | null {
    const active = this.state.activeMeeting;
    if (!active) {
      return null;
    }
    if (
      active.sessionId !== target.sessionId
      || active.tmuxSession !== target.tmuxSession
      || active.originId !== target.originId
    ) {
      return null;
    }

    this.handleAssistantResponses(active, rawResponses, metadata);
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

  ingestRetrievedEvidence(rawEvidence: unknown): MeetingRunState {
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

    this.handleRetrievedEvidence(target, active, rawEvidence);
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
    const astraPromotion = event.kind === 'decision'
      ? await this.astraPromoter.upsertDecision({
        cityPath: active.cityPath,
        originId: active.originId,
        sshHost: active.sshHost,
        decisionId: this.buildPromotedAstraDecisionId(active, event),
        label: title,
        rationale: this.buildPromotedAstraDecisionRationale(active, event, fiberId),
        tags: ['portolan', 'meeting', 'meeting-decision'],
        defaultOption: 'accepted',
        options: {
          accepted: {
            label: 'Accepted',
            description: 'This meeting decision was explicitly accepted and promoted from the Portolan live meeting lane.',
          },
        },
      })
      : null;
    active.promotedCandidateEventCount += 1;
    active.lastPromotedCandidateAt = promotedAt;
    active.lastPromotedCandidateFiberId = fiberId;
    active.lastPromotedCandidateAstraDecisionId = astraPromotion?.decisionId;

    const recentEvent = active.recentCandidateEvents.find((entry) => entry.eventIndex === eventIndex);
    if (recentEvent) {
      recentEvent.promotedAt = promotedAt;
      recentEvent.promotedFiberId = fiberId;
      recentEvent.promotedAstraDecisionId = astraPromotion?.decisionId;
    }
    active.liveBrief = buildMeetingLiveBrief(active);

    appendJsonLine(active.candidatePromotionsPath, {
      meetingId: active.meetingId,
      eventIndex,
      promotedAt,
      fiberId,
      title,
      kind,
      astraDecisionId: astraPromotion?.decisionId ?? null,
      astraPath: astraPromotion?.astraPath ?? null,
    });
    this.writeMetadata(active);
    this.emitStateChanged();
    return cloneMeetingRunState(active);
  }

  async promoteLiveBrief(title?: string): Promise<MeetingRunState> {
    const active = this.state.activeMeeting;
    if (!active) {
      throw new Error('No active meeting bridge');
    }

    const normalizedTitle = title?.trim() || this.buildPromotedBriefTitle(active);
    const body = this.buildPromotedBriefBody(active, normalizedTitle);
    const fiberId = await this.fiberPromoter.createFiber({
      cityPath: active.cityPath,
      originId: active.originId,
      sshHost: active.sshHost,
      title: normalizedTitle,
      kind: 'task',
      body,
    });
    const astraPromotion = await this.astraPromoter.upsertMeetingBrief({
      cityPath: active.cityPath,
      originId: active.originId,
      sshHost: active.sshHost,
      analysisId: this.buildPromotedAstraBriefAnalysisId(active),
      title: normalizedTitle,
      description: this.buildPromotedBriefAstraDescription(active, fiberId),
      tags: ['portolan', 'meeting', 'meeting-brief'],
      inputs: this.buildPromotedBriefAstraInputs(active),
      findings: this.buildPromotedBriefAstraFindings(active),
      decisions: this.buildPromotedBriefAstraDecisions(active),
    });

    const promotionIndex = active.briefPromotionCount + 1;
    const promotedAt = Date.now();
    active.briefPromotionCount = promotionIndex;
    active.lastBriefPromotionAt = promotedAt;
    active.lastBriefPromotionFiberId = fiberId;
    active.lastBriefPromotionAstraAnalysisId = astraPromotion.analysisId;
    active.recentBriefPromotions = appendRecentItem(active.recentBriefPromotions, {
      promotionIndex,
      receivedAt: promotedAt,
      title: normalizedTitle,
      fiberId,
      astraAnalysisId: astraPromotion.analysisId,
      astraPath: astraPromotion.astraPath,
    });

    appendJsonLine(active.briefPromotionsPath, {
      meetingId: active.meetingId,
      promotionIndex,
      receivedAt: promotedAt,
      title: normalizedTitle,
      fiberId,
      astraAnalysisId: astraPromotion.analysisId,
      astraPath: astraPromotion.astraPath,
    });
    this.writeMetadata(active);
    this.emitStateChanged();
    return cloneMeetingRunState(active);
  }

  private handleChunk(_target: MeetingBridgeTarget, run: MeetingRunState, rawChunk: unknown): void {
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
        audioFileUrl: chunk.audioFileUrl,
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

      // Transcript chunks are delivered to the worker via file, not prompt.
      // See constitution-portolan-voice-ingress §"Delivery to the worker":
      // the bootstrap injection tells Claude to read transcript.md via the
      // cwd-local symlink on demand; per-chunk messenger.send would thrash
      // the agent's turn boundaries.
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
      run.liveBrief = buildMeetingLiveBrief(run);

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
      run.liveBrief = buildMeetingLiveBrief(run);

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

  private handleAssistantResponses(
    run: MeetingRunState,
    rawResponses: unknown,
    metadata: { transcriptPath?: string; hookSessionId?: string } = {},
  ): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    const responses = this.normalizeAssistantResponses(rawResponses, run.assistantResponseCount + 1);
    if (responses.length === 0) {
      return;
    }

    let changed = false;
    for (const response of responses) {
      if (this.assistantResponseSources.has(response.sourceKey)) {
        continue;
      }
      this.assistantResponseSources.add(response.sourceKey);
      changed = true;

      run.assistantResponseCount = response.responseIndex;
      run.lastAssistantResponseAt = response.receivedAt;
      run.lastAssistantResponsePreview = response.text.slice(0, 160);

      appendJsonLine(run.assistantResponsesPath, {
        meetingId: run.meetingId,
        responseIndex: response.responseIndex,
        receivedAt: response.receivedAt,
        timestamp: response.timestamp,
        sourceKey: response.sourceKey,
        transcriptPath: metadata.transcriptPath ?? null,
        hookSessionId: metadata.hookSessionId ?? null,
        text: response.text,
        raw: response.raw,
      });
      run.recentAssistantResponses = appendRecentItem(run.recentAssistantResponses, {
        responseIndex: response.responseIndex,
        receivedAt: response.receivedAt,
        timestamp: response.timestamp ?? undefined,
        text: response.text,
      });
    }

    if (!changed) {
      return;
    }

    this.writeMetadata(run);
    this.emitStateChanged();
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

  private handleRetrievedEvidence(target: MeetingBridgeTarget, run: MeetingRunState, rawEvidence: unknown): void {
    if (this.state.activeMeeting?.meetingId !== run.meetingId || run.status !== 'running') return;

    try {
      const evidence = this.normalizeRetrievedEvidence(rawEvidence, run.retrievalEvidenceCount + 1, run);
      run.retrievalEvidenceCount = evidence.evidenceIndex;
      run.lastRetrievedEvidenceAt = evidence.receivedAt;
      run.lastRetrievedEvidencePreview = evidence.title;

      appendJsonLine(run.retrievalEvidencePath, {
        meetingId: run.meetingId,
        evidenceIndex: evidence.evidenceIndex,
        receivedAt: evidence.receivedAt,
        requestIndex: evidence.requestIndex,
        type: evidence.type,
        title: evidence.title,
        fiberId: evidence.fiberId,
        path: evidence.path,
        line: evidence.line,
        match: evidence.match,
        raw: evidence.raw,
      });
      run.recentRetrievedEvidence = appendRecentItem(run.recentRetrievedEvidence, {
        evidenceIndex: evidence.evidenceIndex,
        receivedAt: evidence.receivedAt,
        requestIndex: evidence.requestIndex ?? undefined,
        type: evidence.type,
        title: evidence.title,
        fiberId: evidence.fiberId ?? undefined,
        path: evidence.path ?? undefined,
        line: evidence.line ?? undefined,
        match: evidence.match ?? undefined,
      });
      run.liveBrief = buildMeetingLiveBrief(run);

      const message = this.buildRetrievedEvidenceMessage(run, evidence);
      this.messenger.send(target, message, { pressEnter: true });
      run.injectedCount += 1;
      appendJsonLine(run.injectionsPath, {
        kind: 'retrieved-evidence',
        evidenceIndex: evidence.evidenceIndex,
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
    const promotions = new Map<number, {
      promotedAt: number | null;
      promotedFiberId: string | null;
      promotedAstraDecisionId: string | null;
    }>();
    for (const entry of readJsonLines(run.candidatePromotionsPath)) {
      if (!isRecord(entry)) continue;
      const promotedEventIndex = maybeNumber(entry.eventIndex);
      if (promotedEventIndex === null) continue;
      promotions.set(promotedEventIndex, {
        promotedAt: maybeNumber(entry.promotedAt),
        promotedFiberId: maybeString(entry.fiberId),
        promotedAstraDecisionId: maybeString(entry.astraDecisionId),
      });
    }

    for (const entry of readJsonLines(run.candidateEventsPath)) {
      const parsed = this.parseCandidateEventLogEntry(entry);
      if (parsed?.eventIndex === eventIndex) {
        const promotion = promotions.get(eventIndex);
        if (promotion) {
          parsed.promotedAt = promotion.promotedAt;
          parsed.promotedFiberId = promotion.promotedFiberId;
          parsed.promotedAstraDecisionId = promotion.promotedAstraDecisionId;
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
    this.chunkSources.clear();
    this.transcriptByIndex.clear();
    this.assistantResponseSources.clear();
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
    // Archive raw mic PCM alongside transcript.jsonl so the human handoff can
    // replay the same meeting through different models (v2/v3) or tuning
    // (silence-ms, partial-interval-ms) without re-recording. Mic mode only —
    // --audio already has the source file, --script has no audio.
    const mode = options.mode ?? 'mic';
    if (mode === 'mic' && options.saveAudioPath === undefined) {
      return { ...options, saveAudioPath: join(meetingDir, 'audio.wav') };
    }
    return options;
  }

  private resolveLiveDocumentPath(cityPath: string, meetingDir: string): string {
    try {
      if (statSync(cityPath).isDirectory()) {
        return join(cityPath, 'meeting-live-brief.md');
      }
    } catch {
      // Fall back to the per-run meeting directory when the city path is unavailable.
    }
    return join(meetingDir, 'live-brief.md');
  }

  private writeMetadata(run: MeetingRunState): void {
    mkdirSync(dirname(run.liveDocumentPath), { recursive: true });
    writeFileSync(run.liveDocumentPath, this.buildLiveDocument(run));
    writeFileSync(run.metadataPath, JSON.stringify(run, null, 2));
    writeFileSync(this.latestStatePath, JSON.stringify(run, null, 2));
    this.syncLiveAstra(run);
  }

  private syncLiveAstra(run: MeetingRunState): void {
    if (!this.astraPromoter.syncLiveMeetingBrief) {
      return;
    }
    if (run.originId === 'local') {
      try {
        if (!statSync(run.cityPath).isDirectory()) {
          return;
        }
      } catch {
        return;
      }
    }

    void this.astraPromoter.syncLiveMeetingBrief({
      cityPath: run.cityPath,
      originId: run.originId,
      sshHost: run.sshHost,
      analysisId: run.liveAstraAnalysisId,
      title: this.buildLiveDocumentTitle(run),
      description: this.buildLiveAstraDescription(run),
      tags: ['portolan', 'meeting', 'meeting-live'],
      inputs: this.buildLiveAstraInputs(run),
      findings: this.buildLiveAstraFindings(run),
      decisions: this.buildPromotedBriefAstraDecisions(run),
    }).then(({ astraPath }) => {
      run.liveAstraPath = astraPath;
      run.lastLiveAstraSyncAt = Date.now();
    }).catch(() => {
      // Live ASTRA sync is best-effort; do not interrupt meeting ingestion.
    });
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
      audioFileUrl: maybeString(record.audio_file_url),
      isPartial: isPartialTranscriptStatus(status),
      isRevision: !!prior,
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
      promotedAstraDecisionId: null,
      raw: rawEvent,
    };
  }

  private normalizeAssistantResponses(rawResponses: unknown, nextResponseIndex: number): NormalizedAssistantResponse[] {
    const items = Array.isArray(rawResponses) ? rawResponses : [rawResponses];
    const normalized: NormalizedAssistantResponse[] = [];
    let responseIndex = nextResponseIndex;

    for (const item of items) {
      const record = isRecord(item) ? item : {};
      const text = maybeString(record.text) ?? maybeString(item);
      if (!text) {
        continue;
      }
      const timestamp = maybeString(record.timestamp);
      const sourceKey = maybeString(record.sourceKey)
        ?? maybeString(record.dedupeKey)
        ?? [timestamp ?? 'assistant', text].join('|');
      normalized.push({
        responseIndex,
        receivedAt: Date.now(),
        timestamp,
        sourceKey,
        text,
        raw: item,
      });
      responseIndex += 1;
    }

    return normalized;
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

  private normalizeRetrievedEvidence(
    rawEvidence: unknown,
    evidenceIndex: number,
    run: MeetingRunState,
  ): NormalizedRetrievedEvidence {
    const record = isRecord(rawEvidence) ? rawEvidence : {};
    const rawType = maybeString(record.type);
    const type = rawType === 'fiber' || rawType === 'file' ? rawType : null;
    const title = maybeString(record.title) ?? '';
    const fiberId = maybeString(record.fiberId);
    const path = maybeString(record.path);
    const line = maybeNumber(record.line);
    const match = maybeString(record.match);
    const requestIndex = maybeNumber(record.requestIndex);

    if (!type) {
      throw new Error('Meeting retrieved evidence type is invalid');
    }
    if (!title.trim()) {
      throw new Error('Meeting retrieved evidence title is empty');
    }
    if (type === 'fiber' && !fiberId) {
      throw new Error('Meeting retrieved evidence fiber is missing fiberId');
    }
    if (type === 'file' && !path) {
      throw new Error('Meeting retrieved evidence file is missing path');
    }
    if (requestIndex !== null && (!Number.isInteger(requestIndex) || requestIndex < 1 || requestIndex > run.retrievalRequestCount)) {
      throw new Error(`Meeting retrieved evidence cites invalid retrieval request index: ${requestIndex}`);
    }

    return {
      evidenceIndex,
      receivedAt: Date.now(),
      requestIndex,
      type,
      title: title.trim(),
      fiberId,
      path,
      line: line !== null && Number.isInteger(line) && line > 0 ? line : null,
      match,
      raw: rawEvidence,
    };
  }

  private buildBootstrapPrompt(run: MeetingRunState): string {
    const transcriptRef = run.currentMeetingSymlinkPath
      ? '.portolan/current-meeting.md (a symlink to the rolling transcript in ~/.portolan/meetings/...)'
      : run.transcriptMarkdownPath;
    return [
      'Portolan meeting assistant mode is now active.',
      `Meeting ID: ${run.meetingId}`,
      `Project path: ${run.cityPath}`,
      `Transcript ingress: ${run.sourceType}`,
      `Transcript file: ${transcriptRef}`,
      'The live transcript accumulates in that file as I speak; partial hypotheses end with "…" and settle into plain text.',
      'Read the file on demand when I reference the meeting ("what did we just say about X?", "pull the last minute"). Do not poll it continuously — the user drives when it is consulted.',
      'Treat each passage as tentative transcript evidence, not a settled conclusion.',
      'Maintain a rolling account of candidate decisions, open questions, corrections, and retrieval opportunities from what you read.',
      'Prefer retrieving existing local artifacts, fibers, plots, and evidence before proposing fresh computation.',
      'Do not silently harden speculation into accepted claims.',
    ].join('\n');
  }

  private recordChunkSource(chunk: NormalizedTranscriptChunk): boolean {
    if (!chunk.sourceChunkId) {
      return true;
    }

    const prior = this.chunkSources.get(chunk.sourceChunkId);
    this.chunkSources.set(chunk.sourceChunkId, {
      chunkIndex: chunk.chunkIndex,
      revisionIndex: chunk.revisionIndex,
      text: chunk.text,
      status: chunk.status,
    });

    if (!prior) {
      return true;
    }

    return prior.text !== chunk.text || prior.status !== chunk.status;
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

  private buildPromotedAstraDecisionId(run: MeetingRunState, event: NormalizedCandidateEvent): string {
    const label = event.title ?? event.text;
    return sanitizeSegment(`meeting-${run.meetingId}-event-${event.eventIndex}-${label.toLowerCase()}`).replace(/\./g, '-');
  }

  private buildPromotedAstraDecisionRationale(
    run: MeetingRunState,
    event: NormalizedCandidateEvent,
    fiberId: string,
  ): string {
    const lines = [
      event.text.trim(),
      '',
      `Accepted from Portolan meeting ${run.meetingId} candidate event ${event.eventIndex}.`,
      `Promoted fiber: ${fiberId}.`,
      `Meeting metadata: ${run.metadataPath}.`,
      `Candidate event log: ${run.candidateEventsPath}.`,
    ];

    if (event.transcriptChunkIndices.length > 0) {
      lines.push(`Transcript chunks: ${event.transcriptChunkIndices.join(', ')}.`);
      lines.push(`Transcript log: ${run.transcriptPath}.`);
    }
    if (event.operatorUpdateIndices.length > 0) {
      lines.push(`Operator updates: ${event.operatorUpdateIndices.join(', ')}.`);
      lines.push(`Operator update log: ${run.updatesPath}.`);
    }

    return lines.join('\n');
  }

  private buildPromotedBriefTitle(run: MeetingRunState): string {
    const narrative = run.liveBrief.currentNarrative?.text.trim();
    if (narrative) {
      return `Meeting brief: ${narrative.slice(0, 72)}`.replace(/\s+/g, ' ');
    }

    const decision = run.liveBrief.decisions[0];
    if (decision) {
      const label = decision.title ?? decision.text;
      return `Meeting brief: ${label.slice(0, 72)}`.replace(/\s+/g, ' ');
    }

    return `Meeting brief: ${run.meetingId}`;
  }

  private buildPromotedAstraBriefAnalysisId(run: MeetingRunState): string {
    return sanitizeSegment(`meeting-${run.meetingId}`).replace(/\./g, '-');
  }

  private buildLiveAstraAnalysisId(meetingId: string): string {
    return sanitizeSegment(`meeting-live-${meetingId}`).replace(/\./g, '-');
  }

  private buildLiveDocument(run: MeetingRunState): string {
    const lines = [
      `# ${this.buildLiveDocumentTitle(run)}`,
      '',
      `- status: ${run.status}`,
      `- source: ${run.sourceType}`,
      `- worker: ${run.tmuxSession}`,
      `- meeting id: ${run.meetingId}`,
      `- started: ${new Date(run.startedAt).toISOString()}`,
    ];

    if (run.stoppedAt) {
      lines.push(`- stopped: ${new Date(run.stoppedAt).toISOString()}`);
    }

    if (run.liveBrief.currentNarrative?.text.trim()) {
      lines.push('', '## Current narrative', '', run.liveBrief.currentNarrative.text.trim());
    } else {
      lines.push('', '## Current narrative', '', '_Awaiting narrative or correction update._');
    }

    this.appendBriefItemSection(lines, 'Decisions', run.liveBrief.decisions);
    this.appendBriefItemSection(lines, 'Open questions', run.liveBrief.openQuestions);
    this.appendBriefItemSection(lines, 'Action items', run.liveBrief.actionItems);
    this.appendBriefItemSection(lines, 'Accepted notes', run.liveBrief.acceptedNotes);

    if (run.liveBrief.evidenceInView.length > 0) {
      lines.push('', '## Evidence in view', '');
      for (const item of run.liveBrief.evidenceInView) {
        const locator = this.buildRetrievedEvidenceLocator(item);
        const locatorLabel = locator ? ` (${item.type}: ${locator})` : '';
        lines.push(`- ${item.title}${locatorLabel}`);
        if (item.match?.trim()) {
          lines.push(`  - match: ${item.match.trim()}`);
        }
      }
    }

    if (run.recentRetrievalRequests.length > 0) {
      lines.push('', '## Retrieval queue', '');
      for (const request of run.recentRetrievalRequests
        .slice()
        .sort((left, right) => right.receivedAt - left.receivedAt)) {
        lines.push(`- request ${request.requestIndex}: ${request.text}`);
      }
    }

    if (run.recentAssistantResponses.length > 0) {
      lines.push('', '## Assistant replies', '');
      for (const response of run.recentAssistantResponses
        .slice()
        .sort((left, right) => right.receivedAt - left.receivedAt)) {
        const timestampLabel = response.timestamp ? ` (${response.timestamp})` : '';
        lines.push(`- reply ${response.responseIndex}${timestampLabel}: ${response.text}`);
      }
    }

    const recentItems = this.buildLiveDocumentRecentItems(run);
    if (recentItems.length > 0) {
      lines.push('', '## Recent thread', '');
      lines.push(...recentItems);
    }

    lines.push(
      '',
      '## Provenance',
      '',
      `- metadata: ${this.buildMarkdownPathLink('meeting.json', run.metadataPath)}`,
      `- live ASTRA: ${this.buildMarkdownPathLink('astra.yaml', run.liveAstraPath)}`,
      `- transcript log: ${this.buildMarkdownPathLink('transcript.jsonl', run.transcriptPath)}`,
      `- worker injections: ${this.buildMarkdownPathLink('worker-injections.jsonl', run.injectionsPath)}`,
      `- operator updates: ${this.buildMarkdownPathLink('operator-updates.jsonl', run.updatesPath)}`,
      `- assistant replies: ${this.buildMarkdownPathLink('assistant-responses.jsonl', run.assistantResponsesPath)}`,
      `- candidate events: ${this.buildMarkdownPathLink('candidate-events.jsonl', run.candidateEventsPath)}`,
      `- candidate promotions: ${this.buildMarkdownPathLink('candidate-promotions.jsonl', run.candidatePromotionsPath)}`,
      `- retrieval requests: ${this.buildMarkdownPathLink('retrieval-requests.jsonl', run.retrievalRequestsPath)}`,
      `- retrieved evidence: ${this.buildMarkdownPathLink('retrieved-evidence.jsonl', run.retrievalEvidencePath)}`,
      `- brief promotions: ${this.buildMarkdownPathLink('brief-promotions.jsonl', run.briefPromotionsPath)}`,
    );

    return lines.join('\n');
  }

  private buildLiveDocumentTitle(run: MeetingRunState): string {
    const narrative = run.liveBrief.currentNarrative?.text.trim();
    if (narrative) {
      return `Live meeting brief: ${narrative.slice(0, 72)}`.replace(/\s+/g, ' ');
    }

    const leadingDecision = run.liveBrief.decisions[0];
    if (leadingDecision) {
      const label = (leadingDecision.title?.trim() || leadingDecision.text.trim()).slice(0, 72);
      return `Live meeting brief: ${label}`.replace(/\s+/g, ' ');
    }

    return `Live meeting brief: ${run.meetingId}`;
  }

  private buildLiveDocumentRecentItems(run: MeetingRunState): string[] {
    const items = [
      ...run.recentTranscriptChunks.map((chunk) => ({
        receivedAt: chunk.receivedAt,
        line: `- transcript ${chunk.chunkIndex}: ${chunk.text}`,
      })),
      ...run.recentOperatorUpdates.map((update) => ({
        receivedAt: update.receivedAt,
        line: `- update ${update.updateIndex}${update.kind ? ` (${update.kind})` : ''}: ${update.text}`,
      })),
      ...run.recentAssistantResponses.map((response) => ({
        receivedAt: response.receivedAt,
        line: `- assistant ${response.responseIndex}: ${response.text}`,
      })),
      ...run.recentCandidateEvents.map((event) => ({
        receivedAt: event.receivedAt,
        line: `- candidate ${event.eventIndex} (${event.kind}): ${event.title ? `${event.title}: ` : ''}${event.text}`,
      })),
      ...run.recentRetrievalRequests.map((request) => ({
        receivedAt: request.receivedAt,
        line: `- retrieval ${request.requestIndex}: ${request.text}`,
      })),
      ...run.recentRetrievedEvidence.map((evidence) => ({
        receivedAt: evidence.receivedAt,
        line: `- evidence ${evidence.evidenceIndex} (${evidence.type}): ${evidence.title}${evidence.match ? ` — ${evidence.match}` : ''}`,
      })),
    ]
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .slice(-12);

    return items.map((item) => item.line);
  }

  private buildPromotedBriefBody(run: MeetingRunState, title: string): string {
    const brief = run.liveBrief;
    const hasContent = Boolean(brief.currentNarrative)
      || brief.decisions.length > 0
      || brief.openQuestions.length > 0
      || brief.actionItems.length > 0
      || brief.acceptedNotes.length > 0
      || brief.evidenceInView.length > 0;

    if (!hasContent) {
      throw new Error('Meeting live brief is empty');
    }

    const lines = [`# ${title}`];

    if (brief.currentNarrative) {
      lines.push('', '## Current narrative', '', brief.currentNarrative.text);
    }

    this.appendBriefItemSection(lines, 'Decisions', brief.decisions);
    this.appendBriefItemSection(lines, 'Open questions', brief.openQuestions);
    this.appendBriefItemSection(lines, 'Action items', brief.actionItems);
    this.appendBriefItemSection(lines, 'Accepted notes', brief.acceptedNotes);

    if (brief.evidenceInView.length > 0) {
      lines.push('', '## Evidence in view', '');
      for (const item of brief.evidenceInView) {
        const detail = item.type === 'fiber'
          ? item.fiberId ?? item.title
          : item.path ?? item.title;
        lines.push(`- ${item.title} (${item.type}: ${detail})`);
        if (item.match) {
          lines.push(`  - match: ${item.match}`);
        }
      }
    }

    lines.push(
      '',
      '## Meeting provenance',
      '',
      `- meeting id: ${run.meetingId}`,
      `- meeting metadata: ${run.metadataPath}`,
      `- transcript log: ${run.transcriptPath}`,
      `- operator updates log: ${run.updatesPath}`,
      `- candidate events log: ${run.candidateEventsPath}`,
      `- retrieval requests log: ${run.retrievalRequestsPath}`,
      `- retrieved evidence log: ${run.retrievalEvidencePath}`,
    );

    return lines.join('\n');
  }

  private buildPromotedBriefAstraDescription(run: MeetingRunState, fiberId: string): string {
    const sections: string[] = [];
    const brief = run.liveBrief;

    if (brief.currentNarrative?.text.trim()) {
      sections.push(brief.currentNarrative.text.trim());
    }

    if (brief.openQuestions.length > 0) {
      sections.push(
        `Open questions: ${brief.openQuestions.map((item) => item.title?.trim() || item.text.trim()).join('; ')}.`,
      );
    }

    if (brief.actionItems.length > 0) {
      sections.push(
        `Action items: ${brief.actionItems.map((item) => item.title?.trim() || item.text.trim()).join('; ')}.`,
      );
    }

    if (brief.acceptedNotes.length > 0) {
      sections.push(
        `Accepted notes: ${brief.acceptedNotes.map((item) => item.title?.trim() || item.text.trim()).join('; ')}.`,
      );
    }

    if (brief.evidenceInView.length > 0) {
      sections.push(
        `Evidence in view: ${brief.evidenceInView.map((item) => item.title).join('; ')}.`,
      );
    }

    if (run.recentRetrievalRequests.length > 0) {
      sections.push(
        `Retrieval queue: ${run.recentRetrievalRequests.map((item) => item.text.trim()).join('; ')}.`,
      );
    }

    if (run.recentAssistantResponses.length > 0) {
      sections.push(
        `Recent assistant replies: ${run.recentAssistantResponses.map((item) => item.text.trim()).join('; ')}.`,
      );
    }

    sections.push(
      `Promoted from Portolan meeting ${run.meetingId}.`,
      `Meeting brief fiber: ${fiberId}.`,
      `Meeting metadata: ${run.metadataPath}.`,
      `Transcript log: ${run.transcriptPath}.`,
      `Operator update log: ${run.updatesPath}.`,
      `Assistant reply log: ${run.assistantResponsesPath}.`,
      `Candidate event log: ${run.candidateEventsPath}.`,
      `Retrieval request log: ${run.retrievalRequestsPath}.`,
      `Retrieved evidence log: ${run.retrievalEvidencePath}.`,
    );

    return sections.join('\n\n');
  }

  private buildLiveAstraDescription(run: MeetingRunState): string {
    const sections = [
      `Live Portolan meeting lane for ${run.meetingId}.`,
      `Status: ${run.status}.`,
      `Worker: ${run.tmuxSession}.`,
    ];

    const narrative = run.liveBrief.currentNarrative?.text.trim();
    if (narrative) {
      sections.push(narrative);
    } else {
      sections.push('Awaiting narrative or accepted captures.');
    }

    if (run.liveBrief.openQuestions.length > 0) {
      sections.push(
        `Open questions: ${run.liveBrief.openQuestions.map((item) => item.title?.trim() || item.text.trim()).join('; ')}.`,
      );
    }

    if (run.liveBrief.actionItems.length > 0) {
      sections.push(
        `Action items: ${run.liveBrief.actionItems.map((item) => item.title?.trim() || item.text.trim()).join('; ')}.`,
      );
    }

    if (run.liveBrief.evidenceInView.length > 0) {
      sections.push(
        `Evidence in view: ${run.liveBrief.evidenceInView.map((item) => item.title).join('; ')}.`,
      );
    }

    if (run.recentRetrievalRequests.length > 0) {
      sections.push(
        `Retrieval queue: ${run.recentRetrievalRequests.map((item) => item.text.trim()).join('; ')}.`,
      );
    }

    if (run.recentAssistantResponses.length > 0) {
      sections.push(
        `Recent assistant replies: ${run.recentAssistantResponses.map((item) => item.text.trim()).join('; ')}.`,
      );
    }

    sections.push(
      `Live document: ${run.liveDocumentPath}.`,
      `Meeting metadata: ${run.metadataPath}.`,
      `Transcript log: ${run.transcriptPath}.`,
      `Operator update log: ${run.updatesPath}.`,
      `Assistant reply log: ${run.assistantResponsesPath}.`,
      `Candidate event log: ${run.candidateEventsPath}.`,
      `Retrieval request log: ${run.retrievalRequestsPath}.`,
      `Retrieved evidence log: ${run.retrievalEvidencePath}.`,
    );

    return sections.join('\n\n');
  }

  private buildLiveAstraInputs(run: MeetingRunState): Array<Record<string, unknown>> {
    return [
      {
        id: 'meeting_live_document',
        type: 'report',
        description: 'Continuously regenerated live Portolan meeting brief document.',
        source: run.liveDocumentPath,
      },
      ...this.buildPromotedBriefAstraInputs(run),
    ];
  }

  private buildLiveAstraFindings(run: MeetingRunState): Record<string, Record<string, unknown>> {
    const findings: Record<string, Record<string, unknown>> = {};
    const now = new Date().toISOString();

    if (run.liveBrief.currentNarrative?.text.trim()) {
      findings['meeting-live-summary'] = {
        id: 'meeting-live-summary',
        claim: run.liveBrief.currentNarrative.text.trim(),
        created_at: now,
        tags: ['meeting', 'meeting-live-summary'],
        notes: `Rolling live meeting narrative for ${run.meetingId}.`,
        evidence: this.buildPromotedBriefFindingEvidence(
          run,
          'meeting-live-summary',
          [],
          [run.liveBrief.currentNarrative.updateIndex],
        ),
      };
    }

    run.liveBrief.acceptedNotes.forEach((item) => {
      const findingId = `meeting-live-note-${item.eventIndex}`;
      findings[findingId] = {
        id: findingId,
        claim: item.title?.trim() || item.text.trim(),
        created_at: now,
        tags: ['meeting', 'meeting-live-note'],
        notes: item.text.trim(),
        evidence: this.buildPromotedBriefFindingEvidence(
          run,
          findingId,
          item.transcriptChunkIndices,
          item.operatorUpdateIndices,
        ),
      };
    });

    run.liveBrief.openQuestions.forEach((item) => {
      const findingId = `meeting-live-question-${item.eventIndex}`;
      findings[findingId] = {
        id: findingId,
        claim: item.title?.trim() || item.text.trim(),
        created_at: now,
        tags: ['meeting', 'meeting-live-question'],
        notes: item.text.trim(),
        evidence: this.buildPromotedBriefFindingEvidence(
          run,
          findingId,
          item.transcriptChunkIndices,
          item.operatorUpdateIndices,
        ),
      };
    });

    run.liveBrief.actionItems.forEach((item) => {
      const findingId = `meeting-live-action-item-${item.eventIndex}`;
      findings[findingId] = {
        id: findingId,
        claim: item.title?.trim() || item.text.trim(),
        created_at: now,
        tags: ['meeting', 'meeting-live-action-item'],
        notes: item.text.trim(),
        evidence: this.buildPromotedBriefFindingEvidence(
          run,
          findingId,
          item.transcriptChunkIndices,
          item.operatorUpdateIndices,
        ),
      };
    });

    return findings;
  }

  private buildPromotedBriefAstraInputs(run: MeetingRunState): Array<Record<string, unknown>> {
    return [
      {
        id: 'meeting_metadata',
        type: 'data',
        description: 'Persisted metadata for the active Portolan meeting run.',
        source: run.metadataPath,
      },
      {
        id: 'meeting_transcript_log',
        type: 'data',
        description: 'Append-only transcript log for the active Portolan meeting run.',
        source: run.transcriptPath,
      },
      {
        id: 'meeting_operator_updates',
        type: 'data',
        description: 'Operator steering and correction log for the active Portolan meeting run.',
        source: run.updatesPath,
      },
      {
        id: 'meeting_assistant_replies',
        type: 'data',
        description: 'Assistant replies surfaced back into the active Portolan meeting run.',
        source: run.assistantResponsesPath,
      },
      {
        id: 'meeting_candidate_events',
        type: 'data',
        description: 'Accepted meeting-native candidate captures with transcript provenance.',
        source: run.candidateEventsPath,
      },
      {
        id: 'meeting_retrieval_requests',
        type: 'data',
        description: 'Explicit retrieval requests made during the active Portolan meeting run.',
        source: run.retrievalRequestsPath,
      },
      {
        id: 'meeting_retrieved_evidence',
        type: 'data',
        description: 'Evidence explicitly pulled into the live meeting thread.',
        source: run.retrievalEvidencePath,
      },
    ];
  }

  private buildPromotedBriefAstraFindings(run: MeetingRunState): Record<string, Record<string, unknown>> {
    const findings: Record<string, Record<string, unknown>> = {};
    const now = new Date().toISOString();

    const addFinding = (
      id: string,
      claim: string,
      notes: string,
      tags: string[],
      transcriptChunkIndices: number[],
      operatorUpdateIndices: number[],
    ) => {
      findings[id] = {
        id,
        claim,
        created_at: now,
        tags,
        notes,
        evidence: this.buildPromotedBriefFindingEvidence(run, id, transcriptChunkIndices, operatorUpdateIndices),
      };
    };

    if (run.liveBrief.currentNarrative?.text.trim()) {
      addFinding(
        'meeting-summary',
        run.liveBrief.currentNarrative.text.trim(),
        `Rolling meeting narrative promoted from Portolan meeting ${run.meetingId}.`,
        ['meeting', 'meeting-summary'],
        [],
        [run.liveBrief.currentNarrative.updateIndex],
      );
    }

    run.liveBrief.acceptedNotes.forEach((item) => {
      const label = item.title?.trim() || item.text.trim();
      addFinding(
        `accepted-note-${item.eventIndex}`,
        label,
        item.text.trim(),
        ['meeting', 'accepted-note'],
        item.transcriptChunkIndices,
        item.operatorUpdateIndices,
      );
    });

    run.liveBrief.openQuestions.forEach((item) => {
      const label = item.title?.trim() || item.text.trim();
      addFinding(
        `open-question-${item.eventIndex}`,
        label,
        item.text.trim(),
        ['meeting', 'open-question'],
        item.transcriptChunkIndices,
        item.operatorUpdateIndices,
      );
    });

    run.liveBrief.actionItems.forEach((item) => {
      const label = item.title?.trim() || item.text.trim();
      addFinding(
        `action-item-${item.eventIndex}`,
        label,
        item.text.trim(),
        ['meeting', 'action-item'],
        item.transcriptChunkIndices,
        item.operatorUpdateIndices,
      );
    });

    return findings;
  }

  private buildPromotedBriefFindingEvidence(
    run: MeetingRunState,
    findingId: string,
    transcriptChunkIndices: number[],
    operatorUpdateIndices: number[],
  ): Array<Record<string, unknown>> {
    const evidence: Array<Record<string, unknown>> = [];

    if (transcriptChunkIndices.length > 0) {
      evidence.push({
        id: `${findingId}-transcript`,
        artifact: run.transcriptPath,
      });
    }

    if (operatorUpdateIndices.length > 0) {
      evidence.push({
        id: `${findingId}-updates`,
        artifact: run.updatesPath,
      });
    }

    if (evidence.length === 0) {
      evidence.push({
        id: `${findingId}-metadata`,
        artifact: run.metadataPath,
      });
    }

    return evidence;
  }

  private buildPromotedBriefAstraDecisions(run: MeetingRunState): Record<string, Record<string, unknown>> {
    const decisions: Record<string, Record<string, unknown>> = {};

    run.liveBrief.decisions.forEach((item) => {
      const decisionId = `meeting-decision-${item.eventIndex}`;
      if (item.promotedAstraDecisionId) {
        decisions[decisionId] = {
          from: item.promotedAstraDecisionId,
        };
        return;
      }

      const label = item.title?.trim() || item.text.trim();
      decisions[decisionId] = {
        label,
        rationale: item.text.trim(),
        tags: ['meeting', 'meeting-decision'],
        default: 'accepted',
        options: {
          accepted: {
            label: 'Accepted',
            description: 'Accepted during the Portolan live meeting brief promotion.',
          },
        },
      };
    });

    return decisions;
  }

  private appendBriefItemSection(lines: string[], heading: string, items: MeetingLiveBriefItem[]): void {
    if (items.length === 0) {
      return;
    }

    lines.push('', `## ${heading}`, '');
    for (const item of items) {
      const label = item.title?.trim() || `${item.kind} ${item.eventIndex}`;
      lines.push(`- ${label}: ${item.text}`);
      if (item.transcriptChunkIndices.length > 0) {
        lines.push(`  - transcript chunks: ${item.transcriptChunkIndices.join(', ')}`);
      }
      if (item.operatorUpdateIndices.length > 0) {
        lines.push(`  - operator updates: ${item.operatorUpdateIndices.join(', ')}`);
      }
      if (item.promotedFiberId) {
        lines.push(`  - promoted fiber: ${this.buildMarkdownPathLink(item.promotedFiberId, this.buildMeetingFiberPath(item.promotedFiberId))}`);
      }
      if (item.promotedAstraDecisionId) {
        lines.push(`  - ASTRA decision: ${item.promotedAstraDecisionId}`);
      }
    }
  }

  private buildMeetingFiberPath(fiberId: string): string {
    return `.felt/${fiberId}/${fiberId}.md`;
  }

  private buildRetrievedEvidenceLocator(item: MeetingRetrievedEvidenceEntry): string | null {
    if (item.type === 'fiber' && item.fiberId) {
      return this.buildMarkdownPathLink(item.fiberId, this.buildMeetingFiberPath(item.fiberId));
    }

    if (item.type === 'file' && item.path) {
      const location = item.line && item.line > 0 ? `${item.path}:L${item.line}` : item.path;
      return this.buildMarkdownPathLink(basename(item.path), location);
    }

    return null;
  }

  private buildMarkdownPathLink(label: string, path: string): string {
    return `[${escapeMarkdownLinkLabel(label)}](<${path}>)`;
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
      promotedAstraDecisionId: maybeString(value.promotedAstraDecisionId),
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

  private buildRetrievedEvidenceMessage(run: MeetingRunState, evidence: NormalizedRetrievedEvidence): string {
    const lines = [
      '[Portolan Meeting Retrieved Evidence]',
      `meeting_id: ${run.meetingId}`,
      `evidence_index: ${evidence.evidenceIndex}`,
      `received_at: ${evidence.receivedAt}`,
      `type: ${evidence.type}`,
      `title: ${evidence.title}`,
    ];

    if (evidence.requestIndex !== null) lines.push(`request_index: ${evidence.requestIndex}`);
    if (evidence.fiberId) lines.push(`fiber_id: ${evidence.fiberId}`);
    if (evidence.path) lines.push(`path: ${evidence.path}`);
    if (evidence.line !== null) lines.push(`line: ${evidence.line}`);
    if (evidence.match) {
      lines.push('match:');
      lines.push(evidence.match);
    }
    lines.push('Treat this as evidence explicitly pulled into view during the meeting. Keep later narrative and decisions linked to it when relevant.');
    lines.push('[/Portolan Meeting Retrieved Evidence]');
    return lines.join('\n');
  }
}

function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'meeting';
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
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
  const transcriptMarkdownPath = maybeString(value.transcriptMarkdownPath);
  const currentMeetingSymlinkPath = maybeString(value.currentMeetingSymlinkPath);
  const injectionsPath = maybeString(value.injectionsPath);
  const updatesPath = maybeString(value.updatesPath);
  const assistantResponsesPath = maybeString(value.assistantResponsesPath);
  const candidateEventsPath = maybeString(value.candidateEventsPath);
  const candidatePromotionsPath = maybeString(value.candidatePromotionsPath);
  const retrievalRequestsPath = maybeString(value.retrievalRequestsPath);
  const retrievalEvidencePath = maybeString(value.retrievalEvidencePath);
  const briefPromotionsPath = maybeString(value.briefPromotionsPath);
  const liveDocumentPath = maybeString(value.liveDocumentPath);
  const liveAstraPath = maybeString(value.liveAstraPath);
  const liveAstraAnalysisId = maybeString(value.liveAstraAnalysisId);
  const metadataPath = maybeString(value.metadataPath);
  const chunkCount = maybeNumber(value.chunkCount);
  const injectedCount = maybeNumber(value.injectedCount);
  const operatorUpdateCount = maybeNumber(value.operatorUpdateCount);
  const assistantResponseCount = maybeNumber(value.assistantResponseCount);
  const candidateEventCount = maybeNumber(value.candidateEventCount);
  const promotedCandidateEventCount = maybeNumber(value.promotedCandidateEventCount);
  const retrievalRequestCount = maybeNumber(value.retrievalRequestCount);
  const retrievalEvidenceCount = maybeNumber(value.retrievalEvidenceCount);
  const briefPromotionCount = maybeNumber(value.briefPromotionCount);

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
  const resolvedAssistantResponsesPath = assistantResponsesPath ?? join(dirname(metadataPath), 'assistant-responses.jsonl');
  const resolvedCandidateEventsPath = candidateEventsPath ?? join(dirname(metadataPath), 'candidate-events.jsonl');
  const resolvedCandidatePromotionsPath = candidatePromotionsPath ?? join(dirname(metadataPath), 'candidate-promotions.jsonl');
  const resolvedRetrievalRequestsPath = retrievalRequestsPath ?? join(dirname(metadataPath), 'retrieval-requests.jsonl');
  const resolvedRetrievalEvidencePath = retrievalEvidencePath ?? join(dirname(metadataPath), 'retrieved-evidence.jsonl');
  const resolvedBriefPromotionsPath = briefPromotionsPath ?? join(dirname(metadataPath), 'brief-promotions.jsonl');
  const resolvedLiveDocumentPath = liveDocumentPath ?? join(dirname(metadataPath), 'live-brief.md');
  const resolvedLiveAstraPath = liveAstraPath ?? join(cityPath, 'astra.yaml');
  const resolvedLiveAstraAnalysisId = liveAstraAnalysisId
    ?? sanitizeSegment(`meeting-live-${meetingId}`).replace(/\./g, '-');

  const run: MeetingRunState = {
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
    transcriptMarkdownPath: transcriptMarkdownPath ?? join(dirname(metadataPath), 'transcript.md'),
    currentMeetingSymlinkPath: currentMeetingSymlinkPath ?? undefined,
    injectionsPath,
    updatesPath: resolvedUpdatesPath,
    assistantResponsesPath: resolvedAssistantResponsesPath,
    candidateEventsPath: resolvedCandidateEventsPath,
    candidatePromotionsPath: resolvedCandidatePromotionsPath,
    retrievalRequestsPath: resolvedRetrievalRequestsPath,
    retrievalEvidencePath: resolvedRetrievalEvidencePath,
    briefPromotionsPath: resolvedBriefPromotionsPath,
    liveDocumentPath: resolvedLiveDocumentPath,
    liveAstraPath: resolvedLiveAstraPath,
    liveAstraAnalysisId: resolvedLiveAstraAnalysisId,
    metadataPath,
    bootstrapSentAt: maybeNumber(value.bootstrapSentAt) ?? undefined,
    chunkCount,
    injectedCount,
    operatorUpdateCount: operatorUpdateCount ?? 0,
    assistantResponseCount: assistantResponseCount ?? 0,
    candidateEventCount: candidateEventCount ?? 0,
    promotedCandidateEventCount: promotedCandidateEventCount ?? 0,
    retrievalRequestCount: retrievalRequestCount ?? 0,
    retrievalEvidenceCount: retrievalEvidenceCount ?? 0,
    briefPromotionCount: briefPromotionCount ?? 0,
    lastChunkAt: maybeNumber(value.lastChunkAt) ?? undefined,
    lastChunkPreview: maybeString(value.lastChunkPreview) ?? undefined,
    lastOperatorUpdateAt: maybeNumber(value.lastOperatorUpdateAt) ?? undefined,
    lastOperatorUpdatePreview: maybeString(value.lastOperatorUpdatePreview) ?? undefined,
    lastAssistantResponseAt: maybeNumber(value.lastAssistantResponseAt) ?? undefined,
    lastAssistantResponsePreview: maybeString(value.lastAssistantResponsePreview) ?? undefined,
    lastCandidateEventAt: maybeNumber(value.lastCandidateEventAt) ?? undefined,
    lastCandidateEventPreview: maybeString(value.lastCandidateEventPreview) ?? undefined,
    lastPromotedCandidateAt: maybeNumber(value.lastPromotedCandidateAt) ?? undefined,
    lastPromotedCandidateFiberId: maybeString(value.lastPromotedCandidateFiberId) ?? undefined,
    lastPromotedCandidateAstraDecisionId: maybeString(value.lastPromotedCandidateAstraDecisionId) ?? undefined,
    lastRetrievalRequestAt: maybeNumber(value.lastRetrievalRequestAt) ?? undefined,
    lastRetrievalRequestPreview: maybeString(value.lastRetrievalRequestPreview) ?? undefined,
    lastRetrievedEvidenceAt: maybeNumber(value.lastRetrievedEvidenceAt) ?? undefined,
    lastRetrievedEvidencePreview: maybeString(value.lastRetrievedEvidencePreview) ?? undefined,
    lastBriefPromotionAt: maybeNumber(value.lastBriefPromotionAt) ?? undefined,
    lastBriefPromotionFiberId: maybeString(value.lastBriefPromotionFiberId) ?? undefined,
    lastBriefPromotionAstraAnalysisId: maybeString(value.lastBriefPromotionAstraAnalysisId) ?? undefined,
    lastLiveAstraSyncAt: maybeNumber(value.lastLiveAstraSyncAt) ?? undefined,
    lastError: maybeString(value.lastError) ?? undefined,
    liveBrief: buildMeetingLiveBrief({
      recentOperatorUpdates: [],
      recentCandidateEvents: [],
      recentRetrievedEvidence: [],
    }),
    recentTranscriptChunks: parseTranscriptEntries(value.recentTranscriptChunks),
    recentOperatorUpdates: parseOperatorUpdateEntries(value.recentOperatorUpdates),
    recentAssistantResponses: parseAssistantResponseEntries(value.recentAssistantResponses),
    recentCandidateEvents: parseCandidateEventEntries(value.recentCandidateEvents),
    recentRetrievalRequests: parseRetrievalRequestEntries(value.recentRetrievalRequests),
    recentRetrievedEvidence: parseRetrievedEvidenceEntries(value.recentRetrievedEvidence),
    recentBriefPromotions: parseBriefPromotionEntries(value.recentBriefPromotions),
  };
  run.liveBrief = parseMeetingLiveBrief(value.liveBrief) ?? buildMeetingLiveBrief(run);
  return run;
}

function maybeMeetingStatus(value: unknown): MeetingRunState['status'] | null {
  return value === 'running' || value === 'stopped' || value === 'error' ? value : null;
}

function maybeSourceType(value: unknown): MeetingRunState['sourceType'] | null {
  return value === 'voiceink' || value === 'manual' || value === 'parakeet' ? value : null;
}

function cloneMeetingRunState(run: MeetingRunState): MeetingRunState {
  return {
    ...run,
    recentTranscriptChunks: run.recentTranscriptChunks.map((chunk) => ({ ...chunk })),
    recentOperatorUpdates: run.recentOperatorUpdates.map((update) => ({ ...update })),
    recentAssistantResponses: run.recentAssistantResponses.map((response) => ({ ...response })),
    recentCandidateEvents: run.recentCandidateEvents.map((event) => ({
      ...event,
      transcriptChunkIndices: [...event.transcriptChunkIndices],
      operatorUpdateIndices: [...event.operatorUpdateIndices],
      promotedAstraDecisionId: event.promotedAstraDecisionId,
    })),
    recentRetrievalRequests: run.recentRetrievalRequests.map((request) => ({ ...request })),
    recentRetrievedEvidence: run.recentRetrievedEvidence.map((evidence) => ({ ...evidence })),
    recentBriefPromotions: run.recentBriefPromotions.map((promotion) => ({ ...promotion })),
    liveBrief: cloneMeetingLiveBrief(run.liveBrief),
  };
}

function parseBriefPromotionEntries(value: unknown): MeetingBriefPromotionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = parseBriefPromotionEntry(entry);
    return parsed ? [parsed] : [];
  });
}

function parseBriefPromotionEntry(value: unknown): MeetingBriefPromotionEntry | null {
  if (!isRecord(value)) return null;
  const promotionIndex = maybeNumber(value.promotionIndex);
  const receivedAt = maybeNumber(value.receivedAt);
  const title = maybeString(value.title);
  const fiberId = maybeString(value.fiberId);
  if (promotionIndex === null || receivedAt === null || title === null || fiberId === null) {
    return null;
  }
  return {
    promotionIndex,
    receivedAt,
    title,
    fiberId,
    astraAnalysisId: maybeString(value.astraAnalysisId) ?? undefined,
    astraPath: maybeString(value.astraPath) ?? undefined,
  };
}

function buildMeetingLiveBrief(state: {
  recentOperatorUpdates: MeetingOperatorUpdateEntry[];
  recentCandidateEvents: MeetingCandidateEventEntry[];
  recentRetrievedEvidence: MeetingRetrievedEvidenceEntry[];
}): MeetingLiveBrief {
  const currentNarrative = [...state.recentOperatorUpdates]
    .reverse()
    .find((update) => update.kind === 'narrative' || update.kind === 'correction' || update.kind === 'redirect')
    ?? state.recentOperatorUpdates.at(-1);

  const items = state.recentCandidateEvents
    .map<MeetingLiveBriefItem>((event) => ({
      eventIndex: event.eventIndex,
      receivedAt: event.receivedAt,
      kind: event.kind,
      title: event.title,
      text: event.text,
      transcriptChunkIndices: [...event.transcriptChunkIndices],
      operatorUpdateIndices: [...event.operatorUpdateIndices],
      promotedAt: event.promotedAt,
      promotedFiberId: event.promotedFiberId,
      promotedAstraDecisionId: event.promotedAstraDecisionId,
    }))
    .sort((left, right) => right.receivedAt - left.receivedAt);

  return {
    currentNarrative: currentNarrative ? { ...currentNarrative } : undefined,
    decisions: items.filter((item) => item.kind === 'decision').slice(0, 3),
    openQuestions: items.filter((item) => item.kind === 'question').slice(0, 3),
    actionItems: items.filter((item) => item.kind === 'action-item').slice(0, 3),
    acceptedNotes: items.filter((item) => item.kind === 'note').slice(0, 3),
    evidenceInView: state.recentRetrievedEvidence
      .slice()
      .sort((left, right) => right.receivedAt - left.receivedAt)
      .slice(0, 4)
      .map((evidence) => ({ ...evidence })),
  };
}

function cloneMeetingLiveBrief(brief: MeetingLiveBrief): MeetingLiveBrief {
  return {
    currentNarrative: brief.currentNarrative ? { ...brief.currentNarrative } : undefined,
    decisions: brief.decisions.map((item) => cloneMeetingLiveBriefItem(item)),
    openQuestions: brief.openQuestions.map((item) => cloneMeetingLiveBriefItem(item)),
    actionItems: brief.actionItems.map((item) => cloneMeetingLiveBriefItem(item)),
    acceptedNotes: brief.acceptedNotes.map((item) => cloneMeetingLiveBriefItem(item)),
    evidenceInView: brief.evidenceInView.map((item) => ({ ...item })),
  };
}

function cloneMeetingLiveBriefItem(item: MeetingLiveBriefItem): MeetingLiveBriefItem {
  return {
    ...item,
    transcriptChunkIndices: [...item.transcriptChunkIndices],
    operatorUpdateIndices: [...item.operatorUpdateIndices],
  };
}

function appendRecentItem<T>(items: T[], item: T): T[] {
  return [...items, item].slice(-MAX_RECENT_MEETING_ITEMS);
}

function upsertRecentTranscriptItem(items: MeetingTranscriptEntry[], item: MeetingTranscriptEntry): MeetingTranscriptEntry[] {
  return [...items.filter((entry) => entry.chunkIndex !== item.chunkIndex), item]
    .sort((left, right) => left.receivedAt - right.receivedAt)
    .slice(-MAX_RECENT_MEETING_ITEMS);
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
      revisionIndex: maybeNumber(entry.revisionIndex) ?? undefined,
      sourceChunkId: maybeString(entry.sourceChunkId) ?? undefined,
      timestampLocal: maybeString(entry.timestampLocal) ?? undefined,
      status: maybeString(entry.status) ?? undefined,
      speaker: maybeString(entry.speaker) ?? undefined,
      isPartial: maybeBoolean(entry.isPartial) ?? undefined,
      isRevision: maybeBoolean(entry.isRevision) ?? undefined,
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

function parseMeetingLiveBrief(value: unknown): MeetingLiveBrief | null {
  if (!isRecord(value)) return null;
  return {
    currentNarrative: parseOperatorUpdateEntry(value.currentNarrative) ?? undefined,
    decisions: parseMeetingLiveBriefItems(value.decisions),
    openQuestions: parseMeetingLiveBriefItems(value.openQuestions),
    actionItems: parseMeetingLiveBriefItems(value.actionItems),
    acceptedNotes: parseMeetingLiveBriefItems(value.acceptedNotes),
    evidenceInView: parseRetrievedEvidenceEntries(value.evidenceInView),
  };
}

function parseMeetingLiveBriefItems(value: unknown): MeetingLiveBriefItem[] {
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
      promotedAstraDecisionId: maybeString(entry.promotedAstraDecisionId) ?? undefined,
    }];
  });
}

function parseOperatorUpdateEntry(value: unknown): MeetingOperatorUpdateEntry | null {
  if (!isRecord(value)) return null;
  const updateIndex = maybeNumber(value.updateIndex);
  const receivedAt = maybeNumber(value.receivedAt);
  const text = maybeString(value.text);
  if (updateIndex === null || receivedAt === null || text === null) return null;
  return {
    updateIndex,
    receivedAt,
    kind: maybeString(value.kind) ?? undefined,
    text,
  };
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
      promotedAstraDecisionId: maybeString(entry.promotedAstraDecisionId) ?? undefined,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

function parseAssistantResponseEntries(value: unknown): MeetingAssistantResponseEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const responseIndex = maybeNumber(entry.responseIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const text = maybeString(entry.text);
    if (responseIndex === null || receivedAt === null || text === null) return [];
    return [{
      responseIndex,
      receivedAt,
      timestamp: maybeString(entry.timestamp) ?? undefined,
      text,
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

function parseRetrievedEvidenceEntries(value: unknown): MeetingRetrievedEvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const evidenceIndex = maybeNumber(entry.evidenceIndex);
    const receivedAt = maybeNumber(entry.receivedAt);
    const rawType = maybeString(entry.type);
    const type: 'fiber' | 'file' | null = rawType === 'fiber' || rawType === 'file' ? rawType : null;
    const title = maybeString(entry.title);
    if (evidenceIndex === null || receivedAt === null || type === null || title === null) return [];
    return [{
      evidenceIndex,
      receivedAt,
      requestIndex: maybeNumber(entry.requestIndex) ?? undefined,
      type,
      title,
      fiberId: maybeString(entry.fiberId) ?? undefined,
      path: maybeString(entry.path) ?? undefined,
      line: maybeNumber(entry.line) ?? undefined,
      match: maybeString(entry.match) ?? undefined,
    }];
  }).slice(-MAX_RECENT_MEETING_ITEMS);
}

function maybeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isPartialTranscriptStatus(status: string | null): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'partial' || normalized === 'interim' || normalized === 'live' || normalized === 'in_progress';
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

class DefaultMeetingAstraPromoter implements MeetingAstraPromoter {
  async upsertDecision(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    decisionId: string;
    label: string;
    rationale: string;
    tags: string[];
    defaultOption: string;
    options: Record<string, { label: string; description: string }>;
  }): Promise<{ decisionId: string; astraPath: string }> {
    const astraPath = join(options.cityPath, 'astra.yaml');
    const content = options.originId === 'local'
      ? this.readLocalAstra(astraPath)
      : await this.readRemoteAstra(options.sshHost, astraPath);
    const parsed = parseYaml(content || '');
    const document = isRecord(parsed) ? parsed as Record<string, unknown> : {};

    const decisions = isRecord(document.decisions) ? document.decisions as Record<string, unknown> : {};
    decisions[options.decisionId] = {
      label: options.label,
      rationale: options.rationale,
      tags: options.tags,
      default: options.defaultOption,
      options: options.options,
    };
    document.decisions = decisions;

    const nextContent = stringifyYaml(document);
    if (options.originId === 'local') {
      writeFileSync(astraPath, nextContent);
    } else {
      await this.writeRemoteAstra(options.sshHost, astraPath, nextContent);
    }

    return {
      decisionId: options.decisionId,
      astraPath,
    };
  }

  async upsertMeetingBrief(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    analysisId: string;
    title: string;
    description: string;
    tags: string[];
    inputs: Array<Record<string, unknown>>;
    findings: Record<string, Record<string, unknown>>;
    decisions: Record<string, Record<string, unknown>>;
  }): Promise<{ analysisId: string; astraPath: string }> {
    const astraPath = join(options.cityPath, 'astra.yaml');
    const content = options.originId === 'local'
      ? this.readLocalAstra(astraPath)
      : await this.readRemoteAstra(options.sshHost, astraPath);
    const parsed = parseYaml(content || '');
    const document = isRecord(parsed) ? parsed as Record<string, unknown> : {};

    const analyses = isRecord(document.analyses) ? document.analyses as Record<string, unknown> : {};
    analyses[options.analysisId] = {
      name: options.title,
      tags: options.tags,
      description: options.description,
      inputs: options.inputs,
      outputs: [],
      prior_insights: {},
      findings: options.findings,
      decisions: options.decisions,
    };
    document.analyses = analyses;

    const nextContent = stringifyYaml(document);
    if (options.originId === 'local') {
      writeFileSync(astraPath, nextContent);
    } else {
      await this.writeRemoteAstra(options.sshHost, astraPath, nextContent);
    }

    return {
      analysisId: options.analysisId,
      astraPath,
    };
  }

  async syncLiveMeetingBrief(options: {
    cityPath: string;
    originId: string;
    sshHost?: string;
    analysisId: string;
    title: string;
    description: string;
    tags: string[];
    inputs: Array<Record<string, unknown>>;
    findings: Record<string, Record<string, unknown>>;
    decisions: Record<string, Record<string, unknown>>;
  }): Promise<{ analysisId: string; astraPath: string }> {
    const astraPath = join(options.cityPath, 'astra.yaml');
    const content = options.originId === 'local'
      ? this.readLocalAstra(astraPath)
      : await this.readRemoteAstra(options.sshHost, astraPath);
    const parsed = parseYaml(content || '');
    const document = isRecord(parsed) ? parsed as Record<string, unknown> : {};

    const analyses = isRecord(document.analyses) ? document.analyses as Record<string, unknown> : {};
    analyses[options.analysisId] = {
      name: options.title,
      tags: options.tags,
      description: options.description,
      inputs: options.inputs,
      outputs: [],
      prior_insights: {},
      findings: options.findings,
      decisions: options.decisions,
    };
    document.analyses = analyses;

    const nextContent = stringifyYaml(document);
    if (options.originId === 'local') {
      writeFileSync(astraPath, nextContent);
    } else {
      await this.writeRemoteAstra(options.sshHost, astraPath, nextContent);
    }

    return {
      analysisId: options.analysisId,
      astraPath,
    };
  }

  private readLocalAstra(astraPath: string): string {
    try {
      return readFileSync(astraPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async readRemoteAstra(sshHost: string | undefined, astraPath: string): Promise<string> {
    if (!sshHost) {
      throw new Error('Remote origin not found');
    }
    const { stdout } = await execFileAsync(
      'ssh',
      [sshHost, `cat ${shellEscape(astraPath)} 2>/dev/null || echo ''`],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  }

  private async writeRemoteAstra(sshHost: string | undefined, astraPath: string, content: string): Promise<void> {
    if (!sshHost) {
      throw new Error('Remote origin not found');
    }
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const remoteCommand = [
      `mkdir -p ${shellEscape(dirname(astraPath))}`,
      `python3 - <<'PY'`,
      'import base64',
      `from pathlib import Path; Path(${JSON.stringify(astraPath)}).write_text(base64.b64decode(${JSON.stringify(encoded)}).decode("utf-8"))`,
      'PY',
    ].join('\n');
    await execFileAsync('ssh', [sshHost, remoteCommand], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
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
