/**
 * Hexarchy Server
 *
 * Wires together SessionTracker, CityManager, OriginManager, and FiberReader.
 * Serves state to browser via WebSocket.
 * Handles focus commands from browser (local and remote).
 * Accepts agent connections for remote session discovery.
 */
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { execSync } from 'child_process';
import { URL } from 'url';
import { SessionTracker } from './SessionTracker.js';
import { CityManager } from './CityManager.js';
import { OriginManager } from './OriginManager.js';
import { countOpenFibers } from './FiberReader.js';
// ============================================================================
// Constants
// ============================================================================
const PORT = 4004;
const FIBER_REFRESH_INTERVAL = 10000; // 10 seconds
// ============================================================================
// Initialization
// ============================================================================
const cityManager = new CityManager();
const sessionTracker = new SessionTracker();
const originManager = new OriginManager();
// Track remote sessions: Map<originId, Map<tmuxSession, Session>>
const remoteSessions = new Map();
// Create HTTP server (no express needed for now)
const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hexarchy server running\n');
});
// Create WebSocket server
const wss = new WebSocketServer({ server });
// Track connected clients (browser clients only, not agents)
const clients = new Set();
// Track last broadcast state for fiber count comparison
let lastBroadcastState = null;
// Track previous sessions to detect removals
let previousSessions = new Map();
// ============================================================================
// State Management
// ============================================================================
/**
 * Get all sessions (local + remote)
 */
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
/**
 * Build current state with fiber counts and cityIds
 */
