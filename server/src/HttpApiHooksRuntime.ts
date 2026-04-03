import { IncomingMessage, ServerResponse } from 'http';
import { isAbsolute, normalize, resolve } from 'path';
import type { MeetingBridge } from './MeetingBridge.js';
import type { RecentFileTracker } from './RecentFileTracker.js';
import type { Session } from './SessionTracker.js';

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
  getAllSessions(): Session[];
}

type RuntimeDiagnosticsProvider = () => unknown | Promise<unknown>;

interface HttpApiHooksRuntimeDeps {
  parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export class HttpApiHooksRuntime {
  private parseJsonBody: HttpApiHooksRuntimeDeps['parseJsonBody'];
  private sendJsonError: HttpApiHooksRuntimeDeps['sendJsonError'];
  private sendJsonSuccess: HttpApiHooksRuntimeDeps['sendJsonSuccess'];
  private sessionLookup: SessionLookup | null = null;
  private recentFileTracker: RecentFileTracker | null = null;
  private meetingBridge: MeetingBridge | null = null;
  private hookSessionToWorkerSessionId: Map<string, string> = new Map();
  private runtimeDiagnosticsProvider: RuntimeDiagnosticsProvider | null = null;

  constructor(deps: HttpApiHooksRuntimeDeps) {
    this.parseJsonBody = deps.parseJsonBody;
    this.sendJsonError = deps.sendJsonError;
    this.sendJsonSuccess = deps.sendJsonSuccess;
  }

  setSessionLookup(lookup: SessionLookup): void {
    this.sessionLookup = lookup;
  }

  setRecentFileTracker(tracker: RecentFileTracker): void {
    this.recentFileTracker = tracker;
  }

  setMeetingBridge(bridge: MeetingBridge): void {
    this.meetingBridge = bridge;
  }

  setRuntimeDiagnosticsProvider(provider: RuntimeDiagnosticsProvider): void {
    this.runtimeDiagnosticsProvider = provider;
  }

  async handleRecentFiles(url: URL, res: ServerResponse): Promise<void> {
    if (!this.recentFileTracker) {
      this.sendJsonError(res, 500, 'Recent file tracker not configured');
      return;
    }

    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      this.sendJsonError(res, 400, 'Missing sessionId parameter');
      return;
    }

    const limitRaw = parseInt(url.searchParams.get('limit') || '5', 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, limitRaw)) : 5;
    const files = this.recentFileTracker.getRecentFiles(sessionId, limit);
    this.sendJsonSuccess(res, { sessionId, files });
  }

  async handleHookFileTouch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.recentFileTracker) {
      this.sendJsonError(res, 500, 'Recent file tracker not configured');
      return;
    }
    if (!this.sessionLookup) {
      this.sendJsonError(res, 500, 'Session lookup not configured');
      return;
    }

    const payload = await this.parseJsonBody<Record<string, unknown>>(req, res);
    if (!payload) return;

    const sessionIdRaw = typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : '';
    const toolNameRaw = typeof payload.tool_name === 'string'
      ? payload.tool_name
      : typeof payload.toolName === 'string'
        ? payload.toolName
        : '';

    const toolInput = payload.tool_input && typeof payload.tool_input === 'object'
      ? payload.tool_input as Record<string, unknown>
      : payload.toolInput && typeof payload.toolInput === 'object'
        ? payload.toolInput as Record<string, unknown>
        : null;

    const filePathRaw = toolInput && typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : toolInput && typeof toolInput.path === 'string'
        ? toolInput.path
        : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const tmuxSessionRaw = typeof payload.tmux_session === 'string'
      ? payload.tmux_session
      : typeof payload.tmuxSession === 'string'
        ? payload.tmuxSession
        : '';
    const originNameRaw = typeof payload.origin_name === 'string'
      ? payload.origin_name
      : typeof payload.originName === 'string'
        ? payload.originName
        : '';
    const filePath = this.normalizeHookFilePath(filePathRaw, cwd);

    if (!sessionIdRaw || !toolNameRaw || !filePath) {
      this.sendJsonError(res, 400, 'Missing required fields: session_id, tool_name, tool_input.file_path');
      return;
    }

    if (!['Read', 'Write', 'Edit'].includes(toolNameRaw)) {
      this.sendJsonSuccess(res, { success: true, ignored: true, reason: 'tool-filter' });
      return;
    }

    const resolvedSession = this.resolveWorkerSessionForHook(
      sessionIdRaw,
      cwd,
      filePath,
      tmuxSessionRaw,
      originNameRaw,
    );
    if (!resolvedSession) {
      this.sendJsonSuccess(res, { success: true, stored: false, reason: 'session-not-found' });
      return;
    }

    this.hookSessionToWorkerSessionId.set(sessionIdRaw, resolvedSession.id);
    this.recentFileTracker.recordTouch(resolvedSession.id, toolNameRaw, filePath);
    this.sendJsonSuccess(res, {
      success: true,
      stored: true,
      workerSessionId: resolvedSession.id,
      tmuxSession: resolvedSession.tmuxSession,
    });
  }

  async handleHookAssistantTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sessionLookup) {
      this.sendJsonError(res, 500, 'Session lookup not configured');
      return;
    }
    if (!this.meetingBridge) {
      this.sendJsonError(res, 500, 'Meeting bridge not configured');
      return;
    }

    const payload = await this.parseJsonBody<Record<string, unknown>>(req, res);
    if (!payload) return;

    const sessionIdRaw = typeof payload.session_id === 'string'
      ? payload.session_id
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const tmuxSessionRaw = typeof payload.tmux_session === 'string'
      ? payload.tmux_session
      : typeof payload.tmuxSession === 'string'
        ? payload.tmuxSession
        : '';
    const originNameRaw = typeof payload.origin_name === 'string'
      ? payload.origin_name
      : typeof payload.originName === 'string'
        ? payload.originName
        : '';
    const transcriptPath = typeof payload.transcript_path === 'string'
      ? payload.transcript_path
      : typeof payload.transcriptPath === 'string'
        ? payload.transcriptPath
        : '';
    const responses = Array.isArray(payload.responses)
      ? payload.responses
      : payload.response !== undefined
        ? [payload.response]
        : [];

    if (!sessionIdRaw || responses.length === 0) {
      this.sendJsonError(res, 400, 'Missing required fields: session_id, responses');
      return;
    }

    const resolvedSession = this.resolveWorkerSessionForHook(
      sessionIdRaw,
      cwd,
      transcriptPath,
      tmuxSessionRaw,
      originNameRaw,
    );
    if (!resolvedSession) {
      this.sendJsonSuccess(res, { success: true, stored: false, reason: 'session-not-found' });
      return;
    }

    this.hookSessionToWorkerSessionId.set(sessionIdRaw, resolvedSession.id);
    const meeting = this.meetingBridge.ingestAssistantResponses({
      sessionId: resolvedSession.id,
      tmuxSession: resolvedSession.tmuxSession,
      originId: resolvedSession.originId,
    }, responses, {
      transcriptPath,
      hookSessionId: sessionIdRaw,
    });

    if (!meeting) {
      this.sendJsonSuccess(res, { success: true, stored: false, reason: 'no-active-meeting' });
      return;
    }

    this.sendJsonSuccess(res, {
      success: true,
      stored: true,
      workerSessionId: resolvedSession.id,
      tmuxSession: resolvedSession.tmuxSession,
      meetingId: meeting.meetingId,
      assistantResponseCount: meeting.assistantResponseCount,
    });
  }

  async handleDebugRuntime(res: ServerResponse): Promise<void> {
    try {
      const runtimeDiagnostics = this.runtimeDiagnosticsProvider
        ? await this.runtimeDiagnosticsProvider()
        : {};

      const debug = {
        timestamp: Date.now(),
        pid: process.pid,
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        runtime: runtimeDiagnostics,
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(debug, null, 2));
    } catch (error) {
      console.error('Failed to collect runtime diagnostics:', error);
      this.sendJsonError(res, 500, 'Failed to collect runtime diagnostics');
    }
  }

  private resolveWorkerSessionForHook(
    hookSessionId: string,
    cwd: string,
    filePath: string,
    tmuxSessionHint: string,
    originNameHint: string,
  ): Session | null {
    if (!this.sessionLookup) return null;

    const mappedWorkerSessionId = this.hookSessionToWorkerSessionId.get(hookSessionId);
    if (mappedWorkerSessionId) {
      const mappedSession = this.sessionLookup.findSession(mappedWorkerSessionId);
      if (mappedSession) return mappedSession;
      this.hookSessionToWorkerSessionId.delete(hookSessionId);
    }

    const directByWorkerId = this.sessionLookup.findSession(hookSessionId);
    if (directByWorkerId) return directByWorkerId;

    const allSessions = this.sessionLookup.getAllSessions();
    const originIdHint = originNameHint.trim() ? `remote-${originNameHint.trim()}` : '';
    const scopedSessions = originIdHint
      ? allSessions.filter((s) => s.originId === originIdHint)
      : allSessions;

    if (tmuxSessionHint.trim()) {
      const tmuxMatches = scopedSessions.filter((s) => s.tmuxSession === tmuxSessionHint.trim());
      if (tmuxMatches.length === 1) return tmuxMatches[0];
    }

    const directByTmux = scopedSessions.filter((s) => s.tmuxSession === hookSessionId);
    if (directByTmux.length === 1) return directByTmux[0];

    const cwdMatches = cwd
      ? scopedSessions.filter((s) =>
        this.pathContains(s.cwd, cwd) || this.pathContains(cwd, s.cwd)
      )
      : [];
    if (cwdMatches.length === 1) return cwdMatches[0];

    const fileMatches = filePath
      ? scopedSessions.filter((s) => this.pathContains(s.cwd, filePath))
      : [];
    if (fileMatches.length === 1) return fileMatches[0];

    const candidates = (cwdMatches.length > 1 ? cwdMatches : fileMatches.length > 1 ? fileMatches : [])
      .slice()
      .sort((a, b) => b.lastActivity - a.lastActivity);
    if (candidates.length > 0) return candidates[0];

    const working = scopedSessions
      .filter((s) => s.status === 'working')
      .sort((a, b) => b.lastActivity - a.lastActivity);
    if (working.length === 1) return working[0];

    return null;
  }

  private normalizePathForMatch(pathValue: string): string {
    const trimmed = pathValue.trim();
    if (!trimmed) return '';
    const normalizedPath = normalize(trimmed);
    if (normalizedPath === '/') return '/';
    return normalizedPath.replace(/\/+$/, '');
  }

  private pathContains(basePath: string, targetPath: string): boolean {
    const base = this.normalizePathForMatch(basePath);
    const target = this.normalizePathForMatch(targetPath);
    if (!base || !target) return false;
    if (base === target) return true;
    if (base === '/') return target.startsWith('/');
    return target.startsWith(`${base}/`);
  }

  private normalizeHookFilePath(filePath: string, cwd: string): string {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) return '';

    if (isAbsolute(trimmedPath)) {
      return normalize(trimmedPath);
    }

    const trimmedCwd = cwd.trim();
    if (trimmedCwd && isAbsolute(trimmedCwd)) {
      return normalize(resolve(trimmedCwd, trimmedPath));
    }

    return trimmedPath;
  }
}
