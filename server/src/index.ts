/**
 * Portolan Server
 *
 * Wires together all managers and serves state to browser via WebSocket.
 * HTTP endpoints handled by HttpApi, terminal commands by KittyIntegration,
 * message routing by MessageRouter.
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { SessionTracker, Session } from './SessionTracker.js';
import { CityManager, City } from './CityManager.js';
import { OriginManager } from './OriginManager.js';
import { CityPersistence } from './CityPersistence.js';
import { AnnotationPersistence } from './AnnotationPersistence.js';
import { GitStatusManager } from './GitStatusManager.js';
import { RecentFileTracker } from './RecentFileTracker.js';
import { EventWatcher } from './EventWatcher.js';
import { HttpApi } from './HttpApi.js';
import { KittyIntegration } from './KittyIntegration.js';
import { MessageRouter, AgentActivityMessage } from './MessageRouter.js';
import { MeetingBridge } from './MeetingBridge.js';
import { ParakeetTranscriptSource } from './ParakeetTranscriptSource.js';
import { RemoteAgentCoordinator, reconnectTunnel } from './RemoteAgentCoordinator.js';
import { WorkspaceBrowser } from './WorkspaceBrowser.js';
import { BrowserStateCoordinator } from './BrowserStateCoordinator.js';
import { TerminalStreamManager } from './TerminalStreamManager.js';
import { Shuttle, defaultShuttleConfig } from './Shuttle.js';
import { FiberTreeSnapshotStore } from './FiberTreeSnapshotStore.js';
import { AgentRequestCoordinator } from './AgentRequestCoordinator.js';

// ============================================================================
// Constants
// ============================================================================

const PORT = process.env.VITEST ? 4099 : 4004;
const FIBER_REFRESH_INTERVAL = 10000; // 10 seconds
const LOCAL_ORIGIN_ID = 'local';
let remoteWorkingTimeoutIntervalHandle: NodeJS.Timeout | null = null;

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
const fiberTreeSnapshotStore = new FiberTreeSnapshotStore();
const agentRequestCoordinator = new AgentRequestCoordinator(originManager);
const meetingBridge = new MeetingBridge({
  sourceFactory: {
    createParakeetSource: (parakeetOptions, callbacks) =>
      new ParakeetTranscriptSource(parakeetOptions, callbacks),
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
    const baseSshHost = pc.sshHost.replace(/-login\d+$/, '');
    const normalizedOriginId = `remote-${baseSshHost}`;
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

// ============================================================================
// Extracted Modules
// ============================================================================

const httpApi = new HttpApi(cityManager, originManager, cityPersistence, {
  remoteSnapshotsProvider: () => fiberTreeSnapshotStore.getAllSnapshots(),
  // Stage 4 — remote-origin /kanban/transition routes through this executor.
  // Sends a `kanban-transition` over the agent's WebSocket via the
  // correlation-ID layer, applies the agent's reply content as a
  // `fiber_tree_delta` so the snapshot reflects the new state immediately,
  // and resolves so HttpApiKanban can build the refreshed card. The
  // agent-side fs.watch will fire its own delta moments later; double-apply
  // is idempotent because the second copy carries identical content.
  remoteTransitionExecutor: async ({ originId, path, target, nowIso }) => {
    const result = await agentRequestCoordinator.send<{ content?: string }>(
      originId,
      'kanban-transition',
      { path, target, nowIso },
    );
    if (typeof result.content === 'string') {
      fiberTreeSnapshotStore.applyDelta(originId, [
        { path, op: 'upsert', content: result.content },
      ]);
    }
  },
});
httpApi.setAnnotationPersistence(annotationPersistence);
httpApi.setSessionLookup(sessionLookup);
httpApi.setRecentFileTracker(recentFileTracker);
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
    },
    maps: {
      activeSearches: workspaceBrowser.getActiveSearchCount(),
      remoteSessionOrigins: remoteAgentCoordinator.getRemoteSessionOriginCount(),
      remoteGitStatuses: remoteAgentCoordinator.getRemoteGitStatusCount(),
      remoteActivities: remoteAgentCoordinator.getRemoteActivityStoreCount(),
      remoteActivityEvents: remoteAgentCoordinator.getRemoteActivityEventCount(),
    },
    intervals: {
      fiberRefreshActive: browserStateCoordinator.isFiberRefreshActive(),
      remoteWorkingTimeoutActive: remoteWorkingTimeoutIntervalHandle !== null,
    },
    eventWatcher: eventWatcher.getStats(),
    remoteWorkingSessions: remoteAgentCoordinator.getRemoteWorkingStats(),
    recentFiles: {
      sessionCount: recentFileTracker.getSessionCount(),
      entryCount: recentFileTracker.getTotalEntryCount(),
    },
    meetingBridge: meetingBridge.getState(),
  };
});
httpApi.setMeetingBridge(meetingBridge);
const kitty = new KittyIntegration(sessionLookup, originManager, cityLookup);
// Pane byte streaming for in-map terminal cards. Local sessions only in
// this iteration; remote support extends the same subscribe/fan-out
// interface through the portolan-agent tailer. See
// constitution-terminals-in-map.
const terminalStreamManager = new TerminalStreamManager();
const workspaceBrowser = new WorkspaceBrowser(cityManager, originManager, cityPersistence);
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
    reconnectTunnel,
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
  // Local sessions only for this iteration. Remote origins will plumb
  // through the agent in a successor constitution.
  if (session.originId !== LOCAL_ORIGIN_ID) return null;
  return session.tmuxSession;
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
  onTerminalAttach: (ws, sessionId) => {
    const tmuxSession = resolveLocalTmuxSession(sessionId);
    if (!tmuxSession) {
      ws.send(JSON.stringify({
        type: 'terminal:error',
        sessionId,
        error: 'session-not-found',
      }));
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
    const tmuxSession = resolveLocalTmuxSession(sessionId);
    if (!tmuxSession) return;
    terminalStreamManager.detach(tmuxSession, ws);
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
  const plannotatorPortParam = url.searchParams.get('plannotatorPort');
  const plannotatorPort = plannotatorPortParam ? parseInt(plannotatorPortParam, 10) : undefined;

  if (isAgent && originName) {
    // Agent connection — normalize origin name using sshHost when available
    // so different login nodes (login07.leonardo.local) map to the same origin (cineca).
    const effectiveOriginName = sshHost ? sshHost.replace(/-login\d+$/, '') : originName;
    const origin = originManager.registerAgent(effectiveOriginName, ws, sshHost, plannotatorPort);
    cityManager.setOriginPosition(origin.id, origin.position);
    // Track sshHost for city key normalization (so different login nodes share cities)
    if (sshHost) {
      cityManager.setOriginSshHost(origin.id, sshHost);
    }

    ws.send(JSON.stringify({
      type: 'connected',
      payload: { originId: origin.id, position: origin.position },
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
            files: Array<{ path: string; content: string }>;
          };
          fiberTreeSnapshotStore.upsertFullDump(origin.id, feltHost, files ?? []);
          console.log(
            `[FiberTree] full dump from ${origin.id}: ${(files ?? []).length} files at ${feltHost}`,
          );
          // The kanban view rebuilds per request, so we don't need to push;
          // browsers polling /kanban will pick up the new state on next read.
        } else if (message.type === 'fiber_tree_delta') {
          const { deltas } = message.payload as {
            deltas: Array<{ path: string; op: 'upsert' | 'delete'; content?: string }>;
          };
          fiberTreeSnapshotStore.applyDelta(origin.id, deltas ?? []);
        } else if (message.type === 'kanban-transition-result') {
          // Stage 4 — agent's reply to a `kanban-transition` round-trip.
          // Resolves or rejects the matching pending entry in the
          // coordinator; the executor in HttpApi then applies the delta
          // and HttpApiKanban builds the refreshed card.
          const { correlationId, ok, error, content } = message.payload as {
            correlationId: string;
            ok: boolean;
            error?: string;
            content?: string;
          };
          agentRequestCoordinator.handleResult(
            correlationId,
            !!ok,
            content !== undefined ? { content } : {},
            error,
          );
        }
      } catch (error) {
        console.error('Failed to handle agent message:', error);
      }
    });

    ws.on('close', () => {
      const disconnectedOrigin = originManager.handleDisconnect(ws);
      if (disconnectedOrigin) {
        remoteAgentCoordinator.handleAgentDisconnect(disconnectedOrigin.id, disconnectedOrigin.sshHost);
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
    }
  }

  browserStateCoordinator.broadcastActivity(activity, LOCAL_ORIGIN_ID);
});
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
});

// ============================================================================
// Shuttle — fiber-as-ticket dispatcher
// ============================================================================
//
// Polls every pinned local-origin city for constitution-tagged, non-draft,
// unblocked, status!=closed fibers, dedupes by realpath of the fiber's md
// file, and dispatches one single-shot worker per eligible fiber. Per the
// constitution-shuttle invariants, Shuttle never edits fibers — agents do.
//
// Multi-host alignment: the kanban view (HttpApiKanban) walks the same set
// of pinned cities with the same realpath dedupe, so a constitution that
// shows up as a card *also* gets a worker — and a fiber dispatched here is
// the same physical fiber the kanban displays. Each worker spawns with its
// contributing host as `cwd`, so `felt show <id>` from inside the worker
// resolves the right file even when ids collide across hosts (see
// gotchas/gotcha-kanban-fiber-id-collisions-across-cities).
//
// Default scope is unscoped (no queuePrefixes) now that draft-tag opt-out
// is in place. Override via SHUTTLE_QUEUE_PREFIXES env var (comma-separated).
// Set SHUTTLE_DISABLED=1 to skip startup entirely.
function pinnedLocalFeltHosts(): string[] {
  return cityPersistence
    .getCities()
    .filter(c => c.originId === 'local')
    .map(c => c.path);
}
const shuttleHosts = pinnedLocalFeltHosts();
const shuttle = (process.env.SHUTTLE_DISABLED === '1' || process.env.VITEST)
  ? null
  : new Shuttle({
      ...defaultShuttleConfig({
        feltHosts: shuttleHosts.length > 0 ? shuttleHosts : undefined,
        queuePrefixes: process.env.SHUTTLE_QUEUE_PREFIXES
          ? process.env.SHUTTLE_QUEUE_PREFIXES.split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
      }),
      // Stage 7 — suspend dispatch into fibers whose remote-origin
      // writer (a portolan-agent) is currently disconnected. The check
      // is a method call into the same FiberTreeSnapshotStore that
      // backs the kanban's remote-origin reads, so dispatch suspension
      // and the kanban's "waiting on <hostname>" badge stay aligned.
      staleOriginsForFiber: (id) => fiberTreeSnapshotStore.getStaleOriginsForFiber(id),
    });
if (shuttle) {
  shuttle.start();
  const scope = shuttleHosts.length > 0
    ? `${shuttleHosts.length} pinned local cities`
    : 'loom (no pins)';
  console.log(`[Shuttle] started — polling ${scope} for eligible constitution fibers`);
} else {
  console.log('[Shuttle] disabled via SHUTTLE_DISABLED=1');
}

let shuttingDown = false;

function stopBackgroundTimers(): void {
  browserStateCoordinator.stop();
  if (remoteWorkingTimeoutIntervalHandle) {
    clearInterval(remoteWorkingTimeoutIntervalHandle);
    remoteWorkingTimeoutIntervalHandle = null;
  }
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
  shuttle?.stop();
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