async function buildState() {
    const sessions = getAllSessions();
    const cities = cityManager.getCities();
    // Add fiber counts to cities (await all in parallel)
    // Only count fibers for local cities (remote fiber counting not supported)
    const citiesWithFibers = await Promise.all(cities.map(async (city) => ({
        ...city,
        fiberCount: city.originId === 'local' ? await countOpenFibers(city.path) : 0,
    })));
    // Build city lookup map for worker hex offset calculation
    const cityMap = new Map(cities.map((c) => [c.id, c]));
    // Transform sessions: offset workerHex by city position
    const sessionsWithAbsoluteHex = sessions.map((session) => {
        if (session.workerHex && session.cityId) {
            const city = cityMap.get(session.cityId);
            if (city) {
                // Add city position to relative worker hex
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
/**
 * Broadcast state to all connected browser clients
 */
function broadcast(state) {
    const message = JSON.stringify(state);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
    lastBroadcastState = state;
}
/**
 * Check if fiber counts have changed between two states
 */
function fiberCountsChanged(oldState, newState) {
    if (!oldState)
        return true;
    // If city count changed, definitely different
    if (oldState.cities.length !== newState.cities.length)
        return true;
    // Compare fiber counts for each city
    for (const newCity of newState.cities) {
        const oldCity = oldState.cities.find((c) => c.id === newCity.id);
        if (!oldCity || oldCity.fiberCount !== newCity.fiberCount) {
            return true;
        }
    }
    return false;
}
/**
 * Periodically refresh fiber counts and broadcast if changed
 */
async function refreshFiberCounts() {
    const state = await buildState();
    if (fiberCountsChanged(lastBroadcastState, state)) {
        console.log('Fiber counts changed, broadcasting update');
        broadcast(state);
    }
}
/**
 * Rebuild cities from all sessions (local + remote)
 */
function rebuildCities() {
    const allSessions = getAllSessions();
    const sessionInfos = allSessions
        .filter(s => s.cwd)
        .map(s => ({ cwd: s.cwd, originId: s.originId }));
    cityManager.updateFromSessions(sessionInfos);
}
// ============================================================================
// Session Change Handler (Local Sessions)
// ============================================================================
/**
 * Handle session changes from SessionTracker (local sessions only)
 * Updates cityIds, auto-creates cities, assigns worker hexes, removes orphaned cities, broadcasts state
 */
sessionTracker.onSessionsChange((localSessions) => {
    // Build map of current sessions for quick lookup
    const currentSessionsMap = new Map();
    for (const session of localSessions) {
        currentSessionsMap.set(session.id, session);
    }
    // Release worker hexes for removed sessions
    for (const [sessionId, prevSession] of previousSessions) {
        // Only handle local sessions here
        if (prevSession.originId !== 'local')
            continue;
        if (!currentSessionsMap.has(sessionId)) {
            if (prevSession.cityId && prevSession.workerHex) {
                cityManager.releaseWorkerHex(prevSession.cityId, prevSession.workerHex);
            }
        }
    }
    // Rebuild cities from all sessions (local + remote)
    rebuildCities();
    // Assign cityIds and worker hexes for local sessions
    for (const session of localSessions) {
        if (!session.cwd)
            continue;
        const city = cityManager.findCityForPath(session.cwd, session.originId);
        if (!city)
            continue; // shouldn't happen since we just updated from cwds
        const previousCityId = session.cityId;
        if (previousCityId !== city.id) {
            // City changed - release old worker hex if it exists
            if (previousCityId && session.workerHex) {
                cityManager.releaseWorkerHex(previousCityId, session.workerHex);
            }
            // Assign new city and worker hex
            session.cityId = city.id;
            session.workerHex = cityManager.assignWorkerHex(city.id);
        }
        else if (!session.workerHex) {
            // Same city but no worker hex assigned yet
            session.workerHex = cityManager.assignWorkerHex(city.id);
        }
    }
    // Update previousSessions for next change detection (local only)
    for (const session of localSessions) {
        previousSessions.set(session.id, session);
    }
    // Broadcast updated state
    buildState().then(broadcast);
});
// ============================================================================
// Remote Session Handling
// ============================================================================
/**
 * Handle sessions update from a remote agent
 */
function handleAgentSessionsUpdate(originId, agentSessions) {
    // Get or create sessions map for this origin
    if (!remoteSessions.has(originId)) {
        remoteSessions.set(originId, new Map());
    }
    const originSessionsMap = remoteSessions.get(originId);
    // Build set of tmux session names from the update
    const updatedTmuxSessions = new Set(agentSessions.map(s => s.tmuxSession));
    // Release worker hexes for removed sessions
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
    // Update or add sessions
    for (const agentSession of agentSessions) {
        const existing = originSessionsMap.get(agentSession.tmuxSession);
        if (existing) {
            // Update existing session
            existing.cwd = agentSession.cwd;
            existing.status = agentSession.status || 'idle';
            existing.lastActivity = Date.now();
        }
        else {
            // New session
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
    // Rebuild cities from all sessions
    rebuildCities();
    // Assign cityIds and worker hexes for remote sessions
    for (const session of originSessionsMap.values()) {
        if (!session.cwd)
            continue;
        const city = cityManager.findCityForPath(session.cwd, session.originId);
        if (!city)
            continue;
        const previousCityId = session.cityId;
        if (previousCityId !== city.id) {
            // City changed
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
    // Broadcast updated state
    buildState().then(broadcast);
}
/**
 * Handle agent disconnection - mark sessions offline or remove them
 */
function handleAgentDisconnect(originId) {
    const originSessionsMap = remoteSessions.get(originId);
    if (!originSessionsMap)
        return;
    // If origin is fully disconnected, remove all its sessions
    if (!originManager.isOriginConnected(originId)) {
        for (const session of originSessionsMap.values()) {
            if (session.cityId && session.workerHex) {
                cityManager.releaseWorkerHex(session.cityId, session.workerHex);
            }
            previousSessions.delete(session.id);
        }
        remoteSessions.delete(originId);
        console.log(`All sessions removed for disconnected origin: ${originId}`);
        // Rebuild cities and broadcast
        rebuildCities();
        buildState().then(broadcast);
    }
}
// ============================================================================
// WebSocket Handling
// ============================================================================
wss.on('connection', async (ws, req) => {
    // Check if this is an agent connection
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const isAgent = url.searchParams.get('agent') === 'true';
    const originName = url.searchParams.get('origin');
    const sshHost = url.searchParams.get('sshHost') || undefined;
    if (isAgent && originName) {
        // This is an agent connection
        const origin = originManager.registerAgent(originName, ws, sshHost);
        // Register origin position with city manager
        cityManager.setOriginPosition(origin.id, origin.position);
        // Send connection confirmation
        ws.send(JSON.stringify({
            type: 'connected',
            payload: { originId: origin.id, position: origin.position },
        }));
        console.log(`Agent connected: ${originName} (${origin.id})`);
        // Handle agent messages
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'agent_sessions_update') {
                    const agentMsg = message;
                    handleAgentSessionsUpdate(origin.id, agentMsg.payload.sessions);
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
                // Broadcast origin disconnect to clients
                broadcast({
                    ...lastBroadcastState,
                    origins: originManager.getOrigins(),
                });
            }
            console.log(`Agent disconnected: ${originName}`);
        });
        ws.on('error', (error) => {
            console.error('Agent WebSocket error:', error);
        });
    }
    else {
        // This is a browser client
        clients.add(ws);
        console.log('Browser client connected');
        // Send initial state
        const state = await buildState();
        ws.send(JSON.stringify(state));
        // Handle messages from client
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'focus') {
                    focusSession(message.sessionId);
                }
            }
            catch (error) {
                console.error('Failed to handle message:', error);
            }
        });
        ws.on('close', () => {
            clients.delete(ws);
            console.log('Browser client disconnected');
        });
        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }
});
// ============================================================================
// Kitty Focus Integration
// ============================================================================
/**
 * Escape shell arguments for safe use in commands
 * Wraps argument in single quotes and escapes any single quotes within
 */
function shellEscape(arg) {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}
/**
 * Focus a tmux session in Kitty
 * For local sessions: focus or create a tab
 * For remote sessions: SSH to the remote and attach to tmux
 */
function focusSession(sessionId) {
    // Find session in local or remote
    const allSessions = getAllSessions();
    const session = allSessions.find((s) => s.id === sessionId);
    if (!session) {
        console.error(`Session not found: ${sessionId}`);
        return;
    }
    const socket = process.env.KITTY_LISTEN_ON || 'unix:/tmp/kitty-socket';
    const tmuxSession = session.tmuxSession;
    const escapedSession = shellEscape(tmuxSession);
    if (session.originId === 'local') {
        // Local session - existing logic
        const escapedCwd = shellEscape(session.cwd);
        try {
            // Try to focus existing tab
            execSync(`kitty @ --to ${socket} focus-tab --match title:${escapedSession}`, {
                stdio: 'ignore',
            });
            console.log(`Focused tab: ${tmuxSession}`);
        }
        catch {
            // No tab exists - create one with correct working directory
            try {
                execSync(`kitty @ --to ${socket} launch --type=tab --cwd=${escapedCwd} --title=${escapedSession} tmux attach -t ${escapedSession}`, { stdio: 'ignore' });
                console.log(`Launched new tab: ${tmuxSession} in ${session.cwd}`);
            }
            catch (error) {
                console.error(`Failed to launch tab for ${tmuxSession}:`, error);
            }
        }
    }
    else {
        // Remote session - SSH + tmux attach
        const origin = originManager.getOrigin(session.originId);
        if (!origin || !origin.sshHost) {
            console.error(`Cannot focus remote session: no sshHost for origin ${session.originId}`);
            return;
        }
        const sshHost = origin.sshHost;
        const tabTitle = `${tmuxSession}@${origin.name}`;
        const escapedTabTitle = shellEscape(tabTitle);
        try {
            // Try to focus existing tab with remote session
            execSync(`kitty @ --to ${socket} focus-tab --match title:${escapedTabTitle}`, {
                stdio: 'ignore',
            });
            console.log(`Focused remote tab: ${tabTitle}`);
        }
        catch {
            // No tab exists - create one with SSH + tmux attach
            try {
                // Use ssh -t to allocate TTY for tmux
                const sshCommand = `ssh -t ${shellEscape(sshHost)} tmux attach -t ${escapedSession}`;
                execSync(`kitty @ --to ${socket} launch --type=tab --title=${escapedTabTitle} ${sshCommand}`, { stdio: 'ignore' });
                console.log(`Launched remote tab: ${tabTitle} via ${sshHost}`);
            }
            catch (error) {
                console.error(`Failed to launch remote tab for ${tmuxSession}:`, error);
            }
        }
    }
    // Bring Kitty to front
    try {
        execSync(`osascript -e 'tell app "kitty" to activate'`, { stdio: 'ignore' });
    }
    catch (error) {
        console.error('Failed to activate Kitty:', error);
    }
}
// ============================================================================
// Startup
// ============================================================================
// Start session tracking (poll every 2 seconds)
sessionTracker.start(2000);
// Start fiber count refresh interval
setInterval(refreshFiberCounts, FIBER_REFRESH_INTERVAL);
// Start HTTP server
server.listen(PORT, () => {
    console.log(`Hexarchy server running on port ${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
});
// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    sessionTracker.stop();
    server.close();
    process.exit(0);
});
//# sourceMappingURL=index.js.map