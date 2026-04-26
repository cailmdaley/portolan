import { execFile, spawn } from 'child_process';
import { createReadStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { extname } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Origin } from './OriginManager.js';
import { shellEscape } from './ShellPathUtils.js';
import { markdownToMdast, extractFrontmatter } from './MarkdownToMdast.js';

const execFileAsync = promisify(execFile);

export const HTTP_API_MIME_TYPES: Record<string, string> = {
  'html': 'text/html',
  'txt': 'text/plain',
  'json': 'application/json',
  'xml': 'application/xml',
  'map': 'application/json',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'svg': 'image/svg+xml',
  'webp': 'image/webp',
  'ico': 'image/x-icon',
  'pdf': 'application/pdf',
  'mp4': 'video/mp4',
  'otf': 'font/otf',
  'ttf': 'font/ttf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'css': 'text/css',
  'js': 'application/javascript',
  'mjs': 'application/javascript',
};

const PORTOLAN_HTML_BRIDGE = `
<script>
(() => {
  const frameId = new URLSearchParams(window.location.search).get('_portolan_frame');
  if (!frameId || window.parent === window) return;

  const postLocation = () => {
    window.parent.postMessage({
      type: 'portolan-html-location',
      frameId,
      href: window.location.href,
    }, '*');
  };

  window.addEventListener('hashchange', postLocation);
  window.addEventListener('popstate', postLocation);
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'portolan-html-location-request' && event.data.frameId === frameId) {
      postLocation();
    }
  });

  const wrapHistoryMethod = (method) => {
    const original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function(...args) {
      const result = original.apply(this, args);
      postLocation();
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');

  // Reveal.js slide tracking
  const getSlideTitle = () => {
    const slide = Reveal.getCurrentSlide();
    if (!slide) return '';
    const heading = slide.querySelector('h1, h2, h3, h4, h5, h6');
    return heading ? heading.textContent.trim() : '';
  };

  const postSlide = (indexh, indexv, total) => {
    window.parent.postMessage({
      type: 'portolan-reveal-slide',
      frameId,
      slide: indexv > 0 ? indexh + '.' + indexv : indexh,
      slideIndex: indexh,
      slideIndexV: indexv,
      totalSlides: total,
      slideTitle: getSlideTitle(),
    }, '*');
  };

  const hookReveal = () => {
    if (typeof Reveal === 'undefined' || !Reveal.isReady || !Reveal.isReady()) return false;
    Reveal.on('slidechanged', (event) => {
      postSlide(event.indexh, event.indexv, Reveal.getTotalSlides());
      postLocation();
    });
    const indices = Reveal.getIndices();
    postSlide(indices.h, indices.v, Reveal.getTotalSlides());
    return true;
  };

  // Also respond to slide-request from parent (for goto)
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'portolan-reveal-goto' && event.data.frameId === frameId) {
      if (typeof Reveal !== 'undefined' && Reveal.isReady && Reveal.isReady()) {
        Reveal.slide(event.data.slideIndex, event.data.slideIndexV || 0);
      }
    }
  });

  if (document.readyState === 'complete') {
    postLocation();
    if (!hookReveal()) {
      // Reveal may init after DOMContentLoaded; poll briefly
      let attempts = 0;
      const poll = setInterval(() => {
        if (hookReveal() || ++attempts > 20) clearInterval(poll);
      }, 250);
    }
  } else {
    window.addEventListener('load', () => {
      postLocation();
      if (!hookReveal()) {
        let attempts = 0;
        const poll = setInterval(() => {
          if (hookReveal() || ++attempts > 20) clearInterval(poll);
        }, 250);
      }
    }, { once: true });
  }
})();
</script>`;

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf',
]);

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface HttpApiFileContentDeps {
  originLookup: OriginLookup;
  parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export class HttpApiFileContent {
  private originLookup: OriginLookup;
  private parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
  private sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  private sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;

  constructor(deps: HttpApiFileContentDeps) {
    this.originLookup = deps.originLookup;
    this.parseJsonBody = deps.parseJsonBody;
    this.sendJsonError = deps.sendJsonError;
    this.sendJsonSuccess = deps.sendJsonSuccess;
  }

  async handleFileContent(url: URL, res: ServerResponse): Promise<void> {
    const filePath = url.searchParams.get('path');
    const originId = url.searchParams.get('originId');
    const binary = url.searchParams.get('binary') === 'true';
    const raw = url.searchParams.get('raw') === 'true';

    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    if (filePath.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    const ext = extname(filePath).toLowerCase().slice(1);

    if (raw && this.isBinaryExtension(ext)) {
      await this.handleRawBinaryContent(filePath, originId, ext, res);
      return;
    }

    if (binary && this.isBinaryExtension(ext)) {
      await this.handleBinaryContent(filePath, originId, ext, res);
      return;
    }

    try {
      let content: string;

      if (!originId || originId === 'local') {
        content = await readFile(filePath, 'utf-8');
      } else {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not found or not connected' }));
          return;
        }

        const { stdout } = await execFileAsync(
          'ssh', [origin.sshHost, `cat ${shellEscape(filePath)}`],
          { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
        );
        content = stdout;
      }

      const language = this.extToLanguage(ext);
      // Parse markdown bodies on the wire so the vellum reader can render via
      // myst-to-react without pulling a remark stack into the browser bundle.
      // Quiet failures fall back to source view (vellum handles missing mdast).
      let mdast: unknown = undefined;
      let frontmatter: Record<string, unknown> | undefined = undefined;
      if ((ext === 'md' || ext === 'markdown') && content.trim()) {
        try {
          mdast = markdownToMdast(content);
        } catch (parseErr: any) {
          console.warn('markdownToMdast failed for', filePath, parseErr?.message ?? parseErr);
        }
        // Frontmatter parsed separately and returned at the top level so the
        // client can render a fiber-shaped header (FiberHeader) above the
        // canvas without re-parsing yaml in the browser. Failures are quiet —
        // a malformed yaml block surfaces as missing frontmatter, not a
        // file-fetch error.
        try {
          frontmatter = extractFrontmatter(content);
        } catch (fmErr: any) {
          console.warn('extractFrontmatter failed for', filePath, fmErr?.message ?? fmErr);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ content, language, path: filePath, mdast, frontmatter }));
    } catch (error: any) {
      console.error('Failed to fetch file content:', error.message);
      const statusCode = error.code === 'ENOENT' ? 404 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'File not found' : 'Failed to read file' }));
    }
  }

  async handleProjectFile(url: URL, res: ServerResponse): Promise<void> {
    // Route: /project-file/{originId}/absolute/path/to/file
    // Origin is encoded in the path so relative URLs in HTML preserve it.
    const prefix = '/project-file/';
    const rest = url.pathname.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) {
      this.sendProjectFileError(res, 400, 'Missing file path');
      return;
    }
    const originId = decodeURIComponent(rest.slice(0, slashIdx));
    const filePath = decodeURIComponent(rest.slice(slashIdx));

    if (!filePath.startsWith('/') || filePath.includes('..')) {
      this.sendProjectFileError(res, 400, 'Invalid path');
      return;
    }

    const ext = extname(filePath).toLowerCase().slice(1);
    const mimeType = HTTP_API_MIME_TYPES[ext] || 'application/octet-stream';

    try {
      if (ext === 'html') {
        await this.handleProjectHtmlFile(filePath, originId, mimeType, res);
        return;
      }

      if (originId && originId !== 'local') {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          this.sendProjectFileError(res, 400, 'Unknown origin');
          return;
        }
        await this.streamRemoteBinaryFile(origin.sshHost, filePath, mimeType, 'no-cache', 30_000, res);
      } else {
        await this.streamLocalBinaryFile(filePath, mimeType, 'no-cache', res);
      }
    } catch (error: any) {
      if (res.headersSent || res.writableEnded) return;
      const statusCode = typeof error.statusCode === 'number'
        ? error.statusCode
        : (error.code === 'ENOENT' ? 404 : 500);
      this.sendProjectFileError(
        res,
        statusCode,
        statusCode === 404 ? 'File not found' : 'Failed to read file',
      );
    }
  }

  private async handleProjectHtmlFile(
    filePath: string,
    originId: string,
    mimeType: string,
    res: ServerResponse,
  ): Promise<void> {
    const content = await this.readTextFile(filePath, originId || null);
    const bridgedContent = this.injectHtmlBridge(content);
    res.writeHead(200, this.streamHeaders(mimeType, 'no-cache'));
    res.end(bridgedContent);
  }

  async handleSaveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await this.parseJsonBody<{ path?: string; content?: string; originId?: string }>(req, res);
    if (!data) return;

    const { path: filePath, content, originId } = data;

    if (!filePath || content === undefined) {
      this.sendJsonError(res, 400, 'Missing path or content');
      return;
    }

    if (filePath.includes('..')) {
      this.sendJsonError(res, 400, 'Invalid path');
      return;
    }

    try {
      if (!originId || originId === 'local') {
        await writeFile(filePath, content, 'utf-8');
      } else {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          this.sendJsonError(res, 404, 'Origin not found or not connected');
          return;
        }

        await this.writeRemoteFile(origin.sshHost, filePath, content);
      }

      this.sendJsonSuccess(res, { success: true, path: filePath });
    } catch (error: any) {
      console.error('Failed to save file:', error.message);
      this.sendJsonError(res, 500, 'Failed to save file: ' + error.message);
    }
  }

  private isBinaryExtension(ext: string): boolean {
    return BINARY_EXTENSIONS.has(ext);
  }

  private async readBinaryFileBuffer(
    filePath: string,
    originId: string | null,
    maxBuffer: number,
    timeout: number
  ): Promise<Buffer> {
    if (!originId || originId === 'local') {
      return readFile(filePath);
    }

    const origin = this.originLookup.getOrigin(originId);
    if (!origin?.sshHost) {
      const error = new Error('Origin not found or not connected') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    const result = await execFileAsync(
      'ssh', [origin.sshHost, `cat ${shellEscape(filePath)}`],
      { maxBuffer, timeout, encoding: 'buffer' as BufferEncoding },
    );
    return Buffer.from(result.stdout as unknown as Buffer);
  }

  private async readTextFile(filePath: string, originId: string | null): Promise<string> {
    if (!originId || originId === 'local') {
      return readFile(filePath, 'utf-8');
    }

    const origin = this.originLookup.getOrigin(originId);
    if (!origin?.sshHost) {
      const error = new Error('Origin not found or not connected') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    const { stdout } = await execFileAsync(
      'ssh', [origin.sshHost, `cat ${shellEscape(filePath)}`],
      { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    );
    return stdout;
  }

  private injectHtmlBridge(content: string): string {
    if (content.includes('portolan-html-location')) {
      return content;
    }

    if (/<\/head>/i.test(content)) {
      return content.replace(/<\/head>/i, `${PORTOLAN_HTML_BRIDGE}\n</head>`);
    }

    if (/<\/body>/i.test(content)) {
      return content.replace(/<\/body>/i, `${PORTOLAN_HTML_BRIDGE}\n</body>`);
    }

    return `${content}\n${PORTOLAN_HTML_BRIDGE}`;
  }

  private streamHeaders(mimeType: string, cacheControl: string): Record<string, string> {
    return {
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheControl,
    };
  }

  private makeHttpError(message: string, statusCode: number): Error & { statusCode: number } {
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = statusCode;
    return error;
  }

  streamLocalBinaryFile(
    filePath: string,
    mimeType: string,
    cacheControl: string,
    res: ServerResponse
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath);
      let headersWritten = false;
      let settled = false;

      const cleanup = () => {
        fileStream.removeListener('open', onOpen);
        fileStream.removeListener('error', onError);
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onOpen = () => {
        if (res.destroyed || res.writableEnded) {
          fileStream.destroy();
          resolveOnce();
          return;
        }
        headersWritten = true;
        res.writeHead(200, this.streamHeaders(mimeType, cacheControl));
        fileStream.pipe(res);
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (headersWritten || res.headersSent) {
          res.destroy(error);
          resolveOnce();
          return;
        }

        if (error.code === 'ENOENT') {
          rejectOnce(this.makeHttpError('File not found', 404));
          return;
        }
        rejectOnce(error);
      };

      const onFinish = () => {
        resolveOnce();
      };

      const onClose = () => {
        if (!res.writableEnded) {
          fileStream.destroy();
        }
        resolveOnce();
      };

      fileStream.once('open', onOpen);
      fileStream.once('error', onError);
      res.once('finish', onFinish);
      res.once('close', onClose);
    });
  }

  private sendProjectFileError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(message);
  }

  streamRemoteBinaryFile(
    sshHost: string,
    filePath: string,
    mimeType: string,
    cacheControl: string,
    timeout: number,
    res: ServerResponse
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', [sshHost, `cat ${shellEscape(filePath)}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (!ssh.stdout || !ssh.stderr) {
        reject(this.makeHttpError('Failed to create SSH streams', 500));
        return;
      }

      let headersWritten = false;
      let settled = false;
      let timedOut = false;
      let stderr = '';
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        ssh.kill('SIGKILL');
      }, timeout);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        ssh.stdout?.removeListener('data', onStdoutData);
        ssh.stderr?.removeListener('data', onStderrData);
        ssh.removeListener('error', onError);
        ssh.removeListener('close', onClose);
        res.removeListener('drain', onDrain);
        res.removeListener('close', onResClose);
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onStdoutData = (chunk: Buffer) => {
        if (settled) return;
        if (!headersWritten) {
          headersWritten = true;
          res.writeHead(200, this.streamHeaders(mimeType, cacheControl));
        }
        if (!res.write(chunk)) {
          ssh.stdout?.pause();
        }
      };

      const onStderrData = (chunk: Buffer) => {
        if (stderr.length >= 4096) return;
        const remaining = 4096 - stderr.length;
        stderr += chunk.toString('utf-8', 0, remaining);
      };

      const onDrain = () => {
        ssh.stdout?.resume();
      };

      const onError = (error: Error) => {
        if (headersWritten || res.headersSent) {
          res.destroy(error);
          resolveOnce();
          return;
        }
        rejectOnce(error);
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (code === 0) {
          if (!headersWritten) {
            headersWritten = true;
            res.writeHead(200, this.streamHeaders(mimeType, cacheControl));
          }
          if (!res.writableEnded) {
            res.end();
          }
          resolveOnce();
          return;
        }

        const message = timedOut
          ? 'Remote file read timed out'
          : (stderr.trim() || (signal ? `SSH terminated by ${signal}` : `SSH exited with code ${code ?? 'unknown'}`));

        if (!headersWritten && !res.headersSent && !res.writableEnded) {
          const notFound = /no such file|cannot stat|not found/i.test(message);
          const statusCode = timedOut ? 504 : (notFound ? 404 : 500);
          rejectOnce(this.makeHttpError(notFound ? 'File not found' : message, statusCode));
          return;
        }

        res.destroy(new Error(message));
        resolveOnce();
      };

      const onResClose = () => {
        if (!res.writableEnded) {
          ssh.kill('SIGTERM');
        }
        resolveOnce();
      };

      ssh.stdout.on('data', onStdoutData);
      ssh.stderr.on('data', onStderrData);
      ssh.on('error', onError);
      ssh.on('close', onClose);
      res.on('drain', onDrain);
      res.once('close', onResClose);
    });
  }

  private async handleBinaryContent(
    filePath: string,
    originId: string | null,
    ext: string,
    res: ServerResponse
  ): Promise<void> {
    const mimeType = HTTP_API_MIME_TYPES[ext] || 'application/octet-stream';
    const fileType = ext === 'pdf' ? 'pdf' : 'image';
    const maxBuffer = ext === 'pdf' ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    const timeout = ext === 'pdf' ? 60000 : 30000;

    try {
      const data = await this.readBinaryFileBuffer(filePath, originId, maxBuffer, timeout);
      const dataUrl = `data:${mimeType};base64,${data.toString('base64')}`;

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ type: fileType, url: dataUrl, path: filePath }));
    } catch (error: any) {
      console.error(`Failed to fetch ${fileType} content:`, error.message);
      const statusCode = typeof error.statusCode === 'number'
        ? error.statusCode
        : (error.code === 'ENOENT' ? 404 : 500);
      const notFoundMessage = error.message === 'Origin not found or not connected'
        ? error.message
        : `${fileType} not found`;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: statusCode === 404 ? notFoundMessage : `Failed to read ${fileType}`
      }));
    }
  }

  private async handleRawBinaryContent(
    filePath: string,
    originId: string | null,
    ext: string,
    res: ServerResponse
  ): Promise<void> {
    const mimeType = HTTP_API_MIME_TYPES[ext] || 'application/octet-stream';
    const timeout = ext === 'pdf' ? 60000 : 30000;

    try {
      if (!originId || originId === 'local') {
        await this.streamLocalBinaryFile(filePath, mimeType, 'public, max-age=3600', res);
        return;
      }

      const origin = this.originLookup.getOrigin(originId);
      if (!origin?.sshHost) {
        throw this.makeHttpError('Origin not found or not connected', 404);
      }
      await this.streamRemoteBinaryFile(origin.sshHost, filePath, mimeType, 'public, max-age=3600', timeout, res);
    } catch (error: any) {
      if (res.headersSent || res.writableEnded) {
        return;
      }

      console.error('Failed to serve raw binary:', error.message, error.stderr || '');
      const statusCode = typeof error.statusCode === 'number'
        ? error.statusCode
        : (error.code === 'ENOENT' ? 404 : 500);
      res.writeHead(statusCode, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      });
      if (statusCode === 404 && error.message === 'Origin not found or not connected') {
        res.end(error.message);
      } else {
        res.end(error.message || 'Not found');
      }
    }
  }

  private writeRemoteFile(sshHost: string, filePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', [sshHost, `cat > ${shellEscape(filePath)}`], {
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
      ssh.stdin.write(content);
      ssh.stdin.end();
    });
  }

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
}
