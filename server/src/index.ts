/**
 * Portolan Server
 *
 * Wires together all managers and serves state to browser via WebSocket.
 * HTTP endpoints handled by HttpApi, terminal commands by KittyIntegration,
 * message routing by MessageRouter.
 */

import { createServer } from 'http';
import { execFile } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { promisify } from 'util';

import { SessionTracker, Session } from './SessionTracker.js';
import { CityManager, City, SessionInfo } from './CityManager.js';
import { OriginManager, Origin } from './OriginManager.js';
import { CityPersistence } from './CityPersistence.js';
import { AnnotationPersistence } from './AnnotationPersistence.js';
import { GitStatusManager, GitStatus } from './GitStatusManager.js';
import { RecentFileTracker } from './RecentFileTracker.js';
import { countOpenFibers, getOpenFibers, getRecentlyClosed } from './FiberReader.js';
import { EventWatcher, type ActivityEvent } from './EventWatcher.js';
import { HttpApi } from './HttpApi.js';
import { KittyIntegration, expandHome, shellEscape } from './KittyIntegration.js';
import { MessageRouter, AgentActivityMessage } from './MessageRouter.js';
import { RemoteAgentCoordinator, reconnectTunnel } from './RemoteAgentCoordinator.js';
import { reconcilePreviousLocalSessions } from './PreviousSessionReconciler.js';
import { WorkspaceBrowser } from './WorkspaceBrowser.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

interface StateUpdate {
  cities: City[];
  sessions: Session[];
  origins?: Origin[];
  activities?: Record<string, ActivityEvent[]>;  // activitySessionKey -> recent activities
}

// ============================================================================
// Constants
// ============================================================================

const PORT = process.env.VITEST ? 4099 : 4004;
const FIBER_REFRESH_INTERVAL = 10000; // 10 seconds
const LOCAL_ORIGIN_ID = 'local';
let fiberRefreshIntervalHandle: NodeJS.Timeout | null = null;
let remoteWorkingTimeoutIntervalHandle: NodeJS.Timeout | null = null;

function getActivitySessionKey(originId: string, tmuxSession: string): string {
  return `${originId}:${tmuxSession}`;
}

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

// Load persisted cities into CityManager
const persistedCities = cityPersistence.load();

// Load persisted annotations
annotationPersistence.load();
for (const pc of persistedCities) {
  // Set sshHost first so city keys are normalized correctly
  if (pc.sshHost && pc.originId !== 'local') {
    cityManager.setOriginSshHost(pc.originId, pc.sshHost);
  }
  cityManager.addPinnedCity(pc.id, pc.path, pc.name, pc.position, pc.originId);
}

const REMOTE_WORKING_TIMEOUT = 30_000; // 30 seconds, same as EventWatcher

// Track connected browser clients
const clients: Set<WebSocket> = new Set();

// Track last broadcast state for fiber count comparison
let lastBroadcastState: StateUpdate | null = null;

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
};

const cityLookup = {
  findCityByPath(path: string): City | undefined {
    return cityManager.getCities().find(c => c.path === path);
  },
  getSshHost(city: City): string | undefined {
    const origin = originManager.getOrigin(city.originId);
    const persistedCity = cityPersistence.getCityById(city.id);
    return origin?.sshHost || persistedCity?.sshHost || city.originId.replace('remote-', '');
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
      browserClients: clients.size,
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
      fiberRefreshActive: fiberRefreshIntervalHandle !== null,
      remoteWorkingTimeoutActive: remoteWorkingTimeoutIntervalHandle !== null,
    },
    eventWatcher: eventWatcher.getStats(),
    remoteWorkingSessions: remoteAgentCoordinator.getRemoteWorkingStats(),
    recentFiles: {
      sessionCount: recentFileTracker.getSessionCount(),
      entryCount: recentFileTracker.getTotalEntryCount(),
    },
  };
});
const kitty = new KittyIntegration(sessionLookup, originManager, cityLookup);
const workspaceBrowser = new WorkspaceBrowser(cityManager, originManager, cityPersistence);
const remoteAgentCoordinator = new RemoteAgentCoordinator(
  cityManager,
  originManager,
  recentFileTracker,
  previousSessions,
  {
    assignSessionToCity,
    broadcastActivity,
    broadcastState: () => {
      buildState().then(broadcast);
    },
    rebuildCities,
    reconnectTunnel,
  },
);

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

