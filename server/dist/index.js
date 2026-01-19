/**
 * Hexarchy Server
 *
 * Wires together all managers and serves state to browser via WebSocket.
 * HTTP endpoints handled by HttpApi, terminal commands by KittyIntegration,
 * message routing by MessageRouter.
 */
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { SessionTracker } from './SessionTracker.js';
import { CityManager } from './CityManager.js';
import { OriginManager } from './OriginManager.js';
import { CityPersistence } from './CityPersistence.js';
import { GitStatusManager } from './GitStatusManager.js';
import { countOpenFibers, getOpenFibers, getRecentlyClosed } from './FiberReader.js';
import { EventWatcher } from './EventWatcher.js';
import { HttpApi } from './HttpApi.js';
import { KittyIntegration, expandHome, shellEscape } from './KittyIntegration.js';
import { MessageRouter } from './MessageRouter.js';
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
const sessionTracker = new SessionTracker();
const originManager = new OriginManager();
const eventWatcher = new EventWatcher();
const gitStatusManager = new GitStatusManager();
// Load persisted cities into CityManager
const persistedCities = cityPersistence.load();
for (const pc of persistedCities) {
    cityManager.addPinnedCity(pc.id, pc.path, pc.name, pc.position, pc.originId);
}
// Track remote sessions: Map<originId, Map<tmuxSession, Session>>
const remoteSessions = new Map();
// Track remote git statuses: Map<"originId:path", GitStatus>
const remoteGitStatuses = new Map();
// Track connected browser clients
const clients = new Set();
// Track last broadcast state for fiber count comparison
let lastBroadcastState = null;
// Track previous sessions to detect removals
let previousSessions = new Map();
// ============================================================================
// Lookup Adapters (for extracted modules)
// ============================================================================
const sessionLookup = {
    findSession(sessionId) {
        const local = sessionTracker.getSessions().find(s => s.id === sessionId);
        if (local)
            return local;
        for (const originSessions of remoteSessions.values()) {
            for (const session of originSessions.values()) {
                if (session.id === sessionId)
                    return session;
            }
        }
        return undefined;
    },
    findLocalSession(sessionId) {
        return sessionTracker.getSessions().find(s => s.id === sessionId);
    },
};
const cityLookup = {
    findCityByPath(path) {
        return cityManager.getCities().find(c => c.path === path);
    },
    getSshHost(city) {
        const origin = originManager.getOrigin(city.originId);
        const persistedCity = cityPersistence.getCityById(city.id);
        return origin?.sshHost || persistedCity?.sshHost || city.originId.replace('remote-', '');
    },
};
// ============================================================================
// Extracted Modules
// ============================================================================
const httpApi = new HttpApi(cityManager, originManager, cityPersistence);
const kitty = new KittyIntegration(sessionLookup, originManager, cityLookup);
// ============================================================================
// State Management
// ============================================================================
function getAllSessions() {
    const local = sessionTracker.getSessions();
    const remote = [];
    for (const originSessions of remoteSessions.values()) {
        for (const session of originSessions.values()) {
            remote.push(session);
        }
    }
    return [...local, ...remote];
}
async function buildState() {
    const sessions = getAllSessions();
    const cities = cityManager.getCities();
    cityManager.updateClaimsStatus();
    const activeCityIds = new Set(sessions.filter(s => s.cityId).map(s => s.cityId));
    const citiesWithFibers = await Promise.all(cities.map(async (city) => {
        let gitStatus;
        if (city.originId === 'local') {
            gitStatus = gitStatusManager.getStatus(city.path) ?? undefined;
        }
        else {
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
    }));
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
    return {
        cities: citiesWithFibers,
        sessions: sessionsWithAbsoluteHex,
        origins: originManager.getOrigins(),
    };
}
function broadcast(state) {
    const message = JSON.stringify(state);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
    lastBroadcastState = state;
}
function broadcastActivity(activity) {
    const message = JSON.stringify({ type: 'activity', activity });
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}
function fiberCountsChanged(oldState, newState) {
    if (!oldState)
        return true;
    if (oldState.cities.length !== newState.cities.length)
        return true;
    for (const newCity of newState.cities) {
        const oldCity = oldState.cities.find((c) => c.id === newCity.id);
        if (!oldCity || oldCity.fiberCount !== newCity.fiberCount)
            return true;
    }
    return false;
}
async function refreshFiberCounts() {
    const state = await buildState();
    if (fiberCountsChanged(lastBroadcastState, state)) {
        console.log('Fiber counts changed, broadcasting update');
        broadcast(state);
    }
}
function rebuildCities() {
    const allSessions = getAllSessions();
    const sessionInfos = allSessions
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
        }
        else if (city.originId !== 'local') {
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
    const currentSessionsMap = new Map();
    for (const session of localSessions) {
        currentSessionsMap.set(session.id, session);
    }
    for (const [sessionId, prevSession] of previousSessions) {
        if (prevSession.originId !== 'local')
            continue;
        if (!currentSessionsMap.has(sessionId)) {
            if (prevSession.cityId && prevSession.workerHex) {
                cityManager.releaseWorkerHex(prevSession.cityId, prevSession.workerHex);
            }
        }
    }
    rebuildCities();
    for (const session of localSessions) {
        if (!session.cwd)
            continue;
        const city = cityManager.findCityForPath(session.cwd, session.originId);
        if (!city)
            continue;
        const previousCityId = session.cityId;
        if (previousCityId !== city.id) {
            if (previousCityId && session.workerHex) {
                cityManager.releaseWorkerHex(previousCityId, session.workerHex);
            }
            session.cityId = city.id;
            session.workerHex = cityManager.assignWorkerHex(city.id);
        }
        else if (!session.workerHex) {
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
function handleAgentSessionsUpdate(originId, agentSessions) {
    if (!remoteSessions.has(originId)) {
        remoteSessions.set(originId, new Map());
    }
    const originSessionsMap = remoteSessions.get(originId);
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
        }
        else {
            const session = {
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
    const claimsByCwd = new Map();
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
        if (!session.cwd)
            continue;
        const city = cityManager.findCityForPath(session.cwd, session.originId);
        if (!city)
            continue;
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
        }
        else if (!session.workerHex) {
            session.workerHex = cityManager.assignWorkerHex(city.id);
        }
        previousSessions.set(session.id, session);
    }
    buildState().then(broadcast);
}
function handleAgentDisconnect(originId) {
    const originSessionsMap = remoteSessions.get(originId);
    if (!originSessionsMap)
        return;
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
async function handleGetFibers(ws, cityId) {
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
        }
        else {
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
    }
    catch (error) {
        console.error('Failed to get fibers:', error);
        ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
    }
}
async function getRemoteFibers(sshHost, cityPath, status) {
    const escapedPath = shellEscape(cityPath);
    const statusFlag = status === 'open' ? '-s open' : '-s closed';
    const recentFlag = status === 'closed' ? '--recent 5' : '';
    try {
        const { stdout } = await execAsync(`ssh ${shellEscape(sshHost)} "cd ${escapedPath} && felt ls ${statusFlag} ${recentFlag} --json --body 2>/dev/null || echo '[]'"`, { timeout: 10000 });
        const fibers = JSON.parse(stdout.trim() || '[]');
        return fibers.map((f) => ({
            id: f.id,
            title: f.title,
            kind: f.kind || 'task',
            status: f.status || status,
            body: f.body || undefined,
            reason: f.close_reason || undefined,
        }));
    }
    catch (error) {
        console.error(`Failed to get remote fibers from ${sshHost}:${cityPath}:`, error);
        return [];
    }
}
function handlePinCity(ws, path, position, name) {
    try {
        const expandedPath = expandHome(path);
        const city = cityManager.pinCity(expandedPath, position, 'local', name);
        cityPersistence.pin(expandedPath, position, 'local', name || city.name);
        console.log(`City pinned: ${city.name} at (${position.q}, ${position.r})`);
        buildState().then(broadcast);
        ws.send(JSON.stringify({ type: 'cityPinned', city }));
    }
    catch (error) {
        console.error('Failed to pin city:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to pin city' }));
    }
}
function handleUnpinCity(ws, cityId) {
    try {
        const allSessions = getAllSessions();
        const city = cityManager.getCityById(cityId);
        if (!city) {
            ws.send(JSON.stringify({ type: 'error', message: 'City not found' }));
            return;
        }
        const sessionCount = allSessions.filter((s) => s.cwd && s.cwd === city.path && s.originId === city.originId).length;
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
    }
    catch (error) {
        console.error('Failed to unpin city:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to unpin city' }));
    }
}
function performUnpin(ws, cityId) {
    const city = cityManager.getCityById(cityId);
    if (!city)
        return;
    cityManager.unpinCity(cityId);
    cityPersistence.unpin(cityId);
    console.log(`City unpinned: ${city.name}`);
    rebuildCities();
    buildState().then(broadcast);
    ws.send(JSON.stringify({ type: 'cityUnpinned', cityId }));
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
});
// ============================================================================
// HTTP Server
// ============================================================================
const server = createServer(async (req, res) => {
    const handled = await httpApi.handleRequest(req, res);
    if (handled)
        return;
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
    if (isAgent && originName) {
        // Agent connection
        const origin = originManager.registerAgent(originName, ws, sshHost);
        cityManager.setOriginPosition(origin.id, origin.position);
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
                }
                else if (message.type === 'agent_activity') {
                    broadcastActivity(message.activity);
                }
            }
            catch (error) {
                console.error('Failed to handle agent message:', error);
            }
        });
        ws.on('close', () => {
            const disconnectedOrigin = originManager.handleDisconnect(ws);
            if (disconnectedOrigin) {
                handleAgentDisconnect(disconnectedOrigin.id);
                broadcast({ ...lastBroadcastState, origins: originManager.getOrigins() });
            }
            console.log(`Agent disconnected: ${originName}`);
        });
        ws.on('error', (error) => console.error('Agent WebSocket error:', error));
    }
    else {
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
//# sourceMappingURL=index.js.map