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
import { RemoteAgentCoordinator, reconnectTunnel } from './RemoteAgentCoordinator.js';
import { WorkspaceBrowser } from './WorkspaceBrowser.js';
import { BrowserStateCoordinator } from './BrowserStateCoordinator.js';

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
const meetingBridge = new MeetingBridge();

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

const httpApi = new HttpApi(cityManager, originManager, cityPersistence);
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
        }
      } catch (error) {
        console.error('Failed to handle agent message:', error);
      }
    });

    ws.on('close', () => {
      const disconnectedOrigin = originManager.handleDisconnect(ws);
      if (disconnectedOrigin) {
        remoteAgentCoordinator.handleAgentDisconnect(disconnectedOrigin.id, disconnectedOrigin.sshHost);
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
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
