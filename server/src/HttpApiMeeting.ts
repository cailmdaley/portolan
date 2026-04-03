import type { IncomingMessage, ServerResponse } from 'http';
import type { Origin } from './OriginManager.js';
import type { Session } from './SessionTracker.js';
import type {
  MeetingBridge,
  MeetingBridgeStartOptions,
  MeetingBridgeState,
} from './MeetingBridge.js';

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
}

type JsonBodyParser = <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
type JsonErrorSender = (res: ServerResponse, status: number, error: string) => void;
type JsonSuccessSender = (res: ServerResponse, data: Record<string, unknown>) => void;

interface HttpApiMeetingOptions {
  originLookup: OriginLookup;
  parseJsonBody: JsonBodyParser;
  sendJsonError: JsonErrorSender;
  sendJsonSuccess: JsonSuccessSender;
}

export class HttpApiMeeting {
  private readonly originLookup: OriginLookup;
  private readonly parseJsonBody: JsonBodyParser;
  private readonly sendJsonError: JsonErrorSender;
  private readonly sendJsonSuccess: JsonSuccessSender;
  private sessionLookup: SessionLookup | null = null;
  private meetingBridge: MeetingBridge | null = null;

  constructor(options: HttpApiMeetingOptions) {
    this.originLookup = options.originLookup;
    this.parseJsonBody = options.parseJsonBody;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
  }

  setSessionLookup(lookup: SessionLookup): void {
    this.sessionLookup = lookup;
  }

  setMeetingBridge(bridge: MeetingBridge): void {
    this.meetingBridge = bridge;
  }

  handleGetState(res: ServerResponse): void {
    this.sendJsonSuccess(res, { meeting: this.getState() });
  }

