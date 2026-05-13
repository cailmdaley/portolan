import { IncomingMessage, ServerResponse } from 'http';
import type { RecentFileTracker } from './RecentFileTracker.js';

type RuntimeDiagnosticsProvider = () => unknown | Promise<unknown>;

interface NativeBackendDiagnostics {
  enabled: true;
  backendRoot?: string;
  resourceDir?: string;
  launchKind?: string;
  supervised?: boolean;
  processGroup?: boolean;
}

interface HttpApiHooksRuntimeDeps {
  parseJsonBody: <T>(req: IncomingMessage, res: ServerResponse) => Promise<T | null>;
  sendJsonError: (res: ServerResponse, status: number, error: string) => void;
  sendJsonSuccess: (res: ServerResponse, data: Record<string, unknown>) => void;
}

export class HttpApiHooksRuntime {
  private parseJsonBody: HttpApiHooksRuntimeDeps['parseJsonBody'];
  private sendJsonError: HttpApiHooksRuntimeDeps['sendJsonError'];
  private sendJsonSuccess: HttpApiHooksRuntimeDeps['sendJsonSuccess'];
  private recentFileTracker: RecentFileTracker | null = null;
  private runtimeDiagnosticsProvider: RuntimeDiagnosticsProvider | null = null;

  constructor(deps: HttpApiHooksRuntimeDeps) {
    this.parseJsonBody = deps.parseJsonBody;
    this.sendJsonError = deps.sendJsonError;
    this.sendJsonSuccess = deps.sendJsonSuccess;
  }

  setRecentFileTracker(tracker: RecentFileTracker): void {
    this.recentFileTracker = tracker;
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

  async handleDebugRuntime(res: ServerResponse): Promise<void> {
    try {
      const runtimeDiagnostics = this.runtimeDiagnosticsProvider
        ? await this.runtimeDiagnosticsProvider()
        : {};
      const nativeBackend = this.nativeBackendDiagnostics();

      const debug = {
        timestamp: Date.now(),
        pid: process.pid,
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        runtime: nativeBackend
          ? { ...(this.isRecord(runtimeDiagnostics) ? runtimeDiagnostics : {}), nativeBackend }
          : runtimeDiagnostics,
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private nativeBackendDiagnostics(): NativeBackendDiagnostics | null {
    if (process.env.PORTOLAN_NATIVE !== '1') return null;

    return {
      enabled: true,
      backendRoot: process.env.PORTOLAN_NATIVE_BACKEND_ROOT || undefined,
      resourceDir: process.env.PORTOLAN_NATIVE_RESOURCE_DIR || undefined,
      launchKind: process.env.PORTOLAN_NATIVE_LAUNCH_KIND || undefined,
      supervised: parseBoolEnv(process.env.PORTOLAN_NATIVE_BACKEND_SUPERVISED),
      processGroup: parseBoolEnv(process.env.PORTOLAN_NATIVE_BACKEND_PROCESS_GROUP),
    };
  }
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}
