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

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface CityLookup {
  getCityById(cityId: string): City | null;
}

export interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

export interface PersistenceLookup {
  getCityById(cityId: string): { sshHost?: string } | null;
}

export interface SessionLookup {
  getSessionById(sessionId: string): Session | undefined;
}

// ============================================================================
// HttpApi
// ============================================================================

export class HttpApi {
  private cityLookup: CityLookup;
  private originLookup: OriginLookup;
  private persistenceLookup: PersistenceLookup;
  private annotationPersistence: AnnotationPersistence | null = null;
  private sessionLookup: SessionLookup | null = null;

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

    // Handle image files
    if (binary && this.isImageExtension(ext)) {
      await this.handleImageContent(filePath, originId, ext, res);
      return;
    }

    // Handle PDF files
    if (binary && this.isPdfExtension(ext)) {
      await this.handlePdfContent(filePath, originId, res);
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
   * Check if extension is an image type
   */
  private isImageExtension(ext: string): boolean {
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext);
  }

  /**
   * Check if extension is a PDF
   */
  private isPdfExtension(ext: string): boolean {
    return ext === 'pdf';
  }

  /**
   * Handle image file content - returns base64 data URL
   */
  private async handleImageContent(
    filePath: string,
    originId: string | null,
    ext: string,
    res: ServerResponse
  ): Promise<void> {
    const mimeTypes: Record<string, string> = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'webp': 'image/webp',
      'ico': 'image/x-icon',
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    try {
      let data: Buffer;

      if (!originId || originId === 'local') {
        // Local file: read as buffer
        data = await readFile(filePath);
      } else {
        // Remote file: fetch via SSH with base64 encoding
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        const { stdout } = await execAsync(
          `ssh ${origin.sshHost} 'base64 "${filePath}"'`,
          { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
        );
        // Remote returns base64 string, convert to buffer
        data = Buffer.from(stdout.replace(/\s/g, ''), 'base64');
      }

      const base64 = data.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ type: 'image', url: dataUrl, path: filePath }));
    } catch (error: any) {
      console.error('Failed to fetch image content:', error.message);
      const statusCode = error.code === 'ENOENT' ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'Image not found' : 'Failed to read image' }));
    }
  }

  /**
   * Handle PDF file content - returns base64 data URL
   */
  private async handlePdfContent(
    filePath: string,
    originId: string | null,
    res: ServerResponse
  ): Promise<void> {
    try {
      let data: Buffer;

      if (!originId || originId === 'local') {
        // Local file: read as buffer
        data = await readFile(filePath);
      } else {
        // Remote file: fetch via SSH with base64 encoding
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        const { stdout } = await execAsync(
          `ssh ${origin.sshHost} 'base64 "${filePath}"'`,
          { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }  // Larger buffer for PDFs
        );
        // Remote returns base64 string, convert to buffer
        data = Buffer.from(stdout.replace(/\s/g, ''), 'base64');
      }

      const base64 = data.toString('base64');
      const dataUrl = `data:application/pdf;base64,${base64}`;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ type: 'pdf', url: dataUrl, path: filePath }));
    } catch (error: any) {
      console.error('Failed to fetch PDF content:', error.message);
      const statusCode = error.code === 'ENOENT' ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'PDF not found' : 'Failed to read PDF' }));
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
        `ssh -T ${sshHost} 'tmux has-session -t hexarchy-agent 2>/dev/null && echo running || echo stopped'`,
        { timeout: 10000 }
      );

      if (checkOutput.trim() === 'running') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ status: 'already_running', message: 'Agent already running on ' + sshHost }));
        return;
      }

      // Start the agent via SSH
      // Use -T to disable TTY allocation, bash -l to get login shell with nvm/node in PATH
      console.log(`[Activate] Starting hexarchy-agent on ${sshHost}...`);
      await execAsync(
        `ssh -T ${sshHost} 'tmux new-session -d -s hexarchy-agent "bash -l -c \\"node ~/bin/hexarchy-agent.js connect --ssh-host=${sshHost}\\""'`,
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

    if (!annotations || annotations.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No annotations to send' }));
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

        // Wait a moment for Claude to start up
        await new Promise(resolve => setTimeout(resolve, 2000));
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
      const session = this.sessionLookup.getSessionById(workerId!);
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
      // Escape for tmux send-keys
      const escapedMessage = formattedMessage.replace(/'/g, "'\\''");
      const escapedSession = tmuxSession.replace(/'/g, "'\\''");

      if (!isRemote) {
        // Local: send directly via tmux
        execSync(`tmux send-keys -t '${escapedSession}' '${escapedMessage}' Enter`, {
          timeout: 5000,
        });
      } else {
        // Remote: send via SSH
        if (!sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found' }));
          return;
        }

        execSync(
          `ssh ${sshHost} "tmux send-keys -t '${escapedSession}' '${escapedMessage}' Enter"`,
          { timeout: 10000 }
        );
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
   * Format annotations as markdown for Claude
   * Includes full file path and optional global comment
   */
  private formatAnnotationsForClaude(filePath: string, annotations: Annotation[], globalComment?: string): string {
    const lines = [
      `# Feedback on ${filePath}`,
      '',
    ];

    if (globalComment) {
      lines.push(globalComment);
      lines.push('');
    }

    lines.push(`I've reviewed this file and have ${annotations.length} piece${annotations.length === 1 ? '' : 's'} of feedback:`);
    lines.push('');

    annotations.forEach((ann, i) => {
      // Truncate long selections with indicator
      const truncatedText = ann.originalText.length > 60
        ? ann.originalText.slice(0, 57) + '...'
        : ann.originalText;
      // Format header with optional line number
      const lineRef = ann.line ? ` (L${ann.line})` : '';
      lines.push(`## ${i + 1}.${lineRef} Feedback on: "${truncatedText.replace(/\n/g, ' ')}"`);
      lines.push(`> ${ann.comment}`);
      lines.push('');
    });

    lines.push('---');
    return lines.join('\n');
  }
}
