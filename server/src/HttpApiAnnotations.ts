import { exec, execFile } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { promisify } from 'util';
import type { Annotation, AnnotationPersistence } from './AnnotationPersistence.js';
import type { City } from './CityManager.js';
import type { Origin } from './OriginManager.js';
import type { Session } from './SessionTracker.js';
import { shellEscape } from './ShellPathUtils.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';

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

/**
 * Convert an absolute fiber file path to its canonical slug, or return the
 * input unchanged when the path doesn't live under any `.felt/` directory.
 *
 * Recognized shapes mirror `FiberReader.walkFibers`:
 *   - `.felt/<slug>.md`              → entry-point fiber, slug = `<slug>`
 *   - `.felt/<dir>/<dir>.md`         → directory-rooted fiber, slug = `<dir>`
 *   - `.felt/<dir>/<sub>.md`         → nested fiber, slug = `<dir>/<sub>`
 *   - `.felt/<a>/<b>/<b>.md`         → directory-rooted nested, slug = `<a>/<b>`
 *
 * Used to normalize annotation keys so a fiber opened by file path shares
 * the annotation pool with the same fiber opened by slug. Without this,
 * annotations created on the fiber-as-file door are invisible to the
 * fiber-as-slug door (and vice versa). See
 * card-redesign/file-modal-absorbs-into-workspace and
 * ai-futures/portolan/vellum-reader/markdown-and-fibers-share-canvas.
 */
