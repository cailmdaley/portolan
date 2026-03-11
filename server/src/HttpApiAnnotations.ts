import { exec, execFile, execFileSync, execSync } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { promisify } from 'util';
import type { Annotation, AnnotationPersistence } from './AnnotationPersistence.js';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { Session } from './SessionTracker.js';
import { shellEscape } from './ShellPathUtils.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface CityLookup {
  getCityById(cityId: string): City | null;
}

interface OriginLookup {
  getOrigin(originId: string): Origin | null | undefined;
}

interface SessionLookup {
  findSession(sessionId: string): Session | undefined;
}

type JsonBodyParser = <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
type JsonErrorSender = (res: ServerResponse, status: number, error: string) => void;
type JsonSuccessSender = (res: ServerResponse, data: Record<string, unknown>) => void;

interface HttpApiAnnotationsOptions {
  cityLookup: CityLookup;
  originLookup: OriginLookup;
  getSshHost: (city: City) => string;
  parseJsonBody: JsonBodyParser;
  sendJsonError: JsonErrorSender;
  sendJsonSuccess: JsonSuccessSender;
}

export class HttpApiAnnotations {
  private readonly cityLookup: CityLookup;
  private readonly originLookup: OriginLookup;
  private readonly getSshHost: (city: City) => string;
  private readonly parseJsonBody: JsonBodyParser;
  private readonly sendJsonError: JsonErrorSender;
  private readonly sendJsonSuccess: JsonSuccessSender;
  private annotationPersistence: AnnotationPersistence | null = null;
  private sessionLookup: SessionLookup | null = null;
  private onCreateNewWorker: ((cityPath: string, originId: string) => Promise<string>) | null = null;
  private onFocusSession: ((sessionId: string) => void) | null = null;

  constructor(options: HttpApiAnnotationsOptions) {
    this.cityLookup = options.cityLookup;
    this.originLookup = options.originLookup;
    this.getSshHost = options.getSshHost;
    this.parseJsonBody = options.parseJsonBody;
    this.sendJsonError = options.sendJsonError;
    this.sendJsonSuccess = options.sendJsonSuccess;
  }

  setAnnotationPersistence(persistence: AnnotationPersistence): void {
    this.annotationPersistence = persistence;
  }

  setSessionLookup(lookup: SessionLookup): void {
    this.sessionLookup = lookup;
  }

  setOnCreateNewWorker(fn: (cityPath: string, originId: string) => Promise<string>): void {
    this.onCreateNewWorker = fn;
  }

  setOnFocusSession(fn: (sessionId: string) => void): void {
    this.onFocusSession = fn;
  }

  async handleRecentAnnotations(url: URL, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      this.sendJsonError(res, 500, 'Annotation persistence not initialized');
      return;
    }

