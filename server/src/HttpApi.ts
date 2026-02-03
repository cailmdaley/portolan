/**
 * HttpApi - HTTP request handlers
 *
 * Handles non-WebSocket HTTP endpoints:
 * - Claims dashboard proxy (local and remote)
 * - Claims assets proxy (fonts, images)
 * - City activation (start remote agent)
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { exec, spawn, execSync } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { extname } from 'path';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { AnnotationPersistence, Annotation } from './AnnotationPersistence.js';
import type { Session } from './SessionTracker.js';
import type { RecentFilesManager } from './RecentFilesManager.js';
import type { TranscriptReader } from './TranscriptReader.js';
import type { ConversationCache, CachedMessage } from './ConversationCache.js';

const execAsync = promisify(exec);

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

// ============================================================================
// HttpApi
// ============================================================================

// Remote conversation lookup callback
export type RemoteConversationLookup = (sessionId: string) => any[] | undefined;

export class HttpApi {
  private cityLookup: CityLookup;
  private originLookup: OriginLookup;
  private persistenceLookup: PersistenceLookup;
  private annotationPersistence: AnnotationPersistence | null = null;
  private sessionLookup: SessionLookup | null = null;
  private recentFilesManager: RecentFilesManager | null = null;
  private transcriptReader: TranscriptReader | null = null;
  private remoteConversationLookup: RemoteConversationLookup | null = null;
  private conversationCache: ConversationCache | null = null;

  constructor(
    cityLookup: CityLookup,
    originLookup: OriginLookup,
    persistenceLookup: PersistenceLookup
  ) {
    this.cityLookup = cityLookup;
    this.originLookup = originLookup;
    this.persistenceLookup = persistenceLookup;
  }

  /**
   * Set annotation persistence instance
   */
  setAnnotationPersistence(persistence: AnnotationPersistence): void {
    this.annotationPersistence = persistence;
  }

  /**
   * Set session lookup instance
   */
  setSessionLookup(lookup: SessionLookup): void {
    this.sessionLookup = lookup;
  }

  /**
   * Set recent files manager for tracking remote file access
   */
  setRecentFilesManager(manager: RecentFilesManager): void {
    this.recentFilesManager = manager;
  }

  /**
   * Set transcript reader for conversation history
   */
  setTranscriptReader(reader: TranscriptReader): void {
    this.transcriptReader = reader;
  }

  /**
   * Set remote conversation lookup for remote worker transcripts
   */
  setRemoteConversationLookup(lookup: RemoteConversationLookup): void {
    this.remoteConversationLookup = lookup;
  }

  /**
   * Set conversation cache for hook-based conversation updates
   */
  setConversationCache(cache: ConversationCache): void {
    this.conversationCache = cache;
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

    if (url.pathname === '/claims-dashboard') {
      await this.handleClaimsDashboard(url, res);
      return true;
    }

    if (url.pathname.startsWith('/claims-assets/')) {
      await this.handleClaimsAssets(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/activate-city') {
      await this.handleActivateCity(url, res);
      return true;
    }

    if (url.pathname === '/file-content') {
      await this.handleFileContent(url, res);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/save-file') {
      await this.handleSaveFile(req, res);
      return true;
    }

    // Annotation endpoints
    if (url.pathname === '/annotations' && req.method === 'GET') {
      await this.handleGetAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/recent-annotations' && req.method === 'GET') {
      await this.handleRecentAnnotations(url, res);
      return true;
    }

    if (url.pathname === '/annotations' && req.method === 'POST') {
      await this.handleCreateAnnotation(req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'PUT') {
      const id = url.pathname.split('/')[2];
      await this.handleUpdateAnnotation(id, req, res);
      return true;
    }

    if (url.pathname.match(/^\/annotations\/[^/]+$/) && req.method === 'DELETE') {
      const id = url.pathname.split('/')[2];
      await this.handleDeleteAnnotation(id, res);
      return true;
    }

    if (url.pathname === '/send-annotations' && req.method === 'POST') {
      await this.handleSendAnnotations(req, res);
      return true;
    }

    if (url.pathname === '/send-message' && req.method === 'POST') {
      await this.handleSendMessage(req, res);
      return true;
    }

    if (url.pathname === '/file-as-fiber' && req.method === 'POST') {
      await this.handleFileAsFiber(req, res);
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

    if (url.pathname === '/conversation') {
      await this.handleConversation(url, res);
      return true;
    }

    if (url.pathname === '/debug-transcripts') {
      await this.handleDebugTranscripts(res);
      return true;
    }

    // Hook endpoints for conversation capture
    if (req.method === 'POST' && url.pathname === '/hook/message') {
      await this.handleHookMessage(req, res);
      return true;
    }

    if (url.pathname === '/hook/health') {
      await this.handleHookHealth(res);
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
   * Claims dashboard proxy endpoint
   */
  private async handleClaimsDashboard(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    if (!cityId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId parameter');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const dashboardPath = `${city.path}/results/claims/index.html`;

    try {
      let html: string;
      if (city.originId === 'local') {
        // Local city: read file directly
        const { readFileSync } = await import('fs');
        html = readFileSync(dashboardPath, 'utf-8');
      } else {
        // Remote city: fetch via SSH
        const sshHost = this.getSshHost(city);
        const { stdout } = await execAsync(`ssh ${sshHost} 'cat "${dashboardPath}"'`, { maxBuffer: 10 * 1024 * 1024 });
        html = stdout;
      }

      // Rewrite relative URLs (fonts, images) to use the proxy
      const assetsBase = `/claims-assets`;
      const rewrittenHtml = html
        .replace(/url\(['"]?([^'")\s]+\.(otf|ttf|woff2?|png|jpe?g|svg))['"]?\)/gi,
          (_, path) => `url('${assetsBase}/${path}?cityId=${cityId}')`)
        .replace(/src=['"]([^'"]+\.(png|jpe?g|svg|gif))['"]/gi,
          (_, path) => `src="${assetsBase}/${path}?cityId=${cityId}"`)
        // Inject base URL for dynamic image loading (used by JS code)
        .replace(/<head>/i, `<head><script>window.CLAIMS_ASSETS_BASE = "${assetsBase}"; window.CLAIMS_CITY_ID = "${cityId}";</script>`)
        // Rewrite dynamic imgPath construction to use proxy
        .replace(/const imgPath = ([^;]+);/g,
          `const imgPath = window.CLAIMS_ASSETS_BASE + '/' + ($1) + '?cityId=' + window.CLAIMS_CITY_ID;`)
        // Rewrite lightbox src construction
        .replace(/src: (claim\.id \+ '\/'\s*\+\s*[^}]+)/g,
          `src: window.CLAIMS_ASSETS_BASE + '/' + ($1) + '?cityId=' + window.CLAIMS_CITY_ID`);

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(rewrittenHtml);
    } catch (error) {
      console.error('Failed to fetch claims dashboard:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to load claims dashboard: ${error}`);
    }
  }

  /**
   * Claims assets proxy (fonts, images, etc.)
   */
  private async handleClaimsAssets(url: URL, res: ServerResponse): Promise<void> {
    const cityId = url.searchParams.get('cityId');
    const assetPath = url.pathname.replace('/claims-assets/', '');

    if (!cityId || !assetPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing cityId or asset path');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('City not found');
      return;
    }

    const fullPath = `${city.path}/results/claims/${assetPath}`;

    // Determine content type
    const ext = assetPath.split('.').pop()?.toLowerCase();
    const contentTypes: Record<string, string> = {
      'otf': 'font/otf',
      'ttf': 'font/ttf',
      'woff': 'font/woff',
      'woff2': 'font/woff2',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'svg': 'image/svg+xml',
      'css': 'text/css',
      'js': 'application/javascript',
    };
    const contentType = contentTypes[ext || ''] || 'application/octet-stream';

    try {
      let data: Buffer;
      if (city.originId === 'local') {
        const { readFileSync } = await import('fs');
        data = readFileSync(fullPath);
      } else {
        const sshHost = this.getSshHost(city);
        const { stdout } = await execAsync(`ssh ${sshHost} 'cat "${fullPath}"'`, {
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'buffer'
        });
        data = stdout as unknown as Buffer;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch (error) {
      console.error('Failed to fetch claims asset:', error);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Asset not found: ${assetPath}`);
    }
  }

  /**
   * File content endpoint for activity viewer
   * GET /file-content?path=/full/path/to/file&originId=optional&binary=true
   */
  private async handleFileContent(url: URL, res: ServerResponse): Promise<void> {
    const filePath = url.searchParams.get('path');
    const originId = url.searchParams.get('originId');
    const binary = url.searchParams.get('binary') === 'true';

    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Security: prevent directory traversal
    if (filePath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    const ext = extname(filePath).toLowerCase().slice(1);

    // Handle binary files (images, PDFs)
    if (binary && this.isBinaryExtension(ext)) {
      await this.handleBinaryContent(filePath, originId, ext, res);
      return;
    }

    try {
      let content: string;

      if (!originId || originId === 'local') {
        // Local file: read directly
        content = await readFile(filePath, 'utf-8');
      } else {
        // Remote file: fetch via SSH
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        const { stdout } = await execAsync(
          `ssh ${origin.sshHost} 'cat "${filePath}"'`,
          { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
        );
        content = stdout;
      }

      // Detect language from extension
      const language = this.extToLanguage(ext);

      // Record remote file access for persistence
      if (originId && originId !== 'local' && this.recentFilesManager) {
        // Extract relative path from full path for display
        const relativePath = filePath.split('/').slice(-2).join('/'); // last 2 segments
        this.recentFilesManager.recordRemoteFileAccess(originId, relativePath, filePath);
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ content, language, path: filePath }));
    } catch (error: any) {
      console.error('Failed to fetch file content:', error.message);
      const statusCode = error.code === 'ENOENT' ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'File not found' : 'Failed to read file' }));
    }
  }

  /**
   * Binary MIME types by extension
   */
  private readonly binaryMimeTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'pdf': 'application/pdf',
  };

  /**
   * Check if extension is a binary type (image or PDF)
   */
  private isBinaryExtension(ext: string): boolean {
    return ext in this.binaryMimeTypes;
  }

  /**
   * Handle binary file content (images, PDFs) - returns base64 data URL
   */
  private async handleBinaryContent(
    filePath: string,
    originId: string | null,
    ext: string,
    res: ServerResponse
  ): Promise<void> {
    const mimeType = this.binaryMimeTypes[ext] || 'application/octet-stream';
    const fileType = ext === 'pdf' ? 'pdf' : 'image';
    // PDFs need larger buffer/timeout
    const maxBuffer = ext === 'pdf' ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    const timeout = ext === 'pdf' ? 60000 : 30000;

    try {
      let data: Buffer;

      if (!originId || originId === 'local') {
        data = await readFile(filePath);
      } else {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        const { stdout } = await execAsync(
          `ssh ${origin.sshHost} 'base64 "${filePath}"'`,
          { maxBuffer, timeout }
        );
        data = Buffer.from(stdout.replace(/\s/g, ''), 'base64');
      }

      const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;

      // Record remote file access for persistence
      if (originId && originId !== 'local' && this.recentFilesManager) {
        const relativePath = filePath.split('/').slice(-2).join('/');
        this.recentFilesManager.recordRemoteFileAccess(originId, relativePath, filePath);
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ type: fileType, url: dataUrl, path: filePath }));
    } catch (error: any) {
      console.error(`Failed to fetch ${fileType} content:`, error.message);
      const statusCode = error.code === 'ENOENT' ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error.code === 'ENOENT' ? `${fileType} not found` : `Failed to read ${fileType}`
      }));
    }
  }

  /**
   * Save file content endpoint
   * POST /save-file
   * Body: { path: string, content: string, originId?: string }
   */
  private async handleSaveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse JSON body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: { path?: string; content?: string; originId?: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { path: filePath, content, originId } = data;

    if (!filePath || content === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path or content' }));
      return;
    }

    // Security: prevent directory traversal
    if (filePath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    try {
      if (!originId || originId === 'local') {
        // Local file: write directly
        await writeFile(filePath, content, 'utf-8');
      } else {
        // Remote file: write via SSH using stdin to avoid escaping issues
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        await this.writeRemoteFile(origin.sshHost, filePath, content);
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true, path: filePath }));
    } catch (error: any) {
      console.error('Failed to save file:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to save file: ' + error.message }));
    }
  }

  /**
   * Write file to remote host via SSH stdin pipe
   */
  private writeRemoteFile(sshHost: string, filePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', [sshHost, `cat > "${filePath}"`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      ssh.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ssh.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `SSH exited with code ${code}`));
        }
      });

      ssh.on('error', reject);

      // Write content to stdin and close
      ssh.stdin.write(content);
      ssh.stdin.end();
    });
  }

  /**
   * Map file extension to Prism.js language identifier
   */
  private extToLanguage(ext: string): string {
    const mapping: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'tsx',
      'js': 'javascript',
      'jsx': 'jsx',
      'json': 'json',
      'md': 'markdown',
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'css': 'css',
      'scss': 'scss',
      'html': 'html',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'toml': 'toml',
      'sql': 'sql',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'java': 'java',
      'rb': 'ruby',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'lua': 'lua',
      'vim': 'vim',
      'dockerfile': 'docker',
      'makefile': 'makefile',
      'mk': 'makefile',
    };
    return mapping[ext] || 'plaintext';
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
      const { stdout: checkOutput } = await execAsync(
        `ssh -T ${sshHost} 'tmux has-session -t portolan-agent 2>/dev/null && echo running || echo stopped'`,
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
      await execAsync(
        `ssh -T ${sshHost} 'tmux new-session -d -s portolan-agent "bash -l -c \\"node ~/bin/portolan-agent.js connect --ssh-host=${sshHost}\\""'`,
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
  // Annotation Endpoints
  // ============================================================================

  /**
   * Get recently annotated files
   * GET /recent-annotations?originId=optional&limit=10
   */
  private async handleRecentAnnotations(url: URL, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation persistence not initialized' }));
      return;
    }

    const originId = url.searchParams.get('originId') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);

    const recentFiles = this.annotationPersistence.getRecentFiles(originId, limit);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ files: recentFiles }));
  }

  /**
   * Get annotations for a file
   * GET /annotations?path=/path/to/file&originId=optional
   */
  private async handleGetAnnotations(url: URL, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation persistence not initialized' }));
      return;
    }

    const filePath = url.searchParams.get('path');
    const originId = url.searchParams.get('originId') || 'local';

    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    const annotations = this.annotationPersistence.getByFile(filePath, originId);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ annotations }));
  }

  /**
   * Create a new annotation
   * POST /annotations
   */
  private async handleCreateAnnotation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation persistence not initialized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: Omit<Annotation, 'id' | 'createdAt'>;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!data.filePath || !data.comment) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields' }));
      return;
    }

    try {
      const annotation = this.annotationPersistence.add(data);

      res.writeHead(201, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ annotation }));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * Update an annotation
   * PUT /annotations/:id
   */
  private async handleUpdateAnnotation(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation persistence not initialized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let updates: Partial<Annotation>;
    try {
      updates = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const annotation = this.annotationPersistence.update(id, updates);
    if (!annotation) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation not found' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ annotation }));
  }

  /**
   * Delete an annotation
   * DELETE /annotations/:id
   */
  private async handleDeleteAnnotation(id: string, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation persistence not initialized' }));
      return;
    }

    const annotation = this.annotationPersistence.delete(id);
    if (!annotation) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Annotation not found' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ success: true }));
  }

  // Callback for creating new workers
  private onCreateNewWorker: ((cityPath: string, originId: string) => Promise<string>) | null = null;

  // Callback for focusing a session in Kitty
  private onFocusSession: ((sessionId: string) => void) | null = null;

  /**
   * Set callback for creating new workers
   * Returns the tmux session name of the created worker
   */
  setOnCreateNewWorker(fn: (cityPath: string, originId: string) => Promise<string>): void {
    this.onCreateNewWorker = fn;
  }

  /**
   * Set callback for focusing a session in Kitty
   */
  setOnFocusSession(fn: (sessionId: string) => void): void {
    this.onFocusSession = fn;
  }

  /**
   * Send annotations to a worker via tmux send-keys
   * POST /send-annotations
   * Supports either workerId (existing worker) or createNewWorker (new worker)
   */
  private async handleSendAnnotations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sessionLookup) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session lookup not initialized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: {
      workerId?: string;
      createNewWorker?: boolean;
      filePath: string;
      originId: string;
      annotations: Annotation[];
      globalComment?: string;
    };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { workerId, createNewWorker, filePath, originId, annotations, globalComment } = data;

    const hasContent = (annotations && annotations.length > 0) || (globalComment && globalComment.trim().length > 0);
    if (!hasContent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No content to send' }));
      return;
    }

    if (!workerId && !createNewWorker) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Must specify workerId or createNewWorker' }));
      return;
    }

    let tmuxSession: string;
    let isRemote = originId !== 'local' && !!originId;
    let sshHost: string | undefined;

    if (createNewWorker) {
      // Create a new worker
      if (!this.onCreateNewWorker) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'New worker creation not configured' }));
        return;
      }

      try {
        // Get city path from file path (directory containing the file)
        const cityPath = filePath.substring(0, filePath.lastIndexOf('/'));
        tmuxSession = await this.onCreateNewWorker(cityPath, originId);
        console.log(`[SendAnnotations] Created new worker: ${tmuxSession}`);

        // Wait for Claude to start up (4s for remote systems)
        await new Promise(resolve => setTimeout(resolve, 4000));
      } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create worker: ' + error.message }));
        return;
      }

      // Get SSH host for remote origins
      if (isRemote) {
        const origin = this.originLookup.getOrigin(originId);
        sshHost = origin?.sshHost;
      }
    } else {
      // Use existing worker
      const session = this.sessionLookup.findSession(workerId!);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Worker not found' }));
        return;
      }
      tmuxSession = session.tmuxSession;

      // Get SSH host for remote origins
      if (isRemote) {
        const origin = this.originLookup.getOrigin(originId);
        sshHost = origin?.sshHost;
      }
    }

    // Format annotations as markdown
    const formattedMessage = this.formatAnnotationsForClaude(filePath, annotations, globalComment);

    try {
      const escapedSession = tmuxSession.replace(/'/g, "'\\''");

      if (!isRemote) {
        // Local: use tmux load-buffer via stdin to avoid escaping issues
        // Don't send Enter - let user add more feedback from other files first
        execSync(`tmux load-buffer -`, { input: formattedMessage, timeout: 5000 });
        execSync(`tmux paste-buffer -t '${escapedSession}'`, { timeout: 5000 });
      } else {
        // Remote: send via SSH with tmux load-buffer
        // Don't send Enter - let user add more feedback from other files first
        if (!sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found' }));
          return;
        }

        execSync(`ssh ${sshHost} "tmux load-buffer -"`, { input: formattedMessage, timeout: 10000 });
        execSync(`ssh ${sshHost} "tmux paste-buffer -t '${escapedSession}'"`, { timeout: 10000 });
      }

      // Focus the worker in Kitty (for existing workers only; new workers are already focused)
      if (workerId && this.onFocusSession) {
        this.onFocusSession(workerId);
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true }));
    } catch (error: any) {
      console.error('Failed to send annotations:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to send annotations: ' + error.message }));
    }
  }

  /**
   * POST /send-message
   * Send a chat message to a worker's tmux session
   */
  private async handleSendMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sessionLookup) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session lookup not initialized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: { sessionId: string; message: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { sessionId, message } = data;

    if (!sessionId || !message?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }

    const session = this.sessionLookup.findSession(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const tmuxSession = session.tmuxSession;
    const isRemote = session.originId !== 'local';
    let sshHost: string | undefined;

    if (isRemote) {
      const origin = this.originLookup.getOrigin(session.originId);
      sshHost = origin?.sshHost;
      if (!sshHost) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not found for remote session' }));
        return;
      }
    }

    try {
      const escapedSession = tmuxSession.replace(/'/g, "'\\''");

      if (!isRemote) {
        // Local: load message to buffer, paste, then send Enter to execute
        execSync(`tmux load-buffer -`, { input: message, timeout: 5000 });
        execSync(`tmux paste-buffer -t '${escapedSession}'`, { timeout: 5000 });
        execSync(`tmux send-keys -t '${escapedSession}' Enter`, { timeout: 5000 });
      } else {
        // Remote: same via SSH
        execSync(`ssh ${sshHost} "tmux load-buffer -"`, { input: message, timeout: 10000 });
        execSync(`ssh ${sshHost} "tmux paste-buffer -t '${escapedSession}'"`, { timeout: 10000 });
        execSync(`ssh ${sshHost} "tmux send-keys -t '${escapedSession}' Enter"`, { timeout: 10000 });
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true }));
    } catch (error: any) {
      console.error('Failed to send message:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to send message: ' + error.message }));
    }
  }

  /**
   * Format annotations as markdown for Claude
   * Includes full file path and optional global comment
   */
  private formatAnnotationsForClaude(filePath: string, annotations: Annotation[], globalComment?: string): string {
    const lines = [
      '',  // Start with newline for clean separation
      `# Feedback on ${filePath}`,
      '',
    ];

    if (globalComment) {
      lines.push(globalComment);
      lines.push('');
    }

    if (annotations && annotations.length > 0) {
      lines.push(`I've reviewed this file and have ${annotations.length} piece${annotations.length === 1 ? '' : 's'} of feedback:`);
      lines.push('');

      annotations.forEach((ann, i) => {
        if (ann.isImageAnnotation) {
          // Image annotation - show position
          const posRef = ann.x !== undefined && ann.y !== undefined
            ? ` at position (${ann.x.toFixed(0)}%, ${ann.y.toFixed(0)}%)`
            : '';
          lines.push(`## ${i + 1}. Image annotation${posRef}`);
          lines.push(`> ${ann.comment}`);
          lines.push('');
        } else {
          // Text annotation - show selected text with start...end format for multiline
          let contextText: string;
          const text = ann.originalText;
          const isMultiline = text.includes('\n');

          if (isMultiline) {
            // For multiline: show "start text...end text"
            const lines_arr = text.split('\n');
            const startText = lines_arr[0].slice(0, 30).trim();
            const endText = lines_arr[lines_arr.length - 1].slice(-30).trim();
            contextText = `${startText}...${endText}`;
          } else if (text.length > 60) {
            // Single line but long: truncate
            contextText = text.slice(0, 57) + '...';
          } else {
            contextText = text;
          }

          // Format line reference: show range if multiline
          let lineRef = '';
          if (ann.line) {
            if (ann.endLine && ann.endLine !== ann.line) {
              lineRef = ` (L${ann.line}-${ann.endLine})`;
            } else {
              lineRef = ` (L${ann.line})`;
            }
          }

          lines.push(`## ${i + 1}.${lineRef} Feedback on: "${contextText}"`);
          lines.push(`> ${ann.comment}`);
          lines.push('');
        }
      });
    }

    lines.push('---');
    return lines.join('\n');
  }

  // ============================================================================
  // File as Fiber Endpoint
  // ============================================================================

  /**
   * File annotations as a felt fiber
   * POST /file-as-fiber
   * Body: { filePath, originId, title, body, kind }
   */
  private async handleFileAsFiber(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let bodyStr = '';
    for await (const chunk of req) {
      bodyStr += chunk;
    }

    let data: {
      filePath: string;
      originId: string;
      cityPath?: string;
      title: string;
      body: string;
      kind?: string;
    };
    try {
      data = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { filePath, originId, title, body, kind = 'task' } = data;

    if (!filePath || !title || !body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields' }));
      return;
    }

    // Use provided cityPath, or fall back to file's parent directory
    const cityPath = data.cityPath || filePath.substring(0, filePath.lastIndexOf('/'));
    const isRemote = originId !== 'local' && !!originId;

    try {
      let fiberId: string;

      // Escape body for shell - use a temp file approach to avoid shell escaping issues
      const escapedTitle = title.replace(/'/g, "'\\''");
      const escapedBody = body.replace(/'/g, "'\\''");

      if (!isRemote) {
        // Local: run felt add directly
        // felt add returns just the fiber ID on stdout
        const { stdout } = await execAsync(
          `cd '${cityPath}' && felt add '${escapedTitle}' -k ${kind} -b '${escapedBody}'`,
          { timeout: 10000, maxBuffer: 1024 * 1024 }
        );
        fiberId = stdout.trim();
      } else {
        // Remote: run via SSH
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        // For remote, need to escape for both local and remote shells
        const { stdout } = await execAsync(
          `ssh ${origin.sshHost} "cd '${cityPath}' && felt add '${escapedTitle}' -k ${kind} -b '${escapedBody}'"`,
          { timeout: 30000, maxBuffer: 1024 * 1024 }
        );
        fiberId = stdout.trim();
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true, fiberId }));
    } catch (error: any) {
      console.error('Failed to file as fiber:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to file as fiber: ' + error.message }));
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
        const { stdout } = await execAsync(
          `ssh ${sshHost} 'ls "${playgroundsDir}"/*.html 2>/dev/null || true'`,
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
        const { readFileSync } = await import('fs');
        html = readFileSync(playgroundPath, 'utf-8');
      } else {
        const sshHost = this.getSshHost(city);
        const { stdout } = await execAsync(
          `ssh ${sshHost} 'cat "${playgroundPath}"'`,
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

  /**
   * Get conversation history for a session
   * Query params: sessionId (tmux session name)
   */
  private async handleConversation(url: URL, res: ServerResponse): Promise<void> {
    const sessionId = url.searchParams.get('sessionId');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId parameter' }));
      return;
    }

    if (!this.transcriptReader) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transcript reader not configured' }));
      return;
    }

    // Find session to get its cwd
    const session = this.sessionLookup?.findSession(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    try {
      let messages: any[];

      // Check if this is a remote session (has originId that isn't 'local')
      if (session.originId && session.originId !== 'local') {
        // Remote session: check cached conversation from agent
        const cached = this.remoteConversationLookup?.(sessionId);
        messages = cached ? cached.slice(-limit) : [];
      } else {
        // Local session: prefer ConversationCache (hook-based), fall back to TranscriptReader
        if (this.conversationCache) {
          messages = this.conversationCache.getMessages(sessionId, limit);
          // If no messages in cache, try by tmux session name
          if (messages.length === 0 && session.tmuxSession) {
            messages = this.conversationCache.getMessagesByTmux(session.tmuxSession, limit);
          }
        } else {
          messages = [];
        }

        // Fall back to transcript reader if cache is empty
        if (messages.length === 0 && this.transcriptReader) {
          const currentMapping = this.transcriptReader.getSessionTranscript(sessionId);

          // Try lsof detection when Claude is actively running in this tmux session
          if (session.tmuxSession) {
            const detected = await this.transcriptReader.detectTranscriptFromTmux(session.tmuxSession, session.cwd);
            if (detected && detected !== currentMapping) {
              this.transcriptReader.setSessionTranscript(sessionId, detected);
            }
          }

          messages = await this.transcriptReader.getRecentMessages(session.cwd, limit, sessionId);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ messages }));
    } catch (error: any) {
      console.error('Failed to fetch conversation:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch conversation' }));
    }
  }

  private async handleDebugTranscripts(res: ServerResponse): Promise<void> {
    const mappings = this.transcriptReader?.getAllSessionMappings() || new Map();
    const sessions = this.sessionLookup?.getAllSessions() || [];

    const debug = {
      mappings: Object.fromEntries(
        [...mappings.entries()].map(([id, path]) => [id, path.split('/').pop()])
      ),
      sessions: sessions.map(s => ({
        id: s.id,
        name: s.name,
        tmuxSession: s.tmuxSession,
        cwd: s.cwd,
        status: s.status,
        mappedTranscript: mappings.get(s.id)?.split('/').pop() || null
      }))
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(debug, null, 2));
  }

  // ============================================================================
  // Hook Endpoints for Conversation Capture
  // ============================================================================

  /**
   * POST /hook/message
   * Receive conversation messages from Claude Code hooks
   * Body: { sessionId, tmuxSession, cwd, messages: [{ type, content, timestamp }] }
   */
  private async handleHookMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.conversationCache) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Conversation cache not configured' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data: {
      sessionId: string;
      tmuxSession: string;
      cwd: string;
      messages: CachedMessage[];
    };

    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { sessionId, tmuxSession, cwd, messages } = data;

    if (!sessionId || !tmuxSession || !messages || !Array.isArray(messages)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: sessionId, tmuxSession, messages' }));
      return;
    }

    try {
      this.conversationCache.addMessages(sessionId, tmuxSession, cwd || '', messages);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ success: true, count: messages.length }));
    } catch (error: any) {
      console.error('[Hook] Failed to add messages:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to add messages' }));
    }
  }

  /**
   * GET /hook/health
   * Debug endpoint showing last event time per session
   */
  private async handleHookHealth(res: ServerResponse): Promise<void> {
    if (!this.conversationCache) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Conversation cache not configured' }));
      return;
    }

    const health = this.conversationCache.getHealthInfo();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(health, null, 2));
  }
}
