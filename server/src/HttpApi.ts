/**
 * HttpApi - HTTP request handlers
 *
 * Handles non-WebSocket HTTP endpoints:
 * - Tapestry DAG (fibers, evidence, staleness)
 * - Evidence artifact serving
 * - Annotation CRUD
 * - City activation (start remote agent)
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { AnnotationPersistence } from './AnnotationPersistence.js';
import type { Session } from './SessionTracker.js';
import type { RecentFileTracker } from './RecentFileTracker.js';
import { HttpApiActivation } from './HttpApiActivation.js';
import { HttpApiAnnotations } from './HttpApiAnnotations.js';
import { HttpApiFileContent } from './HttpApiFileContent.js';
import { HttpApiHooksRuntime } from './HttpApiHooksRuntime.js';
import { HttpApiMeeting } from './HttpApiMeeting.js';
import { HttpApiPlayground } from './HttpApiPlayground.js';
import { HttpApiTapestry } from './HttpApiTapestry.js';
import type { MeetingBridge } from './MeetingBridge.js';

// ============================================================================
// Types
// ============================================================================

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface PersistenceLookup {
  getCityById(cityId: string): { sshHost?: string } | null;
  findSshHostForPath(path: string): string | undefined;
}

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
  getAllSessions(): Session[];
}

type RuntimeDiagnosticsProvider = () => unknown | Promise<unknown>;

// ============================================================================
// HttpApi
// ============================================================================

export class HttpApi {
  private cityLookup: CityLookup;
  private originLookup: OriginLookup;
  private persistenceLookup: PersistenceLookup;
  private annotationsApi: HttpApiAnnotations;
  private fileContentApi: HttpApiFileContent;
  private hooksRuntimeApi: HttpApiHooksRuntime;
  private meetingApi: HttpApiMeeting;
  private activationApi: HttpApiActivation;
  private playgroundApi: HttpApiPlayground;
  private tapestryApi: HttpApiTapestry;

  constructor(
    cityLookup: CityLookup,
    originLookup: OriginLookup,
    persistenceLookup: PersistenceLookup
  ) {
    this.cityLookup = cityLookup;
    this.originLookup = originLookup;
    this.persistenceLookup = persistenceLookup;
    this.annotationsApi = new HttpApiAnnotations({
      cityLookup,
      originLookup,
      getSshHost: (city) => this.getSshHost(city),
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.fileContentApi = new HttpApiFileContent({
      originLookup,
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.hooksRuntimeApi = new HttpApiHooksRuntime({
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.meetingApi = new HttpApiMeeting({
      originLookup,
      parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => this.parseJsonBody<T>(req, res),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
    this.activationApi = new HttpApiActivation({
      cityLookup,
      getSshHost: (city) => this.getSshHost(city),
    });
    this.playgroundApi = new HttpApiPlayground({
      cityLookup,
      getSshHost: (city) => this.getSshHost(city),
    });
    this.tapestryApi = new HttpApiTapestry({
      cityLookup,
      fileContentApi: this.fileContentApi,
      getSshHost: (city) => this.getSshHost(city),
      sendJsonError: (res, status, error) => this.sendJsonError(res, status, error),
      sendJsonSuccess: (res, data) => this.sendJsonSuccess(res, data),
    });
  }

  /**
   * Set annotation persistence instance
   */
  setAnnotationPersistence(persistence: AnnotationPersistence): void {
    this.annotationsApi.setAnnotationPersistence(persistence);
  }

  /**
   * Set session lookup instance
   */
  setSessionLookup(lookup: SessionLookup): void {
    this.annotationsApi.setSessionLookup(lookup);
    this.hooksRuntimeApi.setSessionLookup(lookup);
    this.meetingApi.setSessionLookup(lookup);
  }

  /**
   * Set recent file tracker for worker hover tooltips
   */
  setRecentFileTracker(tracker: RecentFileTracker): void {
    this.hooksRuntimeApi.setRecentFileTracker(tracker);
  }

  /**
   * Set runtime diagnostics provider for /debug-runtime endpoint.
   */
  setRuntimeDiagnosticsProvider(provider: RuntimeDiagnosticsProvider): void {
    this.hooksRuntimeApi.setRuntimeDiagnosticsProvider(provider);
  }

  setMeetingBridge(bridge: MeetingBridge): void {
    this.meetingApi.setMeetingBridge(bridge);
    this.hooksRuntimeApi.setMeetingBridge(bridge);
  }

  setOnCreateNewWorker(fn: (cityPath: string, originId: string) => Promise<string>): void {
    this.annotationsApi.setOnCreateNewWorker(fn);
  }

  setOnFocusSession(fn: (sessionId: string) => void): void {
    this.annotationsApi.setOnFocusSession(fn);
  }

  /**
   * Handle HTTP request - returns true if handled, false to fall through
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Handle CORS preflight for all HTTP methods
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return true;
    }

    if (url.pathname === '/tapestry') {
      await this.tapestryApi.handleTapestry(url, res);
      return true;
    }

    if (url.pathname === '/astra/graph') {
      await this.tapestryApi.handleAstraGraph(url, res);
      return true;
    }

    if (url.pathname.startsWith('/tapestry-asset/')) {
      await this.tapestryApi.handleTapestryAsset(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/activate-city') {
      await this.activationApi.handleActivateCity(url, res);
      return true;
    }

    if (url.pathname === '/file-content') {
      await this.fileContentApi.handleFileContent(url, res);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/project-file/')) {
      await this.fileContentApi.handleProjectFile(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/save-file') {
      await this.fileContentApi.handleSaveFile(req, res);
      return true;
    }

    // Annotation endpoints
    if (url.pathname === '/annotations' && req.method === 'GET') {
      await this.annotationsApi.handleGetAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/recent-annotations' && req.method === 'GET') {
      await this.annotationsApi.handleRecentAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/annotations' && req.method === 'POST') {
      await this.annotationsApi.handleCreateAnnotation(req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'PUT') {
      const id = url.pathname.split('/')[2];
      await this.annotationsApi.handleUpdateAnnotation(id, req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'DELETE') {
      const id = url.pathname.split('/')[2];
      await this.annotationsApi.handleDeleteAnnotation(id, res);
      return true;
    }

    if (url.pathname === '/send-annotations' && req.method === 'POST') {
      await this.annotationsApi.handleSendAnnotations(req, res);
      return true;
    }

    if (url.pathname === '/file-as-fiber' && req.method === 'POST') {
      await this.annotationsApi.handleFileAsFiber(req, res);
      return true;
    }

    if (url.pathname === '/promote-to-felt' && req.method === 'POST') {
      await this.annotationsApi.handlePromoteToFelt(req, res);
      return true;
    }

    if (url.pathname === '/playground-list') {
      await this.playgroundApi.handlePlaygroundList(url, res);
      return true;
    }

    if (url.pathname === '/playground') {
      await this.playgroundApi.handlePlayground(url, res);
      return true;
    }

    if (url.pathname === '/recent-files' && req.method === 'GET') {
      await this.hooksRuntimeApi.handleRecentFiles(url, res);
      return true;
    }

    if (url.pathname === '/debug-runtime') {
      await this.hooksRuntimeApi.handleDebugRuntime(res);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/meeting-bridge') {
      this.meetingApi.handleGetState(res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/start') {
      await this.meetingApi.handleStart(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/stop') {
      this.meetingApi.handleStop(res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/chunk') {
      await this.meetingApi.handleChunk(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/chunks') {
      await this.meetingApi.handleChunks(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/update') {
      await this.meetingApi.handleUpdate(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/candidate') {
      await this.meetingApi.handleCandidate(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/candidate/promote') {
      await this.meetingApi.handlePromoteCandidate(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/brief/promote') {
      await this.meetingApi.handlePromoteBrief(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/retrieval') {
      await this.meetingApi.handleRetrieval(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/meeting-bridge/retrieval/evidence') {
      await this.meetingApi.handleRetrievedEvidence(req, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/hook/assistant-turn') {
      await this.hooksRuntimeApi.handleHookAssistantTurn(req, res);
      return true;
    }

    return false;
  }

  /**
   * Get SSH host for a city (from origin or persistence)
   */
  private getSshHost(city: City): string {
    const origin = this.originLookup.getOrigin(city.originId);
    if (origin?.sshHost) return origin.sshHost;
    const persistedCity = this.persistenceLookup.getCityById(city.id);
    if (persistedCity?.sshHost) return persistedCity.sshHost;
    // Fallback: ID-based lookup can fail when CityManager normalizes keys differently
    // from CityPersistence (e.g., remote-c02 vs remote-candide). Search by path.
    const pathSshHost = this.persistenceLookup.findSshHostForPath(city.path);
    if (pathSshHost) return pathSshHost;
    return city.originId.replace('remote-', '');
  }

  private formatAnnotationsForClaude(filePath: string, annotations: unknown[], globalComment?: string): string {
    return this.annotationsApi.formatAnnotationsForClaude(filePath, annotations as any, globalComment);
  }

  private formatClaimsAnnotationsForClaude(cityName: string, annotations: unknown[], globalComment?: string): string {
    return this.annotationsApi.formatClaimsAnnotationsForClaude(cityName, annotations as any, globalComment);
  }

  /**
   * Parse JSON body from request, sending error response if invalid
   */
  private async parseJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      this.sendJsonError(res, 400, 'Invalid JSON body');
      return null;
    }
  }

  /**
   * Send JSON error response
   */
  private sendJsonError(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error }));
  }

  /**
   * Send JSON success response
   */
  private sendJsonSuccess(res: ServerResponse, data: Record<string, unknown>): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }

}