function getAllSessions(): Session[] {
  return sessionLookup.getAllSessions();
}

function getRemoteSessionCount(): number {
  return remoteAgentCoordinator.getRemoteSessionCount();
}

/**
 * Assign a session to a city, handling hex allocation and cleanup.
 * Releases previous hex if session is moving between cities.
 */
function assignSessionToCity(session: Session, city: City): void {
  const previousCityId = session.cityId;
  if (previousCityId !== city.id) {
    if (previousCityId && session.workerHex) {
      cityManager.releaseWorkerHex(previousCityId, session.workerHex);
    }
    session.cityId = city.id;
    session.workerHex = cityManager.assignWorkerHex(city.id);
  } else if (!session.workerHex) {
    session.workerHex = cityManager.assignWorkerHex(city.id);
  }
}

async function buildState(): Promise<StateUpdate> {
  const sessions = getAllSessions();
  const cities = cityManager.getCities();

  cityManager.updateClaimsStatus();
  cityManager.updatePlaygroundsStatus();

  const activeCityIds = new Set(sessions.filter(s => s.cityId).map(s => s.cityId));

  const citiesWithFibers = await Promise.all(
    cities.map(async (city) => {
      let gitStatus: GitStatus | undefined;
      if (city.originId === 'local') {
        gitStatus = gitStatusManager.getStatus(city.path) ?? undefined;
      } else {
        gitStatus = remoteAgentCoordinator.getGitStatus(city.originId, city.path);
      }

      return {
        ...city,
        fiberCount: city.originId === 'local' ? await countOpenFibers(city.path) : 0,
        hasClaims: city.hasClaims ?? false,
        hasPlaygrounds: city.hasPlaygrounds ?? false,
        isDormant: !activeCityIds.has(city.id),
        gitStatus,
      };
    })
  );

  const cityMap = new Map(cities.map((c) => [c.id, c]));

  const sessionsWithAbsoluteHex = sessions.map((session) => {
    if (session.workerHex && session.cityId) {
      const city = cityMap.get(session.cityId);
      if (city) {
        return {
          ...session,
          workerHex: {
            q: city.position.q + session.workerHex.q,
            r: city.position.r + session.workerHex.r,
          },
        };
      }
    }
    return session;
  });

  // Collect recent activities for each session
  const activities: Record<string, ActivityEvent[]> = {};
  for (const session of sessions) {
    const activitySessionKey = getActivitySessionKey(session.originId, session.tmuxSession);
    const sessionActivities = session.originId === LOCAL_ORIGIN_ID
      ? eventWatcher.getRecentActivities(session.tmuxSession)
      : remoteAgentCoordinator.getActivities(session.originId, session.tmuxSession);
    if (sessionActivities.length > 0) {
      activities[activitySessionKey] = sessionActivities;
    }
  }

  return {
    cities: citiesWithFibers,
    sessions: sessionsWithAbsoluteHex,
    origins: originManager.getOrigins(),
    activities,
  };
}

function broadcast(state: StateUpdate): void {
  const message = JSON.stringify(state);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
  lastBroadcastState = state;
}

