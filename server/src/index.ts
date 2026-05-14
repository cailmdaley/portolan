/**
 * Portolan Server
 *
 * Wires together all managers and serves state to browser via WebSocket.
 * HTTP endpoints handled by HttpApi, terminal commands by KittyIntegration,
 * message routing by MessageRouter.
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { SessionTracker, Session } from './SessionTracker.js';
import { CityManager, City } from './CityManager.js';
import { OriginManager, type RemoteAgentRuntime } from './OriginManager.js';
import { CityPersistence } from './CityPersistence.js';
import { AnnotationPersistence } from './AnnotationPersistence.js';
import { GitStatusManager } from './GitStatusManager.js';
import { RecentFileTracker } from './RecentFileTracker.js';
import { RecentsStore } from './RecentsStore.js';
import { EventWatcher } from './EventWatcher.js';
import { HttpApi } from './HttpApi.js';
import { KittyIntegration } from './KittyIntegration.js';
import { MessageRouter, AgentActivityMessage } from './MessageRouter.js';
import { MeetingBridge } from './MeetingBridge.js';
import { ParakeetTranscriptSource } from './ParakeetTranscriptSource.js';
import { VibeVoiceTranscriptSource } from './VibeVoiceTranscriptSource.js';
import { RemoteAgentCoordinator, recoverRemoteAgent } from './RemoteAgentCoordinator.js';
import { parseRemoteAgentRuntime, remoteAgentRuntimeProfiles } from './RemoteAgentRuntime.js';
import { RemoteAgentRuntimePreferenceStore } from './RemoteAgentRuntimePreferenceStore.js';
import { normalizedRemoteOriginIdForSshHost, normalizedRemoteOriginName } from './RemoteAgentHostIdentity.js';
import { WorkspaceBrowser } from './WorkspaceBrowser.js';
import { BrowserStateCoordinator } from './BrowserStateCoordinator.js';
import { TerminalStreamManager } from './TerminalStreamManager.js';
import { FiberTreeSnapshotStore } from './FiberTreeSnapshotStore.js';
import { AgentRequestCoordinator } from './AgentRequestCoordinator.js';
import { publishShuttleFeltStores } from './ShuttleFeltStoresPublisher.js';
import { visibleRemoteCityPaths, visibleRemoteSnapshots } from './RemoteSnapshotPolicy.js';
import { RemoteTerminalSubscriptions } from './RemoteTerminalSubscriptions.js';

// ============================================================================
// Constants
// ============================================================================

const PORT = process.env.VITEST ? 4099 : 4004;
const FIBER_REFRESH_INTERVAL = 10000; // 10 seconds
const LOCAL_ORIGIN_ID = 'local';
let remoteWorkingTimeoutIntervalHandle: NodeJS.Timeout | null = null;
const remoteTerminalSubscriptions = new RemoteTerminalSubscriptions();

// ============================================================================
// Initialization
// ============================================================================

const cityManager = new CityManager();
const cityPersistence = new CityPersistence();
const annotationPersistence = new AnnotationPersistence();
const sessionTracker = new SessionTracker();
const originManager = new OriginManager();
const eventWatcher = new EventWatcher();
const gitStatusManager = new GitStatusManager();
const recentFileTracker = new RecentFileTracker();
const recentsStore = new RecentsStore();
const fiberTreeSnapshotStore = new FiberTreeSnapshotStore();
const agentRequestCoordinator = new AgentRequestCoordinator(originManager);
const remoteAgentRuntimePreferences = new RemoteAgentRuntimePreferenceStore();
const meetingBridge = new MeetingBridge({
  sourceFactory: {
    createParakeetSource: (parakeetOptions, callbacks) =>
      new ParakeetTranscriptSource(parakeetOptions, callbacks),
    createVibeVoiceSource: (vibeVoiceOptions, callbacks) =>
      new VibeVoiceTranscriptSource(vibeVoiceOptions, callbacks),
  },
});

// Load persisted cities into CityManager
const persistedCities = cityPersistence.load();

// Load persisted annotations
annotationPersistence.load();
for (const pc of persistedCities) {
  if (pc.sshHost && pc.originId !== 'local') {
    // Normalize originId to use sshHost instead of raw hostname (e.g., "remote-c02" → "remote-candide").
    // Different login nodes produce different hostnames; the SSH config name is the stable identifier.
    const normalizedOriginId = normalizedRemoteOriginIdForSshHost(pc.sshHost);
    if (pc.originId !== normalizedOriginId) {
      cityPersistence.normalizeOriginId(pc.originId, normalizedOriginId, pc.sshHost);
      pc.originId = normalizedOriginId;
    }
    cityManager.setOriginSshHost(pc.originId, pc.sshHost);
  }
  cityManager.addPinnedCity(pc.id, pc.path, pc.name, pc.position, pc.originId);
}

const REMOTE_WORKING_TIMEOUT = 30_000; // 30 seconds, same as EventWatcher

// Track previous sessions to detect removals
let previousSessions = new Map<string, Session>();

// ============================================================================
// Lookup Adapters (for extracted modules)
// ============================================================================

const sessionLookup = {
  findSession(sessionId: string): Session | undefined {
    const local = sessionTracker.getSessions().find(s => s.id === sessionId);
    if (local) return local;
    return remoteAgentCoordinator.findSession(sessionId);
  },
  getAllSessions(): Session[] {
    return [...sessionTracker.getSessions(), ...remoteAgentCoordinator.getAllSessions()];
  },
  findLocalByTmuxSession(tmuxSession: string): Session | undefined {
    return sessionTracker.getSessions().find(s => s.tmuxSession === tmuxSession);
  },
};

const cityLookup = {
  findCityByPath(path: string): City | undefined {
    return cityManager.getCities().find(c => c.path === path);
  },
  getSshHost(city: City): string | undefined {
    const origin = originManager.getOrigin(city.originId);
    if (origin?.sshHost) return origin.sshHost;
    const persistedCity = cityPersistence.getCityById(city.id);
    if (persistedCity?.sshHost) return persistedCity.sshHost;
    return cityPersistence.findSshHostForPath(city.path) || city.originId.replace('remote-', '');
  },
};

const remoteDirectoryExecutor = async (originId: string, path: string) => {
  const result = await agentRequestCoordinator.send<{
    entries?: Array<{ name: string; type: 'file' | 'dir' }>;
  }>(originId, 'list-directory', { path }, 10_000);
  return result.entries ?? [];
};

const remoteFileContentExecutor = async (request: {
  originId: string;
  path: string;
  operation: 'read' | 'write';
  content?: string;
}) => {
  const result = await agentRequestCoordinator.send<{ content?: string; mtimeMs?: number }>(
    request.originId,
    'file-content',
    request,
    10_000,
  );
  return { content: result.content, mtimeMs: result.mtimeMs };
};

// ============================================================================
// Extracted Modules
// ============================================================================

const httpApi = new HttpApi(cityManager, originManager, cityPersistence, {
  remoteSnapshotsProvider: () => visibleRemoteSnapshots(
    fiberTreeSnapshotStore.getAllSnapshots(),
    cityManager.getCities(),
  ),
  remoteShuttleDiagnosticsProvider: () => remoteAgentCoordinator.getRemoteShuttleSnapshotStats(),
  remoteAgentRuntimePreferences,
  // Stage 4 — remote-origin kanban mutations route through this executor.
  // Sends a `kanban-transition` payload over the agent's WebSocket via the
  // correlation-ID layer, applies the agent's reply fiber JSON as a
  // `fiber_tree_delta` so the snapshot reflects the new state immediately,
  // and resolves so HttpApiKanban can build the refreshed card. The
  // agent-side fs.watch will fire its own delta moments later; double-apply
  // is idempotent because the second copy carries identical felt JSON.
  remoteTransitionExecutor: async ({ originId, feltHost, ...payload }) => {
    const result = await agentRequestCoordinator.send<{ fiber?: unknown }>(
      originId,
      'kanban-transition',
      { ...payload, feltHost },
    );
    if (result.fiber !== undefined) {
      fiberTreeSnapshotStore.applyDelta(originId, [
        { path: payload.path, op: 'upsert', fiber: result.fiber },
      ], feltHost);
    }
  },
  remoteRawFiberExecutor: async ({ originId, feltHost, ...payload }) => {
    const result = await agentRequestCoordinator.send<{
      body?: string;
      sha256?: string;
      fiber?: unknown;
    }>(
      originId,
      'fiber-raw',
      { ...payload, feltHost },
      10_000,
    );
    if (payload.operation === 'write' && result.fiber !== undefined) {
      fiberTreeSnapshotStore.applyDelta(originId, [
        { path: payload.path, op: 'upsert', fiber: result.fiber },
      ], feltHost);
    }
    return { body: result.body, sha256: result.sha256 };
  },
  remoteFiberHistoryExecutor: async ({ originId, feltHost, slug }) => {
    const result = await agentRequestCoordinator.send<{ events?: unknown[] }>(
      originId,
      'fiber-history',
      { feltHost, slug },
      10_000,
    );
    return { events: result.events };
  },
  remoteFeltCommentExecutor: async ({ originId, feltHost, claimId, comment }) => {
    await agentRequestCoordinator.send(
      originId,
      'felt-comment',
      { feltHost, claimId, comment },
      10_000,
    );
  },
  remoteTmuxMessageExecutor: async ({ originId, tmuxSession, message, pressEnter }) => {
    await agentRequestCoordinator.send(
      originId,
      'tmux-message',
      { tmuxSession, message, pressEnter: pressEnter ?? false },
      10_000,
    );
  },
  remoteFileContentExecutor,
  remoteDirectoryExecutor,
  remoteProjectFileExecutor: async ({ originId, ...payload }) => {
    const result = await agentRequestCoordinator.send<{
      contentBase64?: string;
      byteLength?: number;
    }>(
      originId,
      'project-file',
      payload,
      30_000,
    );
    return { contentBase64: result.contentBase64, byteLength: result.byteLength };
  },
});
httpApi.setAnnotationPersistence(annotationPersistence);
httpApi.setSessionLookup(sessionLookup);
httpApi.setRecentFileTracker(recentFileTracker);
httpApi.setRecentsStore(recentsStore);
httpApi.setRuntimeDiagnosticsProvider(() => {
  const localSessionCount = sessionTracker.getSessions().length;
  const remoteSessionCount = getRemoteSessionCount();
  const connectedRemoteOrigins = originManager
    .getOrigins()
    .filter((origin) => origin.type === 'remote' && originManager.isOriginConnected(origin.id))
    .length;

  return {
    sessions: {
      local: localSessionCount,
      remote: remoteSessionCount,
      total: localSessionCount + remoteSessionCount,
      previousSessionRecords: previousSessions.size,
    },
    websocket: {
      browserClients: browserStateCoordinator.getClientCount(),
      connectedRemoteOrigins,
      connectedRemoteAgents: originManager.getConnectedRemoteAgentDiagnostics(),
    },
    browserState: browserStateCoordinator.getBroadcastStats(),
    maps: {
      activeSearches: workspaceBrowser.getActiveSearchCount(),
      remoteSessionOrigins: remoteAgentCoordinator.getRemoteSessionOriginCount(),
      remoteGitStatuses: remoteAgentCoordinator.getRemoteGitStatusCount(),
      remoteActivities: remoteAgentCoordinator.getRemoteActivityStoreCount(),
      remoteActivityEvents: remoteAgentCoordinator.getRemoteActivityEventCount(),
    },
    fiberCounts: browserStateCoordinator.getFiberCountCacheStats(),
    intervals: {
      fiberRefreshActive: browserStateCoordinator.isFiberRefreshActive(),
      remoteWorkingTimeoutActive: remoteWorkingTimeoutIntervalHandle !== null,
    },
    eventWatcher: eventWatcher.getStats(),
    terminalStreams: {
      local: terminalStreamManager.stats(),
      remote: remoteTerminalSubscriptions.getStats(),
    },
    remoteAgentRequests: agentRequestCoordinator.getDiagnostics(),
    remoteWorkingSessions: remoteAgentCoordinator.getRemoteWorkingStats(),
    remoteAgentRecovery: remoteAgentCoordinator.getRemoteAgentRecoveryStats(),
    remoteAgentRuntimeProfiles: remoteAgentRuntimeProfiles(),
    remoteAgentRuntimePreferences: remoteAgentRuntimePreferences.getDiagnostics(),
    recentFiles: {
      sessionCount: recentFileTracker.getSessionCount(),
      entryCount: recentFileTracker.getTotalEntryCount(),
    },
    filesSearch: httpApi.getFilesSearchDiagnostics(),
    meetingBridge: meetingBridge.getState(),
    // Remote agents may publish read-only `shuttle_snapshot` diagnostics.
    // Dispatch remains owned by Shuttle; this only makes remote observability
    // visible through /debug-runtime while the Rust agent grows parity.
    shuttle: {
      remoteSnapshots: remoteAgentCoordinator.getRemoteShuttleSnapshotStats(),
    },
  };
});
httpApi.setMeetingBridge(meetingBridge);
const kitty = new KittyIntegration(sessionLookup, originManager, cityLookup);
// Pane byte streaming for in-map terminal cards. Local sessions only in
// this iteration; remote support extends the same subscribe/fan-out
// interface through the portolan-agent tailer. See
// constitution-terminals-in-map.
const terminalStreamManager = new TerminalStreamManager();
const remoteSearchExecutor = async (
  originId: string,
  path: string,
  query: string,
  mode: 'filename' | 'content',
) => {
  const result = await agentRequestCoordinator.send<{
    results?: Array<{
      type: 'file' | 'dir';
      path: string;
      fullPath: string;
      line?: number;
      match?: string;
    }>;
    timedOut?: boolean;
  }>(originId, 'search-files', {
    path,
    query,
    mode,
  }, 15_000);

  return {
    results: result.results ?? [],
    timedOut: result.timedOut ?? false,
  };
};
const workspaceBrowser = new WorkspaceBrowser(
  cityManager,
  originManager,
  cityPersistence,
  remoteDirectoryExecutor,
  remoteSearchExecutor,
);
const browserStateCoordinator = new BrowserStateCoordinator({
  cityManager,
  cityPersistence,
  eventWatcher,
  gitStatusManager,
  originManager,
  previousSessions,
  recentFileTracker,
  sessionLookup,
  getMeetingState: () => meetingBridge.getState(),
  localOriginId: LOCAL_ORIGIN_ID,
});
meetingBridge.onStateChange(() => {
  void browserStateCoordinator.broadcastCurrentState();
});
const remoteAgentCoordinator = new RemoteAgentCoordinator(
  cityManager,
  originManager,
  recentFileTracker,
  previousSessions,
  {
    assignSessionToCity: browserStateCoordinator.assignSessionToCity.bind(browserStateCoordinator),
    broadcastActivity: browserStateCoordinator.broadcastActivity.bind(browserStateCoordinator),
    broadcastState: () => {
      void browserStateCoordinator.broadcastCurrentState();
    },
    rebuildCities: browserStateCoordinator.rebuildCities.bind(browserStateCoordinator),
    recoverRemoteAgent,
  },
);
browserStateCoordinator.setRemoteAgentStateSource(remoteAgentCoordinator);

// Callback for creating new workers (used by send-annotations endpoint)
httpApi.setOnCreateNewWorker(async (cityPath: string, originId: string) => {
  const city = cityManager.getCities().find(c => c.path === cityPath || cityPath.startsWith(c.path + '/'));
  const isRemote = originId !== 'local' && !!originId;

  // Get SSH host and display name for remote cities
  const sshHost = isRemote && city ? cityLookup.getSshHost(city) : undefined;
  const originDisplayName = city?.originId.replace('remote-', '');

  return kitty.createWorker(cityPath, { sshHost, originDisplayName });
});

// Callback for focusing sessions in Kitty (used by send-annotations endpoint)
httpApi.setOnFocusSession((sessionId: string) => {
  kitty.focusSession(sessionId);
  kitty.activateKitty();
});

// ============================================================================
// State Management
// ============================================================================

function getRemoteSessionCount(): number {
  return remoteAgentCoordinator.getRemoteSessionCount();
}

// ============================================================================
// Session Change Handler (Local Sessions)
// ============================================================================

sessionTracker.onSessionsChange((localSessions) => {
  void browserStateCoordinator.handleLocalSessionsChange(localSessions);
});
// ============================================================================
// Remote Session Handling
// ============================================================================

// ============================================================================
// Message Handlers
// ============================================================================

// ============================================================================
// Message Router Setup
// ============================================================================

function resolveLocalTmuxSession(sessionId: string): string | null {
  const session = sessionLookup.findSession(sessionId);
  if (!session) return null;
  if (session.originId !== LOCAL_ORIGIN_ID) return null;
  return session.tmuxSession;
}

function resolveTerminalSession(sessionId: string): Session | null {
  return sessionLookup.findSession(sessionId) ?? null;
}

function sendAgentFrame(originId: string, frame: Record<string, unknown>): boolean {
  const origin = originManager.getOrigin(originId);
  const agentSocket = origin ? [...origin.agentSockets].find(s => s.readyState === WebSocket.OPEN) : undefined;
  if (!agentSocket) return false;
  agentSocket.send(JSON.stringify(frame));
  return true;
}

function registerRemoteTerminalSubscription(
  ws: WebSocket,
  sessionId: string,
  originId: string,
  tmuxSession: string,
): string | null {
  const previous = remoteTerminalSubscriptions.get(ws, sessionId);
  const existingSubscriptionId = remoteTerminalSubscriptions.getTargetSubscriptionId(originId, tmuxSession);
  const subscriptionId = previous?.originId === originId && previous.tmuxSession === tmuxSession
    ? previous.subscriptionId
    : existingSubscriptionId
      ? existingSubscriptionId
    : randomUUID();
  const needsAgentSubscribe = !existingSubscriptionId;

  if (needsAgentSubscribe) {
    if (!sendAgentFrame(originId, {
      type: 'terminal-subscribe',
      payload: { subscriptionId, tmuxSession },
    })) {
      return null;
    }
  }
  const obsolete = remoteTerminalSubscriptions.set(ws, sessionId, { originId, subscriptionId, tmuxSession });
  if (obsolete) {
    sendAgentFrame(obsolete.originId, {
      type: 'terminal-unsubscribe',
      payload: { subscriptionId: obsolete.subscriptionId },
    });
  }
  return subscriptionId;
}

function detachRemoteTerminal(ws: WebSocket, sessionId: string): void {
  const obsolete = remoteTerminalSubscriptions.delete(ws, sessionId);
  if (!obsolete) return;
  sendAgentFrame(obsolete.originId, {
    type: 'terminal-unsubscribe',
    payload: { subscriptionId: obsolete.subscriptionId },
  });
}

function detachAllRemoteTerminals(ws: WebSocket): void {
  for (const entry of remoteTerminalSubscriptions.deleteClient(ws)) {
    sendAgentFrame(entry.originId, {
      type: 'terminal-unsubscribe',
      payload: { subscriptionId: entry.subscriptionId },
    });
  }
}

function routeRemoteTerminalBytes(originId: string, subscriptionId: string, bytesBase64: string): void {
  remoteTerminalSubscriptions.routeBytes(originId, subscriptionId, bytesBase64);
}

function routeRemoteTerminalExit(originId: string, subscriptionId: string, reason?: string): void {
  remoteTerminalSubscriptions.routeExit(originId, subscriptionId, reason);
}

const messageRouter = new MessageRouter({
  onFocus: (sessionId) => kitty.focusSession(sessionId),
  onGetFibers: browserStateCoordinator.handleGetFibers.bind(browserStateCoordinator),
  onHandoff: (fiberId, cityPath) => kitty.handoff(fiberId, cityPath),
  onNewWorker: (ws, cityPath, name, chrome, continueSession, cli) => kitty.newWorker(ws, cityPath, name, chrome, continueSession, cli),
  onPinCity: browserStateCoordinator.handlePinCity.bind(browserStateCoordinator),
  onUnpinCity: browserStateCoordinator.handleUnpinCity.bind(browserStateCoordinator),
  onConfirmUnpin: browserStateCoordinator.performUnpin.bind(browserStateCoordinator),
  onKillWorker: (sessionId) => kitty.killWorker(sessionId),
  onSearchFiles: workspaceBrowser.handleSearchFiles.bind(workspaceBrowser),
  onMoveCity: browserStateCoordinator.handleMoveCity.bind(browserStateCoordinator),
  onListDirectory: workspaceBrowser.handleListDirectory.bind(workspaceBrowser),
  onBrowserAttention: browserStateCoordinator.handleBrowserAttention.bind(browserStateCoordinator),
  onTerminalAttach: (ws, sessionId) => {
    const session = resolveTerminalSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({
        type: 'terminal:error',
        sessionId,
        error: 'session-not-found',
      }));
      return;
    }
    const tmuxSession = session.tmuxSession;
    if (session.originId !== LOCAL_ORIGIN_ID) {
      const subscriptionId = registerRemoteTerminalSubscription(ws, sessionId, session.originId, tmuxSession);
      if (!subscriptionId) {
        ws.send(JSON.stringify({
          type: 'terminal:error',
          sessionId,
          error: `origin ${session.originId} has no connected agent`,
        }));
        return;
      }
      agentRequestCoordinator.send<{
        bytesBase64?: string;
        cols?: number;
        rows?: number;
      }>(session.originId, 'terminal-capture', {
        tmuxSession,
        lines: 5000,
      }).then((result) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({
          type: 'terminal:scrollback',
          sessionId,
          bytes: result.bytesBase64 ?? '',
          ...(result.cols ? { cols: result.cols } : {}),
          ...(result.rows ? { rows: result.rows } : {}),
        }));
      }).catch((err) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({
          type: 'terminal:error',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      return;
    }
    // Scrollback first, then live bytes. Capture is best-effort — if the
    // pane has already exited, just fall through to the live subscribe and
    // let the exit event propagate. We also include the pane's current
    // col/row count so the client can init wterm at the right size — see
    // [[wterm-col-width-mismatch]].
    Promise.all([
      terminalStreamManager.getScrollback(tmuxSession),
      terminalStreamManager.getPaneSize(tmuxSession),
    ]).then(([bytes, size]) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({
        type: 'terminal:scrollback',
        sessionId,
        bytes: bytes.toString('base64'),
        ...(size ? { cols: size.cols, rows: size.rows } : {}),
      }));
    }).catch((err) => {
      console.warn(`[terminal:attach] scrollback failed for ${tmuxSession}:`, err?.message ?? err);
    });
    terminalStreamManager.attach(tmuxSession, {
      key: ws,
      onBytes: (bytes) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({
          type: 'terminal:bytes',
          sessionId,
          bytes: bytes.toString('base64'),
        }));
      },
      onExit: (reason) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({
          type: 'terminal:exit',
          sessionId,
          reason,
        }));
      },
      onError: (err) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({
          type: 'terminal:error',
          sessionId,
          error: err,
        }));
      },
    });
  },
  onTerminalDetach: (ws, sessionId) => {
    const session = resolveTerminalSession(sessionId);
    if (!session) return;
    if (session.originId !== LOCAL_ORIGIN_ID) {
      detachRemoteTerminal(ws, sessionId);
      return;
    }
    terminalStreamManager.detach(session.tmuxSession, ws);
  },
});

// ============================================================================
// HTTP Server
// ============================================================================

const server = createServer(async (req, res) => {
  const handled = await httpApi.handleRequest(req, res);
  if (handled) return;

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Portolan server running\n');
});

// ============================================================================
// WebSocket Server
// ============================================================================

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const isAgent = url.searchParams.get('agent') === 'true';
  const originName = url.searchParams.get('origin');
  const sshHost = url.searchParams.get('sshHost') || undefined;
  let agentRuntime: RemoteAgentRuntime = 'node';
  if (isAgent) {
    try {
      agentRuntime = parseRemoteAgentRuntime(url.searchParams.get('agentRuntime'), 'node');
    } catch (error: unknown) {
      ws.close(1008, (error as Error).message);
      console.warn(`[Agent] rejected connection: ${(error as Error).message}`);
      return;
    }
  }
  const plannotatorPortParam = url.searchParams.get('plannotatorPort');
  const plannotatorPort = plannotatorPortParam ? parseInt(plannotatorPortParam, 10) : undefined;
  const agentOnce = url.searchParams.get('once') === 'true';

  if (isAgent && originName) {
    // Agent connection — normalize origin name using sshHost when available
    // so different login nodes (login07.leonardo.local) map to the same origin (cineca).
    const effectiveOriginName = normalizedRemoteOriginName(originName, sshHost);
    const origin = originManager.registerAgent(effectiveOriginName, ws, sshHost, plannotatorPort, agentRuntime, agentOnce);
    cityManager.setOriginPosition(origin.id, origin.position);
    // Track sshHost for city key normalization (so different login nodes share cities)
    if (sshHost) {
      cityManager.setOriginSshHost(origin.id, sshHost);
    }

    ws.send(JSON.stringify({
      type: 'connected',
      payload: { originId: origin.id, position: origin.position },
    }));
    ws.send(JSON.stringify({
      type: 'fiber_tree_hosts',
      payload: { feltHosts: remoteFeltHostsForOrigin(origin.id) },
    }));

    console.log(`Agent connected: ${originName} (${origin.id})`);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'agent_sessions_update') {
          remoteAgentCoordinator.handleAgentSessionsUpdate(origin.id, message.payload.sessions);
        } else if (message.type === 'agent_activity') {
          remoteAgentCoordinator.handleAgentActivity(origin.id, (message as AgentActivityMessage).activity);
        } else if (message.type === 'fiber_tree_dump') {
          // Stage 3a — agent ships its full fiber-tree on connect (and again
          // on each reconnect). Replaces this origin's snapshot wholesale;
          // the agent is the sole writer to its host's tree, so there's no
          // reconciliation to do. See [[constitution-vellum-kanban]].
          const { feltHost, files } = message.payload as {
            feltHost: string;
            files: Array<{ path: string; fiber: unknown }>;
          };
          fiberTreeSnapshotStore.upsertFullDump(origin.id, feltHost, files ?? []);
          console.log(
            `[FiberTree] full dump from ${origin.id}: ${(files ?? []).length} files at ${feltHost}`,
          );
          // The kanban view rebuilds per request, so we don't need to push;
          // browsers polling /kanban will pick up the new state on next read.
        } else if (message.type === 'fiber_tree_delta') {
          const { feltHost, deltas } = message.payload as {
            feltHost?: string;
            deltas: Array<{ path: string; op: 'upsert' | 'delete'; fiber?: unknown }>;
          };
          fiberTreeSnapshotStore.applyDelta(origin.id, deltas ?? [], feltHost);
        } else if (message.type === 'shuttle_snapshot') {
          remoteAgentCoordinator.handleShuttleSnapshot(origin.id, message.payload);
        } else if (typeof message.type === 'string' && message.type.endsWith('-result')) {
          const handled = agentRequestCoordinator.handleResultFrame(
            message.type,
            (message as { payload?: unknown }).payload,
          );
          if (!handled) {
            console.warn(`[Agent] dropped malformed result message from ${origin.id}: ${message.type}`);
          }
        } else if (message.type === 'terminal-bytes') {
          const { subscriptionId, bytesBase64 } = message.payload as {
            subscriptionId: string;
            bytesBase64: string;
          };
          routeRemoteTerminalBytes(origin.id, subscriptionId, bytesBase64);
        } else if (message.type === 'terminal-exit') {
          const { subscriptionId, reason } = message.payload as {
            subscriptionId: string;
            reason?: string;
          };
          routeRemoteTerminalExit(origin.id, subscriptionId, reason);
        }
      } catch (error) {
        console.error('Failed to handle agent message:', error);
      }
    });

    ws.on('close', () => {
      const disconnectedOrigin = originManager.handleDisconnect(ws);
      if (disconnectedOrigin) {
        remoteAgentCoordinator.handleAgentDisconnect(
          disconnectedOrigin.id,
          disconnectedOrigin.sshHost,
          disconnectedOrigin.agentRuntime,
        );
        // Stage 3a — flag the origin's fiber-tree snapshot stale (kept,
        // not cleared, so the kanban can render last-known-good cards
        // with a "waiting on <hostname>" badge). Stage 3b wires the UI;
        // for now we just track the timestamp so the wire is honest.
        fiberTreeSnapshotStore.markStale(disconnectedOrigin.id, new Date().toISOString());
        // Stage 4 — fail any kanban-transitions waiting on this origin so
        // the HTTP caller gets an immediate "agent disconnected" response
        // instead of waiting for the 5s timeout. The user re-drags after
        // the agent reconnects.
        agentRequestCoordinator.drainOnDisconnect(disconnectedOrigin.id);
        remoteTerminalSubscriptions.closeOrigin(
          disconnectedOrigin.id,
          `agent disconnected: ${disconnectedOrigin.name}`,
        );
        void browserStateCoordinator.broadcastCurrentState();
      }
      console.log(`Agent disconnected: ${originName}`);
    });

    ws.on('error', (error) => console.error('Agent WebSocket error:', error));
  } else {
    // Browser client
    await browserStateCoordinator.attachClient(ws);
    console.log('Browser client connected');

    ws.on('message', (data) => messageRouter.routeClientMessage(ws, data.toString()));
    ws.on('close', () => {
      browserStateCoordinator.detachClient(ws);
      // Drop any live terminal subscriptions so disconnecting clients do
      // not leak tmux control-mode processes. Manager refcounts per
      // session, so this is a no-op when the ws had no attaches.
      terminalStreamManager.detachAll(ws);
      detachAllRemoteTerminals(ws);
      console.log('Browser client disconnected');
    });
    ws.on('error', (error) => console.error('WebSocket error:', error));
  }
});

// ============================================================================
// Startup
// ============================================================================

// Set local plannotator port from environment
const localPlannotatorPort = process.env.PLANNOTATOR_PORT ? parseInt(process.env.PLANNOTATOR_PORT, 10) : undefined;
if (localPlannotatorPort) {
  originManager.setLocalPlannotatorPort(localPlannotatorPort);
  console.log(`Local plannotator port: ${localPlannotatorPort}`);
}

sessionTracker.start(2000);

eventWatcher.setSessionTracker(sessionTracker);
eventWatcher.onActivity((activity) => {
  console.log('[Activity]', activity.tmuxSession, activity.tool, activity.summary || '');

  // Feed the local recent-files tracker. Remote activity is fed via
  // RemoteAgentCoordinator; EventWatcher only observes local events.jsonl,
  // so any activity here belongs to a local tmux session.
  if (
    activity.fullPath &&
    (activity.tool === 'Read' || activity.tool === 'Write' || activity.tool === 'Edit')
  ) {
    const session = sessionLookup.findLocalByTmuxSession(activity.tmuxSession);
    if (session) {
      recentFileTracker.recordTouch(
        session.id,
        activity.tool,
        activity.fullPath,
        activity.timestamp,
      );

      // Stage G of constitution-portolan-navigation-layer: agent file
      // touches feed the SQLite recents store as `viewer_kind:agent`,
      // surfacing in Find's Recents column with an [a] badge so the
      // human can see what their workers are touching across cities.
      // session.cityId / originId / path comes from BrowserStateCoordinator's
      // assignSessionToCity reconciliation. Path stored relative to city
      // root so the Recents row is portable across machines (matches the
      // file-tree row scheme).
      if (session.cityId && session.originId) {
        const city = cityManager.getCityById(session.cityId);
        if (city) {
          const relPath = relativeToCity(activity.fullPath, city.path);
          if (relPath) {
            recentsStore.recordView({
              viewerKind: 'agent',
              viewerId: session.id,
              originId: session.originId,
              cityId: session.cityId,
              kind: 'file',
              path: relPath,
              timestamp: activity.timestamp,
            });
          }
        }
      }
    }
  }

  browserStateCoordinator.broadcastActivity(activity, LOCAL_ORIGIN_ID);
});

/**
 * Stage G helper: relativize an absolute file path to a city root, so
 * agent file-touches surface in Recents with portable, city-rooted paths
 * (matching how /global-files-search and the Files-column tree key
 * entries). Returns null when the path lives outside the city — those
 * touches don't belong in the city's Recents and global Recents would
 * have no city to attribute them to.
 *
 * Realpath is intentionally NOT resolved here: cities like loom that are
 * symlinked into project trees (`portolan/.felt → loom/.felt/portolan`)
 * already have their canonical path on the City record, and the file
 * paths we receive from EventWatcher are the literal Read/Write/Edit
 * arguments, which the user wrote in the symlinked form. Both come out
 * identically prefixed; no extra realpath step needed.
 */