  async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sessionLookup) {
      this.sendJsonError(res, 500, 'Session lookup not initialized');
      return;
    }
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{
      workerId: string;
      initialPrompt?: string;
      sourceType?: MeetingBridgeStartOptions['sourceType'];
      voiceInk?: {
        dbPath?: string;
        pollSeconds?: number;
        includeHistory?: boolean;
      };
    }>(req, res);
    if (!data) return;

    if (!data.workerId) {
      this.sendJsonError(res, 400, 'Missing workerId');
      return;
    }

    const session = this.sessionLookup.findSession(data.workerId);
    if (!session) {
      this.sendJsonError(res, 404, 'Worker not found');
      return;
    }
    if (!session.cwd) {
      this.sendJsonError(res, 400, 'Worker session has no cwd');
      return;
    }

    let sshHost: string | undefined;
    if (session.originId !== 'local') {
      const origin = this.originLookup.getOrigin(session.originId);
      if (!origin?.sshHost) {
        this.sendJsonError(res, 404, 'Remote origin not found');
        return;
      }
      sshHost = origin.sshHost;
    }

    try {
      const meeting = this.meetingBridge.start({
        target: {
          sessionId: session.id,
          tmuxSession: session.tmuxSession,
          originId: session.originId,
          cwd: session.cwd,
          sshHost,
        },
        initialPrompt: data.initialPrompt,
        sourceType: data.sourceType,
        voiceInk: data.voiceInk,
      });
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJsonError(res, 500, `Failed to start meeting bridge: ${message}`);
    }
  }

  handleStop(res: ServerResponse): void {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    try {
      const meeting = this.meetingBridge.stop();
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJsonError(res, 500, `Failed to stop meeting bridge: ${message}`);
    }
  }

  async handleChunk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ chunk?: unknown }>(req, res);
    if (!data) return;
    if (data.chunk === undefined) {
      this.sendJsonError(res, 400, 'Missing chunk');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestChunk(data.chunk);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge' ? 409 : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting chunk: ${message}`);
    }
  }

  async handleChunks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ chunks?: unknown }>(req, res);
    if (!data) return;
    if (!Array.isArray(data.chunks) || data.chunks.length === 0) {
      this.sendJsonError(res, 400, 'Missing chunks');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestChunks(data.chunks);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge' ? 409 : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting chunks: ${message}`);
    }
  }

  async handleUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ update?: unknown; text?: unknown; kind?: unknown }>(req, res);
    if (!data) return;

    const update = data.update ?? (data.text !== undefined ? { text: data.text, kind: data.kind } : undefined);
    if (update === undefined) {
      this.sendJsonError(res, 400, 'Missing update');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestOperatorUpdate(update);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message === 'Meeting update text is empty'
          ? 400
          : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting update: ${message}`);
    }
  }

  async handleCandidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{
      event?: unknown;
      text?: unknown;
      title?: unknown;
      kind?: unknown;
      transcriptChunkIndices?: unknown;
      operatorUpdateIndices?: unknown;
    }>(req, res);
    if (!data) return;

    const event = data.event ?? (
      data.text !== undefined
        ? {
            text: data.text,
            title: data.title,
            kind: data.kind,
            transcriptChunkIndices: data.transcriptChunkIndices,
            operatorUpdateIndices: data.operatorUpdateIndices,
          }
        : undefined
    );
    if (event === undefined) {
      this.sendJsonError(res, 400, 'Missing event');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestCandidateEvent(event);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message === 'Meeting candidate event text is empty'
          || message === 'Meeting candidate event requires transcript or operator provenance'
          || message.startsWith('Meeting candidate event cites invalid ')
          ? 400
          : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting candidate event: ${message}`);
    }
  }

  async handlePromoteCandidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ eventIndex?: unknown }>(req, res);
    if (!data) return;

    const eventIndex = typeof data.eventIndex === 'number' ? data.eventIndex : Number(data.eventIndex);
    if (!Number.isInteger(eventIndex) || eventIndex < 1) {
      this.sendJsonError(res, 400, 'Missing eventIndex');
      return;
    }

    try {
      const meeting = await this.meetingBridge.promoteCandidateEvent(eventIndex);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message.startsWith('Meeting candidate event not found:')
          || message.startsWith('Meeting candidate event already promoted:')
          ? 400
          : message === 'Remote origin not found'
            ? 404
            : 500;
      this.sendJsonError(res, status, `Failed to promote meeting candidate event: ${message}`);
    }
  }

  async handlePromoteBrief(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ title?: unknown }>(req, res);
    if (!data) return;

    try {
      const meeting = await this.meetingBridge.promoteLiveBrief(
        typeof data.title === 'string' ? data.title : undefined,
      );
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message === 'Meeting live brief is empty'
          ? 400
          : message === 'Remote origin not found'
            ? 404
            : 500;
      this.sendJsonError(res, status, `Failed to promote meeting brief: ${message}`);
    }
  }

  async handleRetrieval(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{ request?: unknown; text?: unknown }>(req, res);
    if (!data) return;

    const request = data.request ?? (data.text !== undefined ? { text: data.text } : undefined);
    if (request === undefined) {
      this.sendJsonError(res, 400, 'Missing retrieval request');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestRetrievalRequest(request);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message === 'Meeting retrieval request text is empty'
          ? 400
          : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting retrieval request: ${message}`);
    }
  }

  async handleRetrievedEvidence(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not initialized');
      return;
    }

    const data = await this.parseJsonBody<{
      evidence?: unknown;
      type?: unknown;
      title?: unknown;
      fiberId?: unknown;
      path?: unknown;
      line?: unknown;
      match?: unknown;
      requestIndex?: unknown;
    }>(req, res);
    if (!data) return;

    const evidence = data.evidence ?? (
      data.title !== undefined
        ? {
            type: data.type,
            title: data.title,
            fiberId: data.fiberId,
            path: data.path,
            line: data.line,
            match: data.match,
            requestIndex: data.requestIndex,
          }
        : undefined
    );
    if (evidence === undefined) {
      this.sendJsonError(res, 400, 'Missing evidence');
      return;
    }

    try {
      const meeting = this.meetingBridge.ingestRetrievedEvidence(evidence);
      this.sendJsonSuccess(res, { success: true, meeting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'No active meeting bridge'
        ? 409
        : message === 'Meeting retrieved evidence title is empty'
          || message === 'Meeting retrieved evidence type is invalid'
          || message === 'Meeting retrieved evidence fiber is missing fiberId'
          || message === 'Meeting retrieved evidence file is missing path'
          || message.startsWith('Meeting retrieved evidence cites invalid retrieval request index:')
          ? 400
          : 500;
      this.sendJsonError(res, status, `Failed to ingest meeting retrieved evidence: ${message}`);
    }
  }

  private getState(): MeetingBridgeState | null {
    return this.meetingBridge?.getState() ?? null;
  }
}