function broadcastActivity(activity: ActivityEvent, originId: string): void {
  const message = JSON.stringify({
    type: 'activity',
    activity: {
      ...activity,
      originId,
      activitySessionKey: getActivitySessionKey(originId, activity.tmuxSession),
    },
  });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function fiberCountsChanged(oldState: StateUpdate | null, newState: StateUpdate): boolean {
  if (!oldState) return true;
  if (oldState.cities.length !== newState.cities.length) return true;
  for (const newCity of newState.cities) {
    const oldCity = oldState.cities.find((c) => c.id === newCity.id);
    if (!oldCity || oldCity.fiberCount !== newCity.fiberCount) return true;
  }
  return false;
}

async function refreshFiberCounts(): Promise<void> {
  const state = await buildState();
  if (fiberCountsChanged(lastBroadcastState, state)) {
    console.log('Fiber counts changed, broadcasting update');
    broadcast(state);
  }
}

function rebuildCities(): void {
  const allSessions = getAllSessions();
  const sessionInfos: SessionInfo[] = allSessions
    .filter(s => s.cwd)
    .map(s => ({ cwd: s.cwd, originId: s.originId }));
  cityManager.updateFromSessions(sessionInfos);

  for (const city of cityManager.getCities()) {
    if (!cityManager.isPinned(city.id)) {
      const sshHost = city.originId !== 'local'
        ? originManager.getOrigin(city.originId)?.sshHost
        : undefined;
      cityPersistence.pin(city.path, city.position, city.originId, city.name, sshHost);
      cityManager.addPinnedCity(city.id, city.path, city.name, city.position, city.originId);
    } else if (city.originId !== 'local') {
      const origin = originManager.getOrigin(city.originId);
      const persistedCity = cityPersistence.getCityById(city.id);
      if (origin?.sshHost && persistedCity && !persistedCity.sshHost) {
        cityPersistence.pin(city.path, city.position, city.originId, city.name, origin.sshHost);
      }
    }

    if (city.originId === 'local') {
      gitStatusManager.track(city.path);
    }
  }
}

// ============================================================================
// Session Change Handler (Local Sessions)
// ============================================================================

sessionTracker.onSessionsChange((localSessions) => {
  eventWatcher.reconcileActiveSessions(localSessions.map(session => session.tmuxSession));

  const removedLocalSessions = reconcilePreviousLocalSessions(
    previousSessions,
    localSessions,
    LOCAL_ORIGIN_ID,
  );

  for (const removedSession of removedLocalSessions) {
    if (removedSession.cityId && removedSession.workerHex) {
      cityManager.releaseWorkerHex(removedSession.cityId, removedSession.workerHex);
    }
    recentFileTracker.removeSession(removedSession.id);
  }

  rebuildCities();

  for (const session of localSessions) {
    if (!session.cwd) continue;
    const city = cityManager.findCityForPath(session.cwd, session.originId);
    if (!city) continue;

    assignSessionToCity(session, city);
  }

  buildState().then(broadcast);
});
// ============================================================================
// Remote Session Handling
// ============================================================================

// ============================================================================
// Message Handlers
// ============================================================================

async function handleGetFibers(ws: WebSocket, cityId: string): Promise<void> {
  const city = cityManager.getCityById(cityId);
  if (!city) {
    ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
    return;
  }

  try {
    if (city.originId === 'local') {
      const [open, recentlyClosed] = await Promise.all([
        getOpenFibers(city.path),
        getRecentlyClosed(city.path, 5),
      ]);
      ws.send(JSON.stringify({ type: 'fibers', cityId, open, recentlyClosed }));
    } else {
      const origin = originManager.getOrigin(city.originId);
      if (!origin?.sshHost) {
        ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
        return;
      }
      const [open, recentlyClosed] = await Promise.all([
        getRemoteFibers(origin.sshHost, city.path, 'open'),
        getRemoteFibers(origin.sshHost, city.path, 'closed'),
      ]);
      ws.send(JSON.stringify({ type: 'fibers', cityId, open, recentlyClosed }));
    }
  } catch (error) {
    console.error('Failed to get fibers:', error);
    ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
  }
}

async function getRemoteFibers(
  sshHost: string,
  cityPath: string,
  status: 'open' | 'closed'
): Promise<Array<{ id: string; title: string; kind: string; status: string; body?: string; outcome?: string }>> {
  const escapedPath = shellEscape(cityPath);
  const statusFlag = status === 'open' ? '-s open' : '-s closed';
  const recentFlag = status === 'closed' ? '--recent 5' : '';

  try {
    const { stdout } = await execFileAsync(
      'ssh', [sshHost, `cd ${escapedPath} && felt ls ${statusFlag} ${recentFlag} --json --body 2>/dev/null || echo '[]'`],
      { timeout: 10000 }
    );
    const fibers = JSON.parse(stdout.trim() || '[]');
    return fibers.map((f: any) => ({
      id: f.id,
      title: f.title,
      kind: f.kind || 'task',
      status: f.status || status,
      body: f.body || undefined,
      outcome: f.outcome || f.close_reason || undefined,
    }));
  } catch (error) {
    console.error(`Failed to get remote fibers from ${sshHost}:${cityPath}:`, error);
    return [];
  }
}

function handlePinCity(
  ws: WebSocket,
  path: string,
  position: { q: number; r: number },
  name?: string
): void {
  try {
    const expandedPath = expandHome(path);
    const city = cityManager.pinCity(expandedPath, position, 'local', name);
    cityPersistence.pin(expandedPath, position, 'local', name || city.name);
    console.log(`City pinned: ${city.name} at (${position.q}, ${position.r})`);
    buildState().then(broadcast);
    ws.send(JSON.stringify({ type: 'cityPinned', city }));
  } catch (error) {
    console.error('Failed to pin city:', error);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to pin city' }));
  }
}

function handleUnpinCity(ws: WebSocket, cityId: string): void {
  try {
    const allSessions = getAllSessions();
    const city = cityManager.getCityById(cityId);
    if (!city) {
      ws.send(JSON.stringify({ type: 'error', message: 'City not found' }));
      return;
    }

    const sessionCount = allSessions.filter(
      (s) => s.cwd && s.cwd === city.path && s.originId === city.originId
    ).length;

    if (sessionCount > 0) {
      ws.send(JSON.stringify({
        type: 'confirmUnpin',
        cityId,
        cityName: city.name,
        sessionCount,
      }));
      return;
    }

    performUnpin(ws, cityId);
  } catch (error) {
    console.error('Failed to unpin city:', error);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to unpin city' }));
  }
}

function performUnpin(ws: WebSocket, cityId: string): void {
  const city = cityManager.getCityById(cityId);
  if (!city) return;

  cityManager.unpinCity(cityId);
  cityPersistence.unpin(cityId);
  console.log(`City unpinned: ${city.name}`);

  rebuildCities();
  buildState().then(broadcast);
  ws.send(JSON.stringify({ type: 'cityUnpinned', cityId }));
}

function handleMoveCity(
  ws: WebSocket,
  cityId: string,
  newPosition: { q: number; r: number }
): void {
  try {
    const city = cityManager.getCityById(cityId);
    if (!city) {
      ws.send(JSON.stringify({ type: 'error', message: 'City not found' }));
      return;
    }

    if (!cityManager.isPinned(cityId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Can only move pinned cities' }));
      return;
    }

    cityManager.moveCity(cityId, newPosition);
    cityPersistence.updatePosition(cityId, newPosition);
    console.log(`City moved: ${city.name} to (${newPosition.q}, ${newPosition.r})`);

    buildState().then(broadcast);
    ws.send(JSON.stringify({ type: 'cityMoved', cityId, newPosition }));
  } catch (error) {
    console.error('Failed to move city:', error);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to move city' }));
  }
}

// ============================================================================
// Message Router Setup
// ============================================================================

const messageRouter = new MessageRouter({
  onFocus: (sessionId) => kitty.focusSession(sessionId),
  onGetFibers: handleGetFibers,
  onHandoff: (fiberId, cityPath) => kitty.handoff(fiberId, cityPath),
  onNewWorker: (ws, cityPath, name, chrome, continueSession, cli) => kitty.newWorker(ws, cityPath, name, chrome, continueSession, cli),
  onPinCity: handlePinCity,
  onUnpinCity: handleUnpinCity,
  onConfirmUnpin: performUnpin,
  onKillWorker: (sessionId) => kitty.killWorker(sessionId),
  onSearchFiles: workspaceBrowser.handleSearchFiles.bind(workspaceBrowser),
  onMoveCity: handleMoveCity,
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
    // Agent connection
    const origin = originManager.registerAgent(originName, ws, sshHost, plannotatorPort);
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
        broadcast({ ...lastBroadcastState!, origins: originManager.getOrigins() });
      }
      console.log(`Agent disconnected: ${originName}`);
    });

    ws.on('error', (error) => console.error('Agent WebSocket error:', error));
  } else {
    // Browser client
    clients.add(ws);
    console.log('Browser client connected');

    const state = await buildState();
    ws.send(JSON.stringify(state));

    ws.on('message', (data) => messageRouter.routeClientMessage(ws, data.toString()));
    ws.on('close', () => {
      clients.delete(ws);
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

  broadcastActivity(activity, LOCAL_ORIGIN_ID);
});
eventWatcher.start();

gitStatusManager.setUpdateHandler(({ path, status }) => {
  console.log(`[Git] ${path}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`);
  buildState().then(broadcast);
});
gitStatusManager.start();

fiberRefreshIntervalHandle = setInterval(refreshFiberCounts, FIBER_REFRESH_INTERVAL);

// Check for remote session working timeouts
remoteWorkingTimeoutIntervalHandle = setInterval(() => {
  const changed = remoteAgentCoordinator.expireWorkingSessions(Date.now() - REMOTE_WORKING_TIMEOUT);
  if (changed) {
    buildState().then(broadcast);
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
  if (fiberRefreshIntervalHandle) {
    clearInterval(fiberRefreshIntervalHandle);
    fiberRefreshIntervalHandle = null;
  }
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
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