function fiberPathToSlug(filePath: string): string {
  if (typeof filePath !== 'string') return filePath as string;
  const match = filePath.match(/(?:^|\/)\.felt\/(.+)\.md$/);
  if (!match) return filePath;
  const rel = match[1];
  const parts = rel.split('/');
  // Directory-rooted shape: `.felt/foo/foo.md` collapses to slug `foo`,
  // `.felt/a/b/b.md` to `a/b`. Only when the leaf duplicates the parent.
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts.pop();
  }
  return parts.join('/');
}

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
  /** Notifies the tapestry cache that a new fiber landed via /file-as-fiber.
   *  Without this, the 30s TTL would hide the new fiber from /astra/graph
   *  and search until expiry. Wired in HttpApi after both APIs are
   *  constructed (tapestryApi can't be referenced from this constructor). */
  private onFiberCreated: ((cityPath: string, sshHost?: string) => void) | null = null;
  private tmuxMessenger = new TmuxSessionMessenger();

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

  setOnFiberCreated(fn: (cityPath: string, sshHost?: string) => void): void {
    this.onFiberCreated = fn;
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

    const rawFilePath = url.searchParams.get('path');
    const claimId = url.searchParams.get('claimId');
    const allClaims = url.searchParams.get('claims') === 'true';
    const originId = url.searchParams.get('originId') || 'local';

    if (!rawFilePath && !claimId && !allClaims) {
      this.sendJsonError(res, 400, 'Missing path, claimId, or claims parameter');
      return;
    }

    // Fiber files have two doors (open by slug, open by absolute path).
    // Normalize to the canonical slug before querying so both doors see the
    // same annotation pool. Non-fiber paths pass through unchanged.
    const filePath = rawFilePath ? fiberPathToSlug(rawFilePath) : null;

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

    // Slug↔path key normalization on create so a fiber file gets the same
    // canonical key as the slug-side door. Persistence stores it under the
    // slug; subsequent reads from either door find it. See fiberPathToSlug
    // above and ai-futures/portolan/vellum-reader/markdown-and-fibers-share-canvas.
    if (data.filePath) {
      data.filePath = fiberPathToSlug(data.filePath);
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
      cityPath?: string;
      annotations: Annotation[];
      globalComment?: string;
      cityName?: string;
      isClaimsSend?: boolean;
      /** When set, the prompt header reads "Feedback on fiber: <slug>"
       *  instead of using `filePath`. Portolan stores fiber annotations with
       *  `filePath = slug` for persistence keying, so `filePath` alone is
       *  ambiguous between a real on-disk path and a slug; this flag
       *  disambiguates and lets the worker see a fiber-shaped identifier. */
      fiberSlug?: string;
    }>(req, res);
    if (!data) return;

    const { workerId, createNewWorker, filePath, originId, cityPath: requestedCityPath, annotations, globalComment, cityName, isClaimsSend, fiberSlug } = data;

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
        const cityPath = requestedCityPath || filePath.substring(0, filePath.lastIndexOf('/'));
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
      : fiberSlug
        ? this.formatFiberAnnotationsForClaude(fiberSlug, annotations, globalComment)
        : this.formatAnnotationsForClaude(filePath, annotations, globalComment);

    try {
      if (isRemote && !sshHost) {
        this.sendJsonError(res, 404, 'Origin not found');
        return;
      }

      this.tmuxMessenger.send({ tmuxSession, sshHost }, formattedMessage);

      if (workerId && this.onFocusSession) {
        this.onFocusSession(workerId);
      }

      // Mark each annotation that has a persisted id as "sent" so the chrome
      // can surface a Clear-sent action against only the dispatched ones.
      // Best-effort: the tmux send already succeeded; failing to persist
      // sentAt must not fail the HTTP response.
      const sentAt = Date.now();
      const updatedIds: string[] = [];
      if (this.annotationPersistence && Array.isArray(annotations)) {
        for (const ann of annotations) {
          if (!ann || typeof ann.id !== 'string' || !ann.id) continue;
          try {
            const updated = this.annotationPersistence.update(ann.id, { sentAt });
            if (updated) updatedIds.push(updated.id);
          } catch (err: any) {
            console.warn(`[SendAnnotations] failed to mark sentAt on ${ann.id}:`, err?.message || err);
          }
        }
      }

      this.sendJsonSuccess(res, { success: true, sentAt, updatedIds });
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
      /** When set, the new fiber is nested under `<parentSlug>/<childSlug>`
       *  instead of created as a top-level fiber. Used by the fiber-mode
       *  bulk action "Fiber" (save annotations as a child of the current
       *  fiber) — the no-worker fallback for capturing thoughts in place. */
      parentSlug?: string;
    }>(req, res);
    if (!data) return;

    const { filePath, originId, title, body, kind = 'task', parentSlug } = data;

    if (!filePath || !title || !body) {
      this.sendJsonError(res, 400, 'Missing required fields');
      return;
    }

    const cityPath = data.cityPath || filePath.substring(0, filePath.lastIndexOf('/'));
    const isRemote = originId !== 'local' && !!originId;

    try {
      let fiberId: string;
      const childSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `note-${Date.now()}`;
      // Nest under parentSlug when set. felt's CLI treats slash-joined slugs
      // as a directory tree (e.g. `parent/child` creates `.felt/parent/child/child.md`),
      // matching FiberReader's directory-based shape.
      const slug = parentSlug ? `${parentSlug}/${childSlug}` : childSlug;
      const feltCmd = `cd ${shellEscape(cityPath)} && felt add ${shellEscape(slug)} ${shellEscape(title)} -t ${shellEscape(kind)} -b ${shellEscape(body)}`;

      let invalidateSshHost: string | undefined;
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
        invalidateSshHost = origin.sshHost;
      }

      // Invalidate the tapestry's fiber-list cache so the next /astra/graph
      // or search hit sees the freshly-created fiber instead of waiting out
      // the 30s TTL. Best-effort — if the hook isn't wired we just live
      // with the latency.
      this.onFiberCreated?.(cityPath, invalidateSshHost);

      this.sendJsonSuccess(res, { success: true, fiberId });
    } catch (error: any) {
      console.error('Failed to file as fiber:', error.message);
      this.sendJsonError(res, 500, 'Failed to file as fiber: ' + error.message);
    }
  }

  /**
   * POST /fiber/create — inline stash from vellum's workspace tab.
   *
   * The GUI counterpart of `felt add <slug> <name> [-t tag] [-b body]`. Mounted
   * by [[constitution-stash-button]]: a `+` button (or `n` hotkey) inside
   * KanbanHost opens a small form that POSTs here. No agent in the loop —
   * this is the *stash* affordance, not conversational authoring.
   *
   * Differs from `/file-as-fiber` (which exists to file annotation comments
   * as a fiber): no annotation context, no synthesized body header, no
   * `kind` defaulting. Tags are explicit and repeatable. The slug is
   * derived from the title via the same kebab-case rule as `/file-as-fiber`
   * for consistency. Optional `parentSlug` nests the new fiber under an
   * existing one (felt's slash-joined slug convention).
   *
   * Returns `{success: true, fiberId}` where `fiberId` is the fully
   * qualified slug (parentSlug + child) the felt CLI emitted on stdout.
   */
  async handleCreateFiber(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await this.parseJsonBody<{
      originId: string;
      /** City root path (the directory containing `.felt/`). For local
       *  stashes the frontend resolves this from the active city's path;
       *  for remote stashes it's the agent-side `feltHost` path. */
      cityPath: string;
      title: string;
      body?: string;
      tags?: string[];
      parentSlug?: string;
      /**
       * Initial status. Defaults to `open` (felt's default for `felt add`).
       * Surfaced so the frontend can mark a stash `active` if the user
       * wants to dispatch immediately, or carry through a constitution-
       * with-draft pairing.
       */
      status?: string;
    }>(req, res);
    if (!data) return;

    const { originId, cityPath, title, body, tags, parentSlug, status } = data;

    if (!cityPath || !title) {
      this.sendJsonError(res, 400, 'Missing required fields (cityPath, title)');
      return;
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      this.sendJsonError(res, 400, 'Title must be non-empty');
      return;
    }
    if (tags && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
      this.sendJsonError(res, 400, 'Tags must be an array of strings');
      return;
    }

    const isRemote = originId !== 'local' && !!originId;

    try {
      // Slug derivation mirrors handleFileAsFiber for consistency: kebab-case,
      // strip leading/trailing hyphens, cap at 60 chars, fallback to a
      // timestamp slug when the title sluggifies to empty (all-special-chars
      // edge case). felt itself enforces uniqueness — let it surface a
      // collision error rather than pre-checking here.
      const childSlug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || `stash-${Date.now()}`;
      const slug = parentSlug ? `${parentSlug.replace(/^\/+|\/+$/g, '')}/${childSlug}` : childSlug;

      // Build the felt invocation. `-t` is repeatable; emit one per tag so
      // multi-word tags survive without comma-splitting heuristics.
      const parts: string[] = [
        `cd ${shellEscape(cityPath)}`,
        '&&',
        'felt add',
        shellEscape(slug),
        shellEscape(title.trim()),
      ];
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          const trimmed = tag.trim();
          if (!trimmed) continue;
          parts.push('-t', shellEscape(trimmed));
        }
      }
      if (status) {
        parts.push('-s', shellEscape(status));
      }
      if (typeof body === 'string' && body.length > 0) {
        parts.push('-b', shellEscape(body));
      }
      const feltCmd = parts.join(' ');

      let fiberId: string;
      let invalidateSshHost: string | undefined;
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
        invalidateSshHost = origin.sshHost;
      }

      // Invalidate the tapestry's fiber-list cache so /astra/graph and
      // /api/search reflect the new fiber immediately rather than waiting
      // out the 30s TTL. Same hook /file-as-fiber uses.
      this.onFiberCreated?.(cityPath, invalidateSshHost);

      this.sendJsonSuccess(res, { success: true, fiberId, slug });
    } catch (error: any) {
      console.error('Failed to create fiber:', error.message);
      this.sendJsonError(res, 500, 'Failed to create fiber: ' + error.message);
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

  /**
   * Fiber-flavoured prompt header. Same body shape as
   * `formatAnnotationsForClaude` (annotations rendered as quote blocks with
   * line refs and selected-text context) but the header points at a fiber
   * slug rather than a file path. The worker is told how to read the fiber
   * (`felt show <slug>` from the project root) so it doesn't have to guess
   * whether the slug is a file or a fiber name.
   */
  formatFiberAnnotationsForClaude(slug: string, annotations: Annotation[], globalComment?: string): string {
    const file = this.formatAnnotationsForClaude(slug, annotations, globalComment);
    // Replace the file-flavoured header with a fiber-flavoured one. Keeping
    // `formatAnnotationsForClaude` as the body source means future tweaks to
    // the per-annotation rendering only have to land in one place.
    return file.replace(`# Feedback on ${slug}`, `# Feedback on fiber: \`${slug}\`\n\nRead it with \`felt show ${slug}\` from the project root.`);
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
        if (ann.isSlideAnnotation && ann.slide !== undefined) {
          const slideRef = ann.slideTitle
            ? `Slide ${ann.slide + 1}: ${ann.slideTitle}`
            : `Slide ${ann.slide + 1}`;
          lines.push(`## ${i + 1}. ${slideRef}`);
          lines.push(`> ${ann.comment}`);
          lines.push('');
        } else if (ann.isImageAnnotation) {
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