function relativeToCity(fullPath: string, cityPath: string): string | null {
  const normalized = cityPath.endsWith('/') ? cityPath : `${cityPath}/`;
  if (!fullPath.startsWith(normalized)) return null;
  const rel = fullPath.slice(normalized.length);
  return rel.length > 0 ? rel : null;
}
eventWatcher.start();

gitStatusManager.setUpdateHandler(({ path, status }) => {
  console.log(`[Git] ${path}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`);
  void browserStateCoordinator.broadcastCurrentState();
});
gitStatusManager.start();

browserStateCoordinator.startFiberRefresh(FIBER_REFRESH_INTERVAL);

// Check for remote session working timeouts
remoteWorkingTimeoutIntervalHandle = setInterval(() => {
  const changed = remoteAgentCoordinator.expireWorkingSessions(Date.now() - REMOTE_WORKING_TIMEOUT);
  if (changed) {
    void browserStateCoordinator.broadcastCurrentState();
  }
  remoteAgentCoordinator.recoverDisconnectedAgents();
}, 5000);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use - another instance is running`);
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`Portolan server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  void publishShuttleFeltStores(cityPersistence.getCities());
});

// ============================================================================
// Shuttle — retired in-process engine (Stage 6 cutover)
// ============================================================================
//
// The local dispatch engine now lives in the standalone Elixir application
// at ~/Documents/projects/shuttle/. Start it with:
//   cd ~/Documents/projects/shuttle && make start
// or (once released):
//   shuttle start
//
// Portolan's kanban still detects running workers by probing tmux sessions
// (see src/Shuttle.ts utilities). The server's debug view no longer carries
// composite dispatch state — query the Elixir daemon directly via
//   shuttle snapshot
// Remote snapshot composition (cross-host visibility) is deferred to the
// BEAM-distribution phase (Stage 7 of constitution-shuttle-standalone).

let shuttingDown = false;

function stopBackgroundTimers(): void {
  browserStateCoordinator.stop();
  if (remoteWorkingTimeoutIntervalHandle) {
    clearInterval(remoteWorkingTimeoutIntervalHandle);
    remoteWorkingTimeoutIntervalHandle = null;
  }
}

function remoteFeltHostsForOrigin(originId: string): string[] {
  return visibleRemoteCityPaths(originId, cityManager.getCities()).map((city) => city.path);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');
  stopBackgroundTimers();
  sessionTracker.stop();
  gitStatusManager.stop();
  eventWatcher.stop();
  meetingBridge.stop();
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
