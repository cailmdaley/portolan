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
      parakeet?: MeetingBridgeStartOptions['parakeet'];
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
        parakeet: data.parakeet,
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

  private getState(): MeetingBridgeState | null {
    return this.meetingBridge?.getState() ?? null;
  }
}
