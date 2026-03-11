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
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { AnnotationPersistence } from './AnnotationPersistence.js';
import type { Session } from './SessionTracker.js';
import type { RecentFileTracker } from './RecentFileTracker.js';
import { shellEscape } from './KittyIntegration.js';
import { HttpApiAnnotations } from './HttpApiAnnotations.js';
import { HttpApiFileContent } from './HttpApiFileContent.js';
import { HttpApiHooksRuntime } from './HttpApiHooksRuntime.js';
import { HttpApiTapestry } from './HttpApiTapestry.js';

const execFileAsync = promisify(execFile);

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

    if (url.pathname.startsWith('/tapestry-asset/')) {
      await this.tapestryApi.handleTapestryAsset(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/activate-city') {
      await this.handleActivateCity(url, res);
      return true;
    }

    if (url.pathname === '/file-content') {
      await this.fileContentApi.handleFileContent(url, res);
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
      await this.handlePlaygroundList(url, res);
      return true;
    }

    if (url.pathname === '/playground') {
      await this.handlePlayground(url, res);
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

    if (req.method === 'POST' && url.pathname === '/hook/file-touch') {
      await this.hooksRuntimeApi.handleHookFileTouch(req, res);
      return true;
    }

    return false;
  }

  /**
   * Get SSH host for a city (from origin or persistence)
   */
  private getSshHost(city: City): string {
    const origin = this.originLookup.getOrigin(city.originId);
    const persistedCity = this.persistenceLookup.getCityById(city.id);
    return origin?.sshHost || persistedCity?.sshHost || city.originId.replace('remote-', '');
  }

  /**
   * Activate dormant remote city endpoint
   * POST /activate-city?cityId=xxx
   */
  private async handleActivateCity(url: URL, res: ServerResponse): Promise<void> {
    console.log(`[Activate] Received request for cityId=${url.searchParams.get('cityId')}`);
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing cityId parameter' }));
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'City not found' }));
      return;
    }

    // Only activate remote cities
    if (city.originId === 'local') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot activate local city - start a session manually' }));
      return;
    }

    const sshHost = this.getSshHost(city);

    try {
      // Check if agent is already running on this host
      // Use -T to disable TTY allocation (avoids "Pseudo-terminal will not be allocated" warnings)
      const { stdout: checkOutput } = await execFileAsync(
        'ssh', ['-T', sshHost, 'tmux has-session -t portolan-agent 2>/dev/null && echo running || echo stopped'],
        { timeout: 10000 }
      );

      if (checkOutput.trim() === 'running') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'already_running', message: 'Agent already running on ' + sshHost }));
        return;
      }

      // Start the agent via SSH
      // Use -T to disable TTY allocation, bash -l to get login shell with nvm/node in PATH
      console.log(`[Activate] Starting portolan-agent on ${sshHost}...`);
      await execFileAsync(
        'ssh', ['-T', sshHost, `tmux new-session -d -s portolan-agent "bash -l -c \\"node ~/bin/portolan-agent.js connect --ssh-host=${sshHost}\\""`],
        { timeout: 30000 }
      );

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'started', message: 'Agent started on ' + sshHost }));
    } catch (error: any) {
      console.error(`[Activate] Failed to start agent on ${sshHost}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Failed to start agent: ' + error.message }));
    }
  }

  // ============================================================================
  // Playground Endpoints
  // ============================================================================

  /**
   * List available playgrounds for a city
   * GET /playground-list?cityId=xxx
   */
  private async handlePlaygroundList(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing cityId parameter' }));
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'City not found' }));
      return;
    }

    const playgroundsDir = `${city.path}/.portolan/playgrounds`;

    try {
      let files: string[];
      if (city.originId === 'local') {
        const { readdirSync } = await import('fs');
        files = readdirSync(playgroundsDir).filter(f => f.endsWith('.html'));
      } else {
        const sshHost = this.getSshHost(city);
        const { stdout } = await execFileAsync(
          'ssh', [sshHost, `ls ${shellEscape(playgroundsDir)}/*.html 2>/dev/null || true`],
          { timeout: 10000 }
        );
        files = stdout.trim().split('\n')
          .filter(Boolean)
          .map(f => f.split('/').pop()!)
          .filter(f => f.endsWith('.html'));
      }

      // Sort by name, most recently modified first would be nice but simpler to just sort alphabetically
      files.sort();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ playgrounds: files }));
    } catch (error: any) {
      console.error('Failed to list playgrounds:', error.message);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ playgrounds: [] }));
    }
  }

  /**
   * Serve a playground HTML file
   * GET /playground?cityId=xxx&name=playground.html
   */
  private async handlePlayground(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const name = url.searchParams.get('name');

    if (!cityId || !name) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId or name parameter');
      return;
    }

    // Security: prevent directory traversal
    if (name.includes('/') || name.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid playground name');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const playgroundPath = `${city.path}/.portolan/playgrounds/${name}`;

    try {
      let html: string;
      if (city.originId === 'local') {
        html = await readFile(playgroundPath, 'utf-8');
      } else {
        const sshHost = this.getSshHost(city);
        const { stdout } = await execFileAsync(
          'ssh', [sshHost, `cat ${shellEscape(playgroundPath)}`],
          { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
        );
        html = stdout;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(html);
    } catch (error: any) {
      console.error('Failed to fetch playground:', error.message);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Playground not found');
    }
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