    const originId = url.searchParams.get('originId') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);

    const recentFiles = this.annotationPersistence.getRecentFiles(originId, limit);
    this.sendJsonSuccess(res, { files: recentFiles });
  }

  async handleGetAnnotations(url: URL, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      this.sendJsonError(res, 500, 'Annotation persistence not initialized');
      return;
    }

    const filePath = url.searchParams.get('path');
    const claimId = url.searchParams.get('claimId');
    const allClaims = url.searchParams.get('claims') === 'true';
    const originId = url.searchParams.get('originId') || 'local';

    if (!filePath && !claimId && !allClaims) {
      this.sendJsonError(res, 400, 'Missing path, claimId, or claims parameter');
      return;
    }

    let annotations: Annotation[];
    if (allClaims) {
      annotations = this.annotationPersistence.getAllClaims();
    } else if (claimId) {
      annotations = this.annotationPersistence.getByClaimId(claimId);
    } else {
      annotations = this.annotationPersistence.getByFile(filePath!, originId);
    }

    this.sendJsonSuccess(res, { annotations });
  }

  async handleCreateAnnotation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      this.sendJsonError(res, 500, 'Annotation persistence not initialized');
      return;
    }

    const data = await this.parseJsonBody<Omit<Annotation, 'id' | 'createdAt'>>(req, res);
    if (!data) return;

    if (data.isClaimAnnotation) {
      if (!data.claimId || !data.comment) {
        this.sendJsonError(res, 400, 'Missing required fields for claims annotation (claimId, comment)');
        return;
      }
      if (data.artifact && (data.x === undefined || data.y === undefined)) {
        this.sendJsonError(res, 400, 'Image annotation requires x and y coordinates');
        return;
      }
    } else if (!data.filePath || !data.comment) {
      this.sendJsonError(res, 400, 'Missing required fields');
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
      this.sendJsonError(res, 500, error.message);
    }
  }

  async handleUpdateAnnotation(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      this.sendJsonError(res, 500, 'Annotation persistence not initialized');
      return;
    }

    const updates = await this.parseJsonBody<Partial<Annotation>>(req, res);
    if (!updates) return;

    const annotation = this.annotationPersistence.update(id, updates);
    if (!annotation) {
      this.sendJsonError(res, 404, 'Annotation not found');
      return;
    }

    this.sendJsonSuccess(res, { annotation });
  }

  async handleDeleteAnnotation(id: string, res: ServerResponse): Promise<void> {
    if (!this.annotationPersistence) {
      this.sendJsonError(res, 500, 'Annotation persistence not initialized');
      return;
    }

    const annotation = this.annotationPersistence.delete(id);
    if (!annotation) {
      this.sendJsonError(res, 404, 'Annotation not found');
      return;
    }

    this.sendJsonSuccess(res, { success: true });
  }

  async handleSendAnnotations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sessionLookup) {
      this.sendJsonError(res, 500, 'Session lookup not initialized');
      return;
    }

    const data = await this.parseJsonBody<{
      workerId?: string;
      createNewWorker?: boolean;
      filePath: string;
      originId: string;
      annotations: Annotation[];
      globalComment?: string;
      cityName?: string;
      isClaimsSend?: boolean;
    }>(req, res);
    if (!data) return;

    const { workerId, createNewWorker, filePath, originId, annotations, globalComment, cityName, isClaimsSend } = data;

    const hasContent = (annotations && annotations.length > 0) || (globalComment && globalComment.trim().length > 0);
    if (!hasContent) {
      this.sendJsonError(res, 400, 'No content to send');
      return;
    }

    if (!workerId && !createNewWorker) {
      this.sendJsonError(res, 400, 'Must specify workerId or createNewWorker');
      return;
    }

    let tmuxSession: string;
    const isRemote = originId !== 'local' && !!originId;
    let sshHost: string | undefined;

    if (createNewWorker) {
      if (!this.onCreateNewWorker) {
        this.sendJsonError(res, 500, 'New worker creation not configured');
        return;
      }

      try {
        const cityPath = filePath.substring(0, filePath.lastIndexOf('/'));
        tmuxSession = await this.onCreateNewWorker(cityPath, originId);
        console.log(`[SendAnnotations] Created new worker: ${tmuxSession}`);
        await new Promise(resolve => setTimeout(resolve, 4000));
      } catch (error: any) {
        this.sendJsonError(res, 500, 'Failed to create worker: ' + error.message);
        return;
      }
    } else {
      const session = this.sessionLookup.findSession(workerId!);
      if (!session) {
        this.sendJsonError(res, 404, 'Worker not found');
        return;
      }
      tmuxSession = session.tmuxSession;
    }

    if (isRemote) {
      const origin = this.originLookup.getOrigin(originId);
      sshHost = origin?.sshHost;
    }

    const formattedMessage = isClaimsSend
      ? this.formatClaimsAnnotationsForClaude(cityName || 'unknown', annotations, globalComment)
      : this.formatAnnotationsForClaude(filePath, annotations, globalComment);

    try {
      const escaped = shellEscape(tmuxSession);

      if (!isRemote) {
        execSync(`tmux load-buffer -`, { input: formattedMessage, timeout: 5000 });
        execSync(`tmux paste-buffer -t ${escaped}`, { timeout: 5000 });
      } else {
        if (!sshHost) {
          this.sendJsonError(res, 404, 'Origin not found');
          return;
        }

        execFileSync('ssh', [sshHost, 'tmux load-buffer -'], { input: formattedMessage, timeout: 10000 });
        execFileSync('ssh', [sshHost, `tmux paste-buffer -t ${escaped}`], { timeout: 10000 });
      }

      if (workerId && this.onFocusSession) {
        this.onFocusSession(workerId);
      }

      this.sendJsonSuccess(res, { success: true });
    } catch (error: any) {
      console.error('Failed to send annotations:', error.message);
      this.sendJsonError(res, 500, 'Failed to send annotations: ' + error.message);
    }
  }

  async handleFileAsFiber(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await this.parseJsonBody<{
      filePath: string;
      originId: string;
      cityPath?: string;
      title: string;
      body: string;
      kind?: string;
    }>(req, res);
    if (!data) return;

    const { filePath, originId, title, body, kind = 'task' } = data;

    if (!filePath || !title || !body) {
      this.sendJsonError(res, 400, 'Missing required fields');
      return;
    }

    const cityPath = data.cityPath || filePath.substring(0, filePath.lastIndexOf('/'));
    const isRemote = originId !== 'local' && !!originId;

    try {
      let fiberId: string;
      const feltCmd = `cd ${shellEscape(cityPath)} && felt add ${shellEscape(title)} -t ${shellEscape(kind)} -b ${shellEscape(body)}`;

      if (!isRemote) {
        const { stdout } = await execAsync(feltCmd, { timeout: 10000, maxBuffer: 1024 * 1024 });
        fiberId = stdout.trim();
      } else {
        const origin = this.originLookup.getOrigin(originId);
        if (!origin?.sshHost) {
          this.sendJsonError(res, 404, 'Origin not found or not connected');
          return;
        }

        const { stdout } = await execFileAsync(
          'ssh', [origin.sshHost, feltCmd],
          { timeout: 30000, maxBuffer: 1024 * 1024 }
        );
        fiberId = stdout.trim();
      }

      this.sendJsonSuccess(res, { success: true, fiberId });
    } catch (error: any) {
      console.error('Failed to file as fiber:', error.message);
      this.sendJsonError(res, 500, 'Failed to file as fiber: ' + error.message);
    }
  }

  async handlePromoteToFelt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await this.parseJsonBody<{ claimId: string; comment: string; cityId: string }>(req, res);
    if (!data) return;

    const { claimId, comment, cityId } = data;
    if (!claimId || !comment || !cityId) {
      this.sendJsonError(res, 400, 'Missing required fields (claimId, comment, cityId)');
      return;
    }

    const city = this.cityLookup.getCityById(cityId);
    if (!city) {
      this.sendJsonError(res, 404, 'City not found');
      return;
    }

    const isRemote = city.originId !== 'local' && !!city.originId;
    const cityPath = city.path;

    try {
      const feltCmd = `cd ${shellEscape(cityPath)} && felt comment ${shellEscape(claimId)} ${shellEscape(comment)}`;
      if (!isRemote) {
        await execAsync(feltCmd, { timeout: 10000 });
      } else {
        const sshHost = this.getSshHost(city);
        await execFileAsync('ssh', [sshHost, feltCmd], { timeout: 30000 });
      }

      this.sendJsonSuccess(res, { success: true });
    } catch (error: any) {
      console.error('Failed to promote to felt:', error.message);
      this.sendJsonError(res, 500, 'Failed to promote to felt: ' + error.message);
    }
  }

  formatAnnotationsForClaude(filePath: string, annotations: Annotation[], globalComment?: string): string {
    const lines = [
      '',
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
          const posRef = ann.x !== undefined && ann.y !== undefined
            ? ` at position (${ann.x.toFixed(0)}%, ${ann.y.toFixed(0)}%)`
            : '';
          lines.push(`## ${i + 1}. Image annotation${posRef}`);
          lines.push(`> ${ann.comment}`);
          lines.push('');
        } else {
          let contextText: string;
          const text = ann.originalText || '';
          const isMultiline = text.includes('\n');

          if (isMultiline) {
            const selectedLines = text.split('\n');
            const startText = selectedLines[0].slice(0, 30).trim();
            const endText = selectedLines[selectedLines.length - 1].slice(-30).trim();
            contextText = `${startText}...${endText}`;
          } else if (text.length > 60) {
            contextText = text.slice(0, 57) + '...';
          } else {
            contextText = text;
          }

          let lineRef = '';
          if (ann.line) {
            lineRef = ann.endLine && ann.endLine !== ann.line
              ? ` (L${ann.line}-${ann.endLine})`
              : ` (L${ann.line})`;
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

  formatClaimsAnnotationsForClaude(cityName: string, annotations: Annotation[], globalComment?: string): string {
    const lines = [
      '',
      `# Claims review: ${cityName}`,
      '',
    ];

    if (globalComment) {
      lines.push(globalComment);
      lines.push('');
    }

    if (annotations && annotations.length > 0) {
      lines.push(`I've reviewed the claims dashboard and have ${annotations.length} piece${annotations.length === 1 ? '' : 's'} of feedback:`);
      lines.push('');

      const grouped = new Map<string, Annotation[]>();
      for (const ann of annotations) {
        const key = ann.claimId || 'unknown';
        const group = grouped.get(key);
        if (group) group.push(ann);
        else grouped.set(key, [ann]);
      }

      let claimNum = 0;
      for (const [, group] of grouped) {
        claimNum++;
        const title = group[0].claimTitle || group[0].claimId || 'Unknown claim';
        const filePath = group[0].filePath;
        const header = filePath ? filePath : `[${title}]`;
        lines.push(`## ${claimNum}. ${header}`);

        for (let i = 0; i < group.length; i++) {
          const ann = group[i];
          if (i > 0) lines.push('>');

          let lineRef = '';
          if (ann.line) {
            lineRef = ann.endLine && ann.endLine !== ann.line
              ? ` (L${ann.line}-${ann.endLine})`
              : ` (L${ann.line})`;
          }

          if (ann.artifact) {
            const posRef = ann.x !== undefined && ann.y !== undefined
              ? ` (at ${ann.x.toFixed(0)}%, ${ann.y.toFixed(0)}%)`
              : '';
            lines.push(`> On plot: ${ann.artifact}${posRef}`);
          } else if (ann.selectedText) {
            const truncated = ann.selectedText.length > 60
              ? ann.selectedText.slice(0, 60) + '…'
              : ann.selectedText;
            lines.push(`>${lineRef} On text: "${truncated}"`);
          }
          lines.push(`> ${ann.comment}`);
        }
        lines.push('');
      }
    }

    lines.push('---');
    return lines.join('\n');
  }
}
