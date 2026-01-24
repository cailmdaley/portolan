/**
 * Hexarchy Server
 *
 * Wires together all managers and serves state to browser via WebSocket.
 * HTTP endpoints handled by HttpApi, terminal commands by KittyIntegration,
 * message routing by MessageRouter.
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Track active file searches for cancellation
const activeSearches = new Map<string, ChildProcess>();

// Check which search tools are available (cached)
let hasFd: boolean | null = null;
let hasRg: boolean | null = null;

async function checkSearchTools(): Promise<void> {
  if (hasFd === null) {
    try {
      await execAsync('which fd');
      hasFd = true;
    } catch {
      hasFd = false;
    }
  }
  if (hasRg === null) {
    try {
      await execAsync('which rg');
      hasRg = true;
    } catch {
      hasRg = false;
    }
  }
}

// Initialize on startup
checkSearchTools();

import { SessionTracker, Session } from './SessionTracker.js';
import { CityManager, City, SessionInfo } from './CityManager.js';
import { OriginManager, Origin } from './OriginManager.js';
import { CityPersistence } from './CityPersistence.js';
import { AnnotationPersistence } from './AnnotationPersistence.js';
import { GitStatusManager, GitStatus } from './GitStatusManager.js';
import { countOpenFibers, getOpenFibers, getRecentlyClosed } from './FiberReader.js';
import { EventWatcher, type ActivityEvent } from './EventWatcher.js';
import { HttpApi } from './HttpApi.js';
import { KittyIntegration, expandHome, shellEscape } from './KittyIntegration.js';
import { MessageRouter, AgentSessionsUpdateMessage, AgentActivityMessage } from './MessageRouter.js';

// ============================================================================
// Types
// ============================================================================

interface StateUpdate {
  cities: City[];
  sessions: Session[];
  origins?: Origin[];
  activities?: Record<string, ActivityEvent[]>;  // tmuxSession -> recent activities
}

// ============================================================================
// Constants
// ============================================================================

const PORT = 4004;
const FIBER_REFRESH_INTERVAL = 10000; // 10 seconds

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

// Track remote sessions: Map<originId, Map<tmuxSession, Session>>
const remoteSessions = new Map<string, Map<string, Session>>();

// Track remote git statuses: Map<"originId:path", GitStatus>
const remoteGitStatuses = new Map<string, GitStatus>();

// Track remote activities: Map<tmuxSession, ActivityEvent[]>
const remoteActivities = new Map<string, ActivityEvent[]>();
const MAX_REMOTE_ACTIVITIES = 10;

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
    for (const originSessions of remoteSessions.values()) {
      for (const session of originSessions.values()) {
        if (session.id === sessionId) return session;
      }
    }
    return undefined;
  },
  findLocalSession(sessionId: string): Session | undefined {
    return sessionTracker.getSessions().find(s => s.id === sessionId);
  },
  // Alias for HttpApi
  getSessionById(sessionId: string): Session | undefined {
    return this.findSession(sessionId);
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
const kitty = new KittyIntegration(sessionLookup, originManager, cityLookup);

// Callback for creating new workers (used by send-annotations endpoint)
httpApi.setOnCreateNewWorker(async (cityPath: string, originId: string) => {
  const city = cityManager.getCities().find(c => c.path === cityPath || cityPath.startsWith(c.path + '/'));
  const isRemote = originId !== 'local' && !!originId;

  // Get SSH host for remote cities
  let sshHost: string | undefined;
  if (isRemote && city) {
    sshHost = cityLookup.getSshHost(city);
  }

  // Generate session name
  const baseName = cityPath.split('/').pop() || 'worker';
  const timestamp = Date.now().toString(36).slice(-4);
  const tmuxSession = `${baseName}-${timestamp}`;
  const escapedSession = shellEscape(tmuxSession);
  const escapedCwd = shellEscape(cityPath);

  if (isRemote && sshHost) {
    // Remote: create tmux session on remote via SSH
    const remoteTmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'bash -l -c "claude --dangerously-skip-permissions"'`;
    const sshCmd = `ssh -T ${sshHost} ${shellEscape(remoteTmuxCmd)}`;
    console.log('[CreateWorker] Creating remote tmux session:', sshCmd);
    execSync(sshCmd, { stdio: 'pipe', timeout: 30000 });

    // Open kitty tab that SSH's to remote and attaches to tmux
    const socket = kitty.getSocket();
    const tabTitle = `${tmuxSession}@${city?.originId.replace('remote-', '') || 'remote'}`;
    const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
    const kittyCmd = `kitty @ --to ${socket} launch --type=tab ${sshAuthSock} --title=${shellEscape(tabTitle)} ssh -tt ${sshHost} tmux attach -t ${escapedSession}`;
    console.log('[CreateWorker] Opening kitty tab with SSH:', kittyCmd);
    execSync(kittyCmd, { stdio: 'pipe' });

    // Focus the newly created tab
    const exactTitleMatch = shellEscape(`^${tabTitle}$`);
    execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

    console.log(`[CreateWorker] Launched remote worker: ${tmuxSession} on ${sshHost}:${cityPath}`);
  } else {
    // Local: create tmux session locally
    const tmuxCmd = `tmux new-session -d -s ${escapedSession} -c ${escapedCwd} 'zsh -l -c "claude --dangerously-skip-permissions"'`;
    console.log('[CreateWorker] Creating local tmux session:', tmuxCmd);
    execSync(tmuxCmd, { stdio: 'pipe' });

    // Open kitty tab attached to the tmux session
    const socket = kitty.getSocket();
    const kittyCmd = `kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`;
    console.log('[CreateWorker] Opening kitty tab:', kittyCmd);
    execSync(kittyCmd, { stdio: 'pipe' });

    // Focus the newly created tab
    const exactTitleMatch = shellEscape(`^${tmuxSession}$`);
    execSync(`kitty @ --to ${socket} focus-tab --match title:${exactTitleMatch}`, { stdio: 'ignore' });

    console.log(`[CreateWorker] Launched local worker: ${tmuxSession} in ${cityPath}`);
  }

  kitty.activateKitty();
  return tmuxSession;
});

// ============================================================================
// State Management
// ============================================================================

function getAllSessions(): Session[] {
  const local = sessionTracker.getSessions();
  const remote: Session[] = [];
  for (const originSessions of remoteSessions.values()) {
    for (const session of originSessions.values()) {
      remote.push(session);
    }
  }
  return [...local, ...remote];
}

async function buildState(): Promise<StateUpdate> {
  const sessions = getAllSessions();
  const cities = cityManager.getCities();

  cityManager.updateClaimsStatus();

  const activeCityIds = new Set(sessions.filter(s => s.cityId).map(s => s.cityId));

  const citiesWithFibers = await Promise.all(
    cities.map(async (city) => {
      let gitStatus: GitStatus | undefined;
      if (city.originId === 'local') {
        gitStatus = gitStatusManager.getStatus(city.path) ?? undefined;
      } else {
        const remoteKey = `${city.originId}:${city.path}`;
        gitStatus = remoteGitStatuses.get(remoteKey);
      }

      return {
        ...city,
        fiberCount: city.originId === 'local' ? await countOpenFibers(city.path) : 0,
        hasClaims: city.hasClaims ?? false,
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
    const sessionActivities = eventWatcher.getRecentActivities(session.tmuxSession);
    if (sessionActivities.length > 0) {
      activities[session.tmuxSession] = sessionActivities;
    }
  }
  // Also include remote activities
  for (const [tmuxSession, acts] of remoteActivities) {
    if (acts.length > 0) {
      activities[tmuxSession] = acts;
    }
  }

  // Debug: check if session cityIds match any city id
  const hexarchyCity = citiesWithFibers.find(c => c.name === 'hexarchy-v2');
  const localSessions = sessionsWithAbsoluteHex.filter(s => s.originId === 'local');
  console.log('[buildState] hexarchy-v2 city id:', hexarchyCity?.id);
  console.log('[buildState] local session cityIds:', localSessions.map(s => ({ name: s.name, cityId: s.cityId })));

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

function broadcastActivity(activity: ActivityEvent): void {
  const message = JSON.stringify({ type: 'activity', activity });
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
  const currentSessionsMap = new Map<string, Session>();
  for (const session of localSessions) {
    currentSessionsMap.set(session.id, session);
  }

  for (const [sessionId, prevSession] of previousSessions) {
    if (prevSession.originId !== 'local') continue;
    if (!currentSessionsMap.has(sessionId)) {
      if (prevSession.cityId && prevSession.workerHex) {
        cityManager.releaseWorkerHex(prevSession.cityId, prevSession.workerHex);
      }
    }
  }

  rebuildCities();

  for (const session of localSessions) {
    if (!session.cwd) continue;
    const city = cityManager.findCityForPath(session.cwd, session.originId);
    if (!city) continue;

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

  for (const session of localSessions) {
    previousSessions.set(session.id, session);
  }

  buildState().then(broadcast);
});

// ============================================================================
// Remote Session Handling
// ============================================================================

function handleAgentSessionsUpdate(
  originId: string,
  agentSessions: AgentSessionsUpdateMessage['payload']['sessions']
): void {
  if (!remoteSessions.has(originId)) {
    remoteSessions.set(originId, new Map());
  }
  const originSessionsMap = remoteSessions.get(originId)!;
  const updatedTmuxSessions = new Set(agentSessions.map(s => s.tmuxSession));

  for (const [tmuxSession, session] of originSessionsMap) {
    if (!updatedTmuxSessions.has(tmuxSession)) {
      if (session.cityId && session.workerHex) {
        cityManager.releaseWorkerHex(session.cityId, session.workerHex);
      }
      originSessionsMap.delete(tmuxSession);
      previousSessions.delete(session.id);
      console.log(`Remote session removed: ${session.name} from ${originId}`);
    }
  }

  for (const agentSession of agentSessions) {
    const existing = originSessionsMap.get(agentSession.tmuxSession);
    if (existing) {
      existing.cwd = agentSession.cwd;
      existing.status = agentSession.status || 'idle';
      existing.lastActivity = Date.now();
    } else {
      const session: Session = {
        id: `remote-${originId}-${agentSession.tmuxSession}`,
        name: agentSession.name,
        tmuxSession: agentSession.tmuxSession,
        cwd: agentSession.cwd,
        status: agentSession.status || 'idle',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        originId,
      };
      originSessionsMap.set(agentSession.tmuxSession, session);
      console.log(`Remote session discovered: ${session.name} from ${originId}`);
    }
  }

  rebuildCities();

  const claimsByCwd = new Map<string, boolean>();
  for (const agentSession of agentSessions) {
    if (agentSession.hasClaims !== undefined) {
      claimsByCwd.set(agentSession.cwd, agentSession.hasClaims);
    }
  }

  for (const agentSession of agentSessions) {
    if (agentSession.gitStatus) {
      const remoteKey = `${originId}:${agentSession.cwd}`;
      remoteGitStatuses.set(remoteKey, agentSession.gitStatus);
    }
  }

  for (const session of originSessionsMap.values()) {
    if (!session.cwd) continue;
    const city = cityManager.findCityForPath(session.cwd, session.originId);
    if (!city) continue;

    const hasClaims = claimsByCwd.get(session.cwd);
    if (hasClaims !== undefined) {
      city.hasClaims = hasClaims;
    }

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

    previousSessions.set(session.id, session);
  }

  buildState().then(broadcast);
}

function handleAgentDisconnect(originId: string): void {
  const originSessionsMap = remoteSessions.get(originId);
  if (!originSessionsMap) return;

  if (!originManager.isOriginConnected(originId)) {
    for (const session of originSessionsMap.values()) {
      if (session.cityId && session.workerHex) {
        cityManager.releaseWorkerHex(session.cityId, session.workerHex);
      }
      previousSessions.delete(session.id);
    }
    remoteSessions.delete(originId);
    rebuildCities();
    buildState().then(broadcast);
  }
}

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
): Promise<Array<{ id: string; title: string; kind: string; status: string; body?: string; reason?: string }>> {
  const escapedPath = shellEscape(cityPath);
  const statusFlag = status === 'open' ? '-s open' : '-s closed';
  const recentFlag = status === 'closed' ? '--recent 5' : '';

  try {
    const { stdout } = await execAsync(
      `ssh ${shellEscape(sshHost)} "cd ${escapedPath} && felt ls ${statusFlag} ${recentFlag} --json --body 2>/dev/null || echo '[]'"`,
      { timeout: 10000 }
    );
    const fibers = JSON.parse(stdout.trim() || '[]');
    return fibers.map((f: any) => ({
      id: f.id,
      title: f.title,
      kind: f.kind || 'task',
      status: f.status || status,
      body: f.body || undefined,
      reason: f.close_reason || undefined,
    }));
  } catch (error) {
    console.error(`Failed to get remote fibers from ${sshHost}:${cityPath}:`, error);
    return [];
  }
}

// ============================================================================
// File Search
// ============================================================================

interface SearchResult {
  path: string;        // Relative path from city root
  fullPath: string;    // Full path for opening
  line?: number;       // Line number (for content search)
  match?: string;      // Matching line content (for content search)
}

function handleSearchFiles(
  ws: WebSocket,
  cityId: string,
  query: string,
  searchId: string,
  mode: 'filename' | 'content' = 'filename'
): void {
  // Cancel any previous search with the same searchId prefix (same city)
  const citySearchPrefix = `${cityId}:`;
  for (const [key, proc] of activeSearches) {
    if (key.startsWith(citySearchPrefix)) {
      proc.kill();
      activeSearches.delete(key);
    }
  }

  const city = cityManager.getCityById(cityId);
  if (!city) {
    ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: 'City not found' }));
    return;
  }

  if (!query.trim()) {
    ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [] }));
    return;
  }

  const searchKey = `${cityId}:${searchId}`;

  if (city.originId === 'local') {
    searchLocal(ws, city.path, query, searchId, searchKey, mode);
  } else {
    const origin = originManager.getOrigin(city.originId);
    const persistedCity = cityPersistence.getCityById(city.id);
    const sshHost = origin?.sshHost || persistedCity?.sshHost;
    if (!sshHost) {
      ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: 'No SSH host for remote city' }));
      return;
    }
    searchRemote(ws, sshHost, city.path, query, searchId, searchKey, mode);
  }
}

function searchLocal(
  ws: WebSocket,
  cityPath: string,
  query: string,
  searchId: string,
  searchKey: string,
  mode: 'filename' | 'content'
): void {
  let proc: ChildProcess;
  const results: SearchResult[] = [];

  // Escape query for use in shell/regex (basic escaping)
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (mode === 'filename') {
    if (hasFd) {
      // Use fd (fast, --no-ignore to include gitignored files like build/)
      proc = spawn('fd', [
        '--type', 'f',
        '--hidden',
        '--no-ignore',
        '--exclude', '.git',
        '--exclude', 'node_modules',
        '--exclude', '__pycache__',
        '--color', 'never',
        query
      ], { cwd: cityPath });
    } else {
      // Fallback: find + grep
      const cmd = `find . -type f \\( -name '.git' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o -type f -print 2>/dev/null | grep -i '${safeQuery}' | head -50`;
      proc = spawn('sh', ['-c', cmd], { cwd: cityPath });
    }
  } else {
    if (hasRg) {
      // Use rg (fast, --no-ignore to include gitignored files like build/)
      proc = spawn('rg', [
        '--line-number',
        '--no-heading',
        '--color', 'never',
        '--max-count', '1',
        '--no-ignore',
        '--glob', '!.git',
        '--glob', '!node_modules',
        '--glob', '!__pycache__',
        query
      ], { cwd: cityPath });
    } else {
      // Fallback: grep -r
      const cmd = `grep -rn --include='*' -I '${safeQuery}' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ 2>/dev/null | head -50`;
      proc = spawn('sh', ['-c', cmd], { cwd: cityPath });
    }
  }

  activeSearches.set(searchKey, proc);

  let stdout = '';
  proc.stdout?.on('data', (data) => {
    stdout += data.toString();
  });

  proc.on('close', () => {
    activeSearches.delete(searchKey);

    // Parse results (limit to 50)
    const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 50);

    for (const line of lines) {
      if (mode === 'filename') {
        // Remove leading ./ from find/fd output
        const relativePath = line.startsWith('./') ? line.slice(2) : line;
        results.push({
          path: relativePath,
          fullPath: `${cityPath}/${relativePath}`,
        });
      } else {
        // rg/grep format: file:line:content or ./file:line:content
        const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/);
        if (match) {
          results.push({
            path: match[1],
            fullPath: `${cityPath}/${match[1]}`,
            line: parseInt(match[2], 10),
            match: match[3].trim().slice(0, 100),
          });
        }
      }
    }

    ws.send(JSON.stringify({ type: 'searchResults', searchId, results }));
  });

  proc.on('error', (error) => {
    activeSearches.delete(searchKey);
    console.error('Search error:', error);
    ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: error.message }));
  });
}

function searchRemote(
  ws: WebSocket,
  sshHost: string,
  cityPath: string,
  query: string,
  searchId: string,
  searchKey: string,
  mode: 'filename' | 'content'
): void {
  const escapedPath = shellEscape(cityPath);
  const escapedQuery = shellEscape(query);
  // Escape for shell and regex (for fallback grep)
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\'"]/g, '\\$&');

  // Try fd/rg first, fall back to find/grep
  // Remote machines may or may not have fd/rg installed
  // --no-ignore to include gitignored files (build/, dist/, etc.)
  let remoteCmd: string;
  if (mode === 'filename') {
    // Try fd, fall back to find+grep
    remoteCmd = `(fd --type f --hidden --no-ignore --exclude .git --exclude node_modules --exclude __pycache__ --color never ${escapedQuery} 2>/dev/null || find . -type f \\( -name '.git' -o -name 'node_modules' -o -name '__pycache__' \\) -prune -o -type f -print 2>/dev/null | grep -i '${safeQuery}') | head -50`;
  } else {
    // Try rg, fall back to grep
    remoteCmd = `(rg --line-number --no-heading --color never --max-count 1 --no-ignore --glob '!.git' --glob '!node_modules' --glob '!__pycache__' ${escapedQuery} 2>/dev/null || grep -rn --include='*' -I '${safeQuery}' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=__pycache__ 2>/dev/null) | head -50`;
  }

  const cmd = `ssh ${shellEscape(sshHost)} "cd ${escapedPath} && ${remoteCmd}"`;

  const proc = spawn('sh', ['-c', cmd]);
  activeSearches.set(searchKey, proc);

  let stdout = '';
  proc.stdout?.on('data', (data) => {
    stdout += data.toString();
  });

  proc.on('close', () => {
    activeSearches.delete(searchKey);
    const results: SearchResult[] = [];
    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      if (mode === 'filename') {
        const relativePath = line.startsWith('./') ? line.slice(2) : line;
        results.push({
          path: relativePath,
          fullPath: `${cityPath}/${relativePath}`,
        });
      } else {
        // rg/grep format: file:line:content or ./file:line:content
        const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/);
        if (match) {
          results.push({
            path: match[1],
            fullPath: `${cityPath}/${match[1]}`,
            line: parseInt(match[2], 10),
            match: match[3].trim().slice(0, 100),
          });
        }
      }
    }

    ws.send(JSON.stringify({ type: 'searchResults', searchId, results }));
  });

  proc.on('error', (error) => {
    activeSearches.delete(searchKey);
    ws.send(JSON.stringify({ type: 'searchResults', searchId, results: [], error: error.message }));
  });
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
  onNewWorker: (ws, cityPath, name) => kitty.newWorker(ws, cityPath, name),
  onPinCity: handlePinCity,
  onUnpinCity: handleUnpinCity,
  onConfirmUnpin: performUnpin,
  onKillWorker: (sessionId) => kitty.killWorker(sessionId),
  onSearchFiles: handleSearchFiles,
  onMoveCity: handleMoveCity,
});

// ============================================================================
// HTTP Server
// ============================================================================

const server = createServer(async (req, res) => {
  const handled = await httpApi.handleRequest(req, res);
  if (handled) return;

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hexarchy server running\n');
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
          handleAgentSessionsUpdate(origin.id, message.payload.sessions);
        } else if (message.type === 'agent_activity') {
          const activity = (message as AgentActivityMessage).activity;
          // Store remote activity
          let activities = remoteActivities.get(activity.tmuxSession);
          if (!activities) {
            activities = [];
            remoteActivities.set(activity.tmuxSession, activities);
          }
          activities.unshift(activity);
          if (activities.length > MAX_REMOTE_ACTIVITIES) {
            activities.pop();
          }
          broadcastActivity(activity);
        }
      } catch (error) {
        console.error('Failed to handle agent message:', error);
      }
    });

    ws.on('close', () => {
      const disconnectedOrigin = originManager.handleDisconnect(ws);
      if (disconnectedOrigin) {
        handleAgentDisconnect(disconnectedOrigin.id);
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
  broadcastActivity(activity);
});
eventWatcher.start();

gitStatusManager.setUpdateHandler(({ path, status }) => {
  console.log(`[Git] ${path}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`);
  buildState().then(broadcast);
});
gitStatusManager.start();

setInterval(refreshFiberCounts, FIBER_REFRESH_INTERVAL);

server.listen(PORT, () => {
  console.log(`Hexarchy server running on port ${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  sessionTracker.stop();
  gitStatusManager.stop();
  server.close();
  process.exit(0);
});
