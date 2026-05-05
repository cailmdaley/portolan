#!/usr/bin/env node
/**
 * Portolan Remote Agent
 *
 * Lightweight agent that runs on remote machines to bridge Claude Code sessions
 * to a local portolan server via SSH tunnel.
 *
 * Usage:
 *   portolan-agent connect [host:port] [--ssh-host=name]
 *   portolan-agent status
 *
 * The agent:
 * 1. Discovers local tmux sessions running Claude Code
 * 2. Connects to portolan server (default localhost:4004, tunneled from local)
 * 3. Registers with the hostname as origin
 * 4. Sends periodic session updates
 *
 * SSH tunnel setup (on local machine's ~/.ssh/config):
 *   Host remotebox
 *     RemoteForward 4004 127.0.0.1:4004
 */

import WebSocket from 'ws';
import { exec, execFile, spawn } from 'child_process';
import { hostname, homedir } from 'os';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync, watch } from 'fs';
import { resolve, join, relative, sep } from 'path';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================================================
// Configuration
// ============================================================================
const ORIGIN_NAME = process.env.PORTOLAN_ORIGIN || hostname();
const DEFAULT_SERVER = 'localhost:4004';
const RECONNECT_INTERVAL = 5000;
const POLL_INTERVAL = 5000;  // Session discovery interval
const EVENTS_FILE = join(homedir(), '.portolan', 'data', 'events.jsonl');
const DEBUG = process.env.PORTOLAN_DEBUG === 'true';
const PLANNOTATOR_PORT = process.env.PLANNOTATOR_PORT ? parseInt(process.env.PLANNOTATOR_PORT, 10) : null;

// ─── Fiber-tree push (Stage 3a of vellum-kanban constitution) ────────────────
//
// The agent ships fiber-tree state to the server alongside activity events,
// enabling remote-origin fibers to land in the kanban's global view.
//
// PORTOLAN_FELT_HOST: parent dir of `.felt/`; defaults to `~/loom`. v1
// supports a single feltHost per agent — multi-feltHost-per-origin is a
// follow-up (the server already knows pinned cities for each origin and
// will eventually push that list back to the agent on connect).
//
// Watch debounces with FELT_WATCH_DEBOUNCE_MS so bursts (sweeps, mass
// renames, git pulls) batch into a single delta message. Per the
// constitution, ~250ms is the design point. Override via env for tests.
const FELT_HOST = process.env.PORTOLAN_FELT_HOST || join(homedir(), 'loom');
const FELT_DIR = join(FELT_HOST, '.felt');
const FELT_WATCH_DEBOUNCE_MS = process.env.PORTOLAN_FELT_DEBOUNCE_MS
  ? parseInt(process.env.PORTOLAN_FELT_DEBOUNCE_MS, 10)
  : 250;

// ─── Shuttle on the agent (constitution-shuttle-remote-dispatch) ─────────────
//
// The agent owns dispatch for fibers that live on its host. The server's
// Shuttle defers to a connected agent for any fiber visible in that
// agent's fiber-tree snapshot, so dispatch can run autonomously here even
// when the laptop is closed and the SSH tunnel is down. Loom git-sync
// carries the worker's frontmatter edits back to the laptop on next sync.
//
// PORTOLAN_SHUTTLE_ENABLED=1    → opt-in. Off by default — safer first
//                                 contact, since `~/loom/.felt/` may
//                                 contain stale constitution-tagged
//                                 fibers from past pulls that the user
//                                 doesn't want auto-dispatched.
// PORTOLAN_SHUTTLE_INTERVAL_MS  → poll cadence (default 30s, matches server).
// PORTOLAN_SHUTTLE_WORKER       → override path to shuttle-worker.sh.
// PORTOLAN_SHUTTLE_PREFIXES     → comma-separated id-prefix scope (mirrors
//                                 server's SHUTTLE_QUEUE_PREFIXES). Empty
//                                 means "every constitution-tagged,
//                                 non-draft, unblocked, non-closed fiber
//                                 on this host" — only meaningful when
//                                 PORTOLAN_SHUTTLE_ENABLED=1.
const SHUTTLE_ENABLED = process.env.PORTOLAN_SHUTTLE_ENABLED === '1';
const SHUTTLE_INTERVAL_MS = process.env.PORTOLAN_SHUTTLE_INTERVAL_MS
  ? parseInt(process.env.PORTOLAN_SHUTTLE_INTERVAL_MS, 10)
  : 30_000;
const SHUTTLE_WORKER_SCRIPT = process.env.PORTOLAN_SHUTTLE_WORKER
  || join(homedir(), '.portolan', 'bin', 'shuttle-worker.sh');
const SHUTTLE_PREFIXES = (process.env.PORTOLAN_SHUTTLE_PREFIXES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// CLI provider detection — detect both claude and codex simultaneously
const ALL_CLI_PROCESS_NAMES = ['claude', 'codex'];
function isCliProcess(comm) { return ALL_CLI_PROCESS_NAMES.some(n => comm.includes(n)); }

// ============================================================================
// State
// ============================================================================
let ws = null;
let reconnectTimeout = null;
let connected = false;
let pollInterval = null;
let eventsWatchInterval = null;
let lastEventsCharPosition = 0;
let fiberTreeWatcher = null;
let fiberTreeFlushTimer = null;
const fiberTreePending = new Map();  // relPath → 'upsert' | 'delete'
let shuttleInterval = null;
const shuttleDispatched = new Map();  // fiberId → { fiberId, tmuxSession, state, startedAt }
let lastShuttleSnapshot = null;

// ============================================================================
// Logging
// ============================================================================
function log(...args) {
    console.log(`[portolan-agent ${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
    if (DEBUG) {
        console.log(`[DEBUG]`, ...args);
    }
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Check if a directory has claims (workflow/config, results/tapestry, or .felt/)
 */
function detectClaims(cwd) {
    const hasWorkflowConfig = existsSync(resolve(cwd, 'workflow/config'));
    const hasResultsTapestry = existsSync(resolve(cwd, 'results/tapestry'));
    const hasFelt = existsSync(resolve(cwd, '.felt'));
    return hasWorkflowConfig || hasResultsTapestry || hasFelt;
}

/**
 * Check if a directory has playgrounds (.portolan/playgrounds/ with .html files)
 */
function detectPlaygrounds(cwd) {
    const playgroundsDir = resolve(cwd, '.portolan/playgrounds');
    if (!existsSync(playgroundsDir)) {
        return false;
    }
    try {
        const files = readdirSync(playgroundsDir);
        return files.some(f => f.endsWith('.html'));
    } catch {
        return false;
    }
}

/**
 * Get git status for a directory
 * Returns null if not a git repo or on error
 */
async function getGitStatus(directory) {
    const TIMEOUT = 5000;

    try {
        // Check if it's a git repo
        await execAsync('git rev-parse --git-dir', { cwd: directory, timeout: TIMEOUT });
    } catch {
        // Not a git repo
        return null;
    }

    const status = {
        branch: '',
        ahead: 0,
        behind: 0,
        staged: { added: 0, modified: 0, deleted: 0 },
        unstaged: { added: 0, modified: 0, deleted: 0 },
        untracked: 0,
        totalFiles: 0,
        linesAdded: 0,
        linesRemoved: 0,
        lastCommitTime: null,
        lastCommitMessage: null,
        isRepo: true,
        lastChecked: Date.now(),
    };

    // Run all git commands in parallel
    const [branchResult, statusResult, diffStagedResult, diffUnstagedResult, logResult] =
        await Promise.all([
            execAsync('git rev-parse --abbrev-ref HEAD', { cwd: directory, timeout: TIMEOUT }).catch(() => ({ stdout: '' })),
            execAsync('git status --porcelain', { cwd: directory, timeout: TIMEOUT }).catch(() => ({ stdout: '' })),
            execAsync('git diff --cached --shortstat', { cwd: directory, timeout: TIMEOUT }).catch(() => ({ stdout: '' })),
            execAsync('git diff --shortstat', { cwd: directory, timeout: TIMEOUT }).catch(() => ({ stdout: '' })),
            execAsync('git log -1 --format=%ct|||%s', { cwd: directory, timeout: TIMEOUT }).catch(() => ({ stdout: '' })),
        ]);

    // Parse branch
    status.branch = branchResult.stdout.trim();

    // Parse ahead/behind
    try {
        const abResult = await execAsync(
            'git rev-list --left-right --count @{upstream}...HEAD',
            { cwd: directory, timeout: TIMEOUT }
        );
        const [behind, ahead] = abResult.stdout.trim().split(/\s+/).map(Number);
        status.ahead = ahead || 0;
        status.behind = behind || 0;
    } catch {
        // No upstream configured
    }

    // Parse status --porcelain
    const statusLines = statusResult.stdout.trim().split('\n').filter(Boolean);
    for (const line of statusLines) {
        const staged = line[0];
        const unstaged = line[1];

        // Staged changes
        if (staged === 'A') status.staged.added++;
        else if (staged === 'M') status.staged.modified++;
        else if (staged === 'D') status.staged.deleted++;

        // Unstaged changes
        if (unstaged === 'M') status.unstaged.modified++;
        else if (unstaged === 'D') status.unstaged.deleted++;

        // Untracked
        if (staged === '?' && unstaged === '?') status.untracked++;
    }

    // Parse diff stats
    const parseDiffStat = (output) => {
        const match = output.match(/(\d+) insertion.*?(\d+) deletion/i);
        if (match) {
            return { added: parseInt(match[1], 10), removed: parseInt(match[2], 10) };
        }
        const addMatch = output.match(/(\d+) insertion/i);
        const delMatch = output.match(/(\d+) deletion/i);
        return {
            added: addMatch ? parseInt(addMatch[1], 10) : 0,
            removed: delMatch ? parseInt(delMatch[1], 10) : 0,
        };
    };

    const stagedDiff = parseDiffStat(diffStagedResult.stdout);
    const unstagedDiff = parseDiffStat(diffUnstagedResult.stdout);

    status.linesAdded = stagedDiff.added + unstagedDiff.added;
    status.linesRemoved = stagedDiff.removed + unstagedDiff.removed;

    // Total files
    status.totalFiles =
        status.staged.added +
        status.staged.modified +
        status.staged.deleted +
        status.unstaged.modified +
        status.unstaged.deleted +
        status.untracked;

    // Parse last commit
    if (logResult.stdout) {
        const [timestamp, message] = logResult.stdout.trim().split('|||');
        status.lastCommitTime = parseInt(timestamp, 10) || null;
        status.lastCommitMessage = message || null;
    }

    return status;
}

/**
 * Discover tmux sessions running Claude Code
 */
async function discoverSessions() {
    try {
        // Get all tmux panes with their session name, cwd, and pane PID
        const { stdout } = await execAsync(
            'tmux list-panes -a -F "#{session_name}\t#{pane_current_path}\t#{pane_pid}"'
        );

        const lines = stdout.trim().split('\n').filter(Boolean);
        const paneData = [];

        for (const line of lines) {
            const [tmuxSession, cwd, panePid] = line.split('\t');
            // Skip the agent's own tmux session
            if (panePid && tmuxSession !== 'portolan-agent') {
                paneData.push({ tmuxSession, cwd: cwd || process.cwd(), panePid });
            }
        }

        if (paneData.length === 0) {
            return [];
        }

        // Check which panes have a CLI running (claude or codex, as process itself or child)
        // NOTE: Detection logic duplicated in src/SessionTracker.ts — keep in sync
        const claudeSessionsBasic = [];

        for (const { tmuxSession, cwd, panePid } of paneData) {
            try {
                // Check if pane process ITSELF is a CLI (when zsh -c execs into claude/codex)
                const { stdout: paneComm } = await execAsync(
                    `ps -o comm= -p ${panePid} 2>/dev/null || true`,
                    { timeout: 2000 }
                );
                if (isCliProcess(paneComm.trim())) {
                    claudeSessionsBasic.push({ tmuxSession, cwd });
                    continue;
                }
                // Check full args for cases like "node .../bin/codex" on Linux
                const { stdout: paneArgs } = await execAsync(
                    `ps -o args= -p ${panePid} 2>/dev/null || true`,
                    { timeout: 2000 }
                );
                if (paneArgs.trim() && isCliProcess(paneArgs.trim())) {
                    claudeSessionsBasic.push({ tmuxSession, cwd });
                    continue;
                }

                // BFS through descendants (up to depth 4) to handle deep chains
                // e.g. bash → python3 → MainThread → codex (ralph-launched sessions)
                let found = false;
                let frontier = [panePid];
                for (let depth = 0; depth < 4 && !found; depth++) {
                    const nextFrontier = [];
                    for (const pid of frontier) {
                        const { stdout: childPidsOut } = await execAsync(
                            `pgrep -P ${pid} 2>/dev/null || true`,
                            { timeout: 2000 }
                        );
                        for (const candidatePid of childPidsOut.trim().split('\n').filter(Boolean)) {
                            try {
                                const { stdout: childComm } = await execAsync(
                                    `ps -o comm= -p ${candidatePid} 2>/dev/null || true`,
                                    { timeout: 2000 }
                                );
                                if (isCliProcess(childComm.trim())) { found = true; break; }
                                const { stdout: childArgs } = await execAsync(
                                    `ps -o args= -p ${candidatePid} 2>/dev/null || true`,
                                    { timeout: 2000 }
                                );
                                if (isCliProcess(childArgs.trim())) { found = true; break; }
                                nextFrontier.push(candidatePid);
                            } catch { /* skip */ }
                        }
                        if (found) break;
                    }
                    frontier = nextFrontier;
                }
                if (found) {
                    claudeSessionsBasic.push({ tmuxSession, cwd });
                    continue;
                }
            } catch {
                // Ignore errors from pgrep
            }
        }

        // Fetch git status for each session (in parallel)
        const claudeSessions = await Promise.all(
            claudeSessionsBasic.map(async ({ tmuxSession, cwd }) => {
                const gitStatus = await getGitStatus(cwd);
                return {
                    name: tmuxSession,
                    tmuxSession,
                    cwd,
                    status: 'idle',
                    hasClaims: detectClaims(cwd),
                    hasPlaygrounds: detectPlaygrounds(cwd),
                    gitStatus,  // May be null if not a git repo
                };
            })
        );

        return claudeSessions;
    } catch {
        // tmux not running or error
        debug('tmux discovery failed (tmux not running?)');
        return [];
    }
}

/**
 * Poll sessions and send update to server
 */
async function pollSessions() {
    const sessions = await discoverSessions();

    if (connected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'agent_sessions_update',
            payload: { sessions },
        }));
        debug(`Sent ${sessions.length} sessions to server: ${sessions.map(s => s.tmuxSession).join(', ')}`);
    }
}

// ============================================================================
// Event Watching (for activity stream)
// ============================================================================

/**
 * Tools to track in activity feed (file operations only, no Bash/Grep/Glob/Task)
 */
const TRACKED_TOOLS = new Set(['Read', 'Write', 'Edit']);

/**
 * Extract short summary from tool input
 *
 * NOTE: Keep in sync with server/src/activityUtils.ts (source of truth).
 * This is duplicated here because agent.js runs standalone on remote machines.
 */
function extractSummary(tool, input) {
    if (!input) return undefined;

    // Only track file operations
    if (!TRACKED_TOOLS.has(tool)) return undefined;

    if (input.file_path) {
        const parts = String(input.file_path).split('/');
        const filename = parts.pop();
        const parent = parts.pop();
        if (parent && filename) {
            const display = `${parent}/${filename}`;
            return display.length > 35 ? `…${display.slice(-34)}` : display;
        }
        return filename;
    }
    return undefined;
}

/**
 * Extract detailed activity information including full paths
 *
 * NOTE: Keep in sync with server/src/activityUtils.ts (source of truth).
 */
function extractActivityDetails(tool, input) {
    if (!input) return undefined;

    const summary = extractSummary(tool, input);
    if (!summary) return undefined;

    const details = { summary };

    // Include full path for file operations (already filtered by extractSummary)
    if (input.file_path) {
        details.fullPath = String(input.file_path);
    }

    return details;
}

/**
 * Start watching the events file for activity
 */
function startEventsWatcher() {
    if (!existsSync(EVENTS_FILE)) {
        log(`Events file not found: ${EVENTS_FILE}`);
        log('Activity tracking disabled. Install portolan-hook.sh to enable.');
        return;
    }

    // Initialize position to end of file
    try {
        const content = readFileSync(EVENTS_FILE, 'utf-8');
        lastEventsCharPosition = content.length;
    } catch {
        lastEventsCharPosition = 0;
    }

    // Poll for new events
    eventsWatchInterval = setInterval(processNewEvents, 1000);
    log(`Watching events file: ${EVENTS_FILE}`);
}

/**
 * Process new events since last read
 */
function processNewEvents() {
    if (!existsSync(EVENTS_FILE)) return;

    try {
        const content = readFileSync(EVENTS_FILE, 'utf-8');
        if (content.length <= lastEventsCharPosition) {
            return; // No new data
        }

        const newContent = content.slice(lastEventsCharPosition);
        lastEventsCharPosition = content.length;

        const lines = newContent.trim().split('\n');
        for (const line of lines) {
            if (!line) continue;
            try {
                const event = JSON.parse(line);
                processEvent(event);
            } catch {
                // Skip malformed lines
            }
        }
    } catch (err) {
        debug(`Event read error: ${err.message}`);
    }
}

/**
 * Process a single event
 */
function processEvent(event) {
    if (!event.tmuxSession) return;

    // Only send activity for pre_tool_use events (has tool info)
    if (event.type === 'pre_tool_use' && event.tool) {
        const details = extractActivityDetails(event.tool, event.toolInput);
        const activity = {
            tmuxSession: event.tmuxSession,
            tool: event.tool,
            summary: details?.summary,
            fullPath: details?.fullPath,
            timestamp: event.timestamp,
        };

        // Send to server
        if (connected && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'agent_activity',
                activity,
            }));
            debug(`Activity: ${activity.tool} ${activity.summary || ''}`);
        }
    }
}

// ============================================================================
// Fiber-tree push (Stage 3a of vellum-kanban constitution)
// ============================================================================

/**
 * Recursively collect every container-fiber path under FELT_DIR. Returns
 * `.felt/`-relative paths (e.g. `cmbx/cmbx.md`, `ai-futures/portolan/portolan.md`).
 * Non-container markdown files are skipped via `shuttleIdFromPath`.
 */
function collectFeltFiberPaths(dir) {
    const out = [];
    function walk(currentDir) {
        let entries;
        try {
            entries = readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                const relPath = relative(dir, full).split(sep).join('/');
                if (shuttleIdFromPath(relPath)) out.push(relPath);
            }
        }
    }
    walk(dir);
    return out;
}

async function readFeltFiberJson(fiberId) {
    try {
        const { stdout } = await execFileAsync(
            'felt',
            ['-C', FELT_HOST, 'show', fiberId, '-j'],
            { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function collectFiberTreeFiles() {
    const paths = collectFeltFiberPaths(FELT_DIR);
    const indexed = new Map();

    try {
        const { stdout } = await execFileAsync(
            'felt',
            ['-C', FELT_HOST, 'ls', '-s', 'all', '-j', '--body'],
            { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
        );
        const raw = JSON.parse(stdout.trim() || '[]');
        if (Array.isArray(raw)) {
            for (const fiber of raw) {
                if (!fiber || typeof fiber !== 'object' || Array.isArray(fiber)) continue;
                const id = fiber.id;
                if (typeof id === 'string' && id) indexed.set(id, fiber);
            }
        }
    } catch {
        // Fall back to per-fiber `felt show -j` reads below.
    }

    const files = [];
    for (const path of paths) {
        const id = shuttleIdFromPath(path);
        if (!id) continue;
        const fiber = indexed.get(id) ?? await readFeltFiberJson(id);
        if (!fiber) continue;
        files.push({ path, fiber });
    }
    return files;
}

/**
 * Send a full fiber-tree dump for FELT_DIR. Called after the agent
 * registers with the server (initial connect, and on every reconnect — the
 * server replaces the snapshot wholesale, no reconciliation needed).
 */
async function sendFiberTreeDump() {
    if (!existsSync(FELT_DIR)) {
        log(`Fiber-tree dump skipped: ${FELT_DIR} does not exist`);
        return;
    }
    const t0 = Date.now();
    const files = await collectFiberTreeFiles();
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'fiber_tree_dump',
            payload: { feltHost: FELT_HOST, files },
        }));
        log(`Sent fiber_tree_dump: ${files.length} fibers (walk ${Date.now() - t0}ms) from ${FELT_DIR}`);
    }
}

/**
 * Start watching FELT_DIR for `.md` changes. Per-file events are coalesced
 * into a `pending` map (path → op) and flushed in batched `fiber_tree_delta`
 * messages on a debounce timer.
 *
 * Node's fs.watch with `recursive: true` works on macOS, Windows, and Linux
 * (kernel 5.2+, libuv-based). The agent catches the rare unsupported-OS
 * error and degrades gracefully — the dump on connect still ships, just
 * without live deltas. Reconnect-triggered re-dumps recover any drift.
 */
function startFiberTreeWatcher() {
    if (!existsSync(FELT_DIR)) {
        log(`Fiber-tree watcher skipped: ${FELT_DIR} does not exist`);
        return;
    }
    try {
        fiberTreeWatcher = watch(FELT_DIR, { recursive: true, persistent: false }, (eventType, filename) => {
            if (!filename) return;
            // Normalize to forward slashes for wire consistency. fs.watch on
            // Windows would emit backslashes; harmless on POSIX.
            const relPath = String(filename).split(sep).join('/');
            if (!relPath.endsWith('.md')) return;
            const fullPath = join(FELT_DIR, relPath);
            // Probe existence at event time rather than trusting eventType:
            // 'change' usually means write, 'rename' covers create/delete/move.
            // existsSync is the unambiguous signal — file present = upsert,
            // absent = delete. The flush re-reads, so a flap (delete-then-
            // recreate within debounce window) settles to the final state.
            const op = existsSync(fullPath) ? 'upsert' : 'delete';
            fiberTreePending.set(relPath, op);
            scheduleFiberTreeFlush();
        });
        log(`Watching fiber tree: ${FELT_DIR} (debounce ${FELT_WATCH_DEBOUNCE_MS}ms)`);
    } catch (err) {
        log(`Fiber-tree watcher unsupported on this platform: ${err.message}. ` +
            `Reconnect-triggered re-dumps will recover any drift.`);
    }
}

function scheduleFiberTreeFlush() {
    if (fiberTreeFlushTimer) clearTimeout(fiberTreeFlushTimer);
    fiberTreeFlushTimer = setTimeout(() => {
        void flushFiberTreeDeltas();
    }, FELT_WATCH_DEBOUNCE_MS);
}

async function flushFiberTreeDeltas() {
    fiberTreeFlushTimer = null;
    if (fiberTreePending.size === 0) return;
    const deltas = [];
    for (const [path, op] of fiberTreePending) {
        const fullPath = join(FELT_DIR, path);
        if (op === 'upsert') {
            if (!existsSync(fullPath)) {
                deltas.push({ path, op: 'delete' });
                continue;
            }
            const id = shuttleIdFromPath(path);
            const fiber = id ? await readFeltFiberJson(id) : null;
            if (fiber) {
                deltas.push({ path, op: 'upsert', fiber });
            } else {
                // If felt can't read the file yet, let the next reconnect dump
                // recover it rather than shipping a half-parsed fallback.
                debug(`Skipping fiber_tree_delta upsert for ${path}: felt show failed`);
            }
        } else {
            deltas.push({ path, op: 'delete' });
        }
    }
    fiberTreePending.clear();
    if (deltas.length === 0) return;
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'fiber_tree_delta',
            payload: { deltas },
        }));
        debug(`Sent fiber_tree_delta: ${deltas.length} ops`);
    }
}

function stopFiberTreeWatcher() {
    if (fiberTreeWatcher) {
        try { fiberTreeWatcher.close(); } catch { /* already closed */ }
        fiberTreeWatcher = null;
    }
    if (fiberTreeFlushTimer) {
        clearTimeout(fiberTreeFlushTimer);
        fiberTreeFlushTimer = null;
    }
    fiberTreePending.clear();
}

// ============================================================================
// Kanban transition (Stage 4 of vellum-kanban constitution)
// ============================================================================
//
// The server ships `kanban-transition` over the agent WebSocket via the
// AgentRequestCoordinator's correlation-ID layer. The payload is already the
// semantic mutation: shuttle lifecycle/outcome verbs or a felt tag-replace.
// The agent shells out to the canonical CLI writer on the remote host,
// re-reads the fiber through `felt show -j`, and replies with
// `kanban-transition-result`. The reply carries the new felt JSON payload so
// the server applies a snapshot delta eagerly — fs.watch will fire its own
// delta moments later, but we don't want the HTTP caller to race with it.

function normalizeTagList(tags) {
    const seen = new Set();
    const normalized = [];
    for (const tag of tags) {
        const trimmed = typeof tag === 'string' ? tag.trim() : '';
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
    }
    return normalized;
}

function diffTags(current, next) {
    const currentSet = new Set(current);
    const nextSet = new Set(next);
    return {
        add: next.filter(tag => !currentSet.has(tag)),
        remove: current.filter(tag => !nextSet.has(tag)),
    };
}

async function runKanbanMutation(payload, fullPath) {
    const env = {
        ...process.env,
        LOOM_HOME: FELT_HOST,
        HOME: process.env.HOME ?? homedir(),
    };

    if (payload.kind === 'shuttle') {
        if (typeof payload.fiberId !== 'string' || payload.fiberId.length === 0) {
            throw new Error('missing shuttle fiberId');
        }
        const args = [payload.verb, payload.fiberId];
        switch (payload.verb) {
            case 'pause':
            case 'reopen':
            case 'accept':
                break;
            case 'close':
                if (payload.tempered !== undefined) {
                    args.push(`--tempered=${payload.tempered ? 'true' : 'false'}`);
                }
                break;
            case 'set-outcome':
                if (typeof payload.outcome !== 'string') {
                    throw new Error('missing outcome for set-outcome');
                }
                args.push('--outcome', payload.outcome);
                break;
            default:
                throw new Error(`unknown shuttle verb: ${payload.verb}`);
        }
        await execFileAsync('shuttle-ctl', args, {
            cwd: FELT_HOST,
            env,
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
        });
        return;
    }

    if (payload.kind === 'felt-tags') {
        if (typeof payload.fiberId !== 'string' || payload.fiberId.length === 0) {
            throw new Error('missing felt fiberId');
        }
        if (!Array.isArray(payload.tags)) {
            throw new Error('missing tags payload');
        }
        const fiberJson = await readFeltFiberJson(payload.fiberId);
        const current = normalizeTagList(
            Array.isArray(fiberJson?.tags) ? fiberJson.tags.filter((t) => typeof t === 'string') : [],
        );
        const next = normalizeTagList(payload.tags);
        const { add, remove } = diffTags(current, next);
        if (add.length === 0 && remove.length === 0) return;

        const args = ['-C', FELT_HOST, 'edit', payload.fiberId];
        for (const tag of remove) args.push('--untag', tag);
        for (const tag of add) args.push('--tag', tag);
        await execFileAsync('felt', args, {
            cwd: FELT_HOST,
            env,
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
        });
        return;
    }

    throw new Error(`unknown mutation kind: ${payload.kind}`);
}

/**
 * Handle a `kanban-transition` request from the server. Reads
 * `<FELT_DIR>/<path>`, applies the semantic CLI mutation, re-reads the fiber
 * through felt, and replies with `{correlationId, ok: true, fiber}` so the
 * server can apply a snapshot delta eagerly. Errors come back as
 * `{ok: false, error}`.
 */
async function handleKanbanTransition(message) {
    const payload = message.payload || {};
    const { correlationId, path: relPath } = payload;
    if (!correlationId) {
        debug('kanban-transition without correlationId; ignoring');
        return;
    }
    const reply = (extra) => {
        if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'kanban-transition-result',
            payload: { correlationId, ...extra },
        }));
    };
    try {
        if (typeof relPath !== 'string' || relPath.includes('..') || relPath.startsWith('/')) {
            throw new Error(`invalid path: ${relPath}`);
        }
        const fullPath = join(FELT_DIR, relPath);
        if (!existsSync(fullPath)) {
            throw new Error(`fiber file missing: ${relPath}`);
        }
        await runKanbanMutation(payload, fullPath);
        const fiberId = shuttleIdFromPath(relPath);
        if (!fiberId) {
            throw new Error(`path is not a fiber: ${relPath}`);
        }
        const updated = await readFeltFiberJson(fiberId);
        if (!updated) {
            throw new Error(`felt show failed after mutation: ${fiberId}`);
        }
        reply({ ok: true, fiber: updated });
        const label = payload.kind === 'shuttle' ? payload.verb : payload.kind;
        debug(`kanban-transition ok: ${relPath} → ${label}`);
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        log(`kanban-transition failed (${relPath}): ${msg}`);
        reply({ ok: false, error: msg });
    }
}

// ============================================================================
// Shuttle on the agent (constitution-shuttle-remote-dispatch)
// ============================================================================
//
// SOURCE OF TRUTH for the eligibility predicate is server/src/Shuttle.ts
// `computeEligibility`. The agent inlines a minimal port — same shape, no
// queuePrefixes-API surface (we read SHUTTLE_PREFIXES once at startup) and
// no sub-fiber resolution beyond what idFromPath surfaces. The predicate is
// small enough to stay in human-eyeballed sync.
//
// The path: on each tick, ask felt for the fiber tree as JSON (felt is the
// sole reader since Phase 1 of constitution-four-package-cleanup), project
// onto {id, status, tags, dependsOn, tempered}, then run the predicate and
// dispatch. tmux is probed by `tmux ls` filtered to `shuttle-*`.

/**
 * Project a felt fiber JSON object onto the minimal shape `computeShuttleEligibility`
 * reads. `depends_on` ships from felt as `[{id: "..."}]`, occasionally as bare
 * strings on legacy fibers — accept either. Returns null when the fiber lacks
 * an id.
 */
export function shuttleFiberFromFeltJson(fiber) {
    if (!fiber || typeof fiber !== 'object' || Array.isArray(fiber)) return null;
    const id = typeof fiber.id === 'string' ? fiber.id : '';
    if (!id) return null;
    const tags = Array.isArray(fiber.tags)
        ? fiber.tags.filter((t) => typeof t === 'string')
        : [];
    const dependsOn = Array.isArray(fiber.depends_on)
        ? fiber.depends_on
              .map((d) => {
                  if (typeof d === 'string') return d;
                  if (d && typeof d === 'object' && typeof d.id === 'string') return d.id;
                  return null;
              })
              .filter((s) => typeof s === 'string' && s.length > 0)
        : [];
    return {
        id,
        status: typeof fiber.status === 'string' ? fiber.status : undefined,
        tags,
        dependsOn,
        tempered: fiber.tempered === true ? true : fiber.tempered === false ? false : undefined,
    };
}

/**
 * Translate a `.felt/`-relative file path to a fiber id, mirroring
 * server/src/FiberTreeSnapshotStore.idFromPath. Container fibers only:
 * `<slug>.md`, `<dir>/<dir>.md`, `<a>/<b>/<b>.md`. Sibling notes return
 * null and are skipped.
 *
 * SOURCE OF TRUTH: server/src/FiberTreeSnapshotStore.ts `idFromPath`.
 */
export function shuttleIdFromPath(filePath) {
    if (!filePath.endsWith('.md')) return null;
    const cleaned = filePath.replace(/^\.?\/?/, '');
    const noExt = cleaned.slice(0, -3);
    const parts = noExt.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    if (last !== secondLast) return null;
    return parts.slice(0, -1).join('/');
}

/**
 * Ask felt for `[{ id, status, tags, dependsOn, tempered }]` for every
 * container fiber on FELT_HOST. One `felt ls -s all -j` shellout per tick;
 * felt's index is fast and avoids re-implementing fiber parsing in the
 * agent. On felt errors (e.g. felt unavailable) returns an empty list so
 * the poller no-ops rather than crashing.
 */
async function collectShuttleFibers() {
    if (!existsSync(FELT_DIR)) return [];
    let raw;
    try {
        const { stdout } = await execFileAsync(
            'felt',
            ['-C', FELT_HOST, 'ls', '-s', 'all', '-j'],
            { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
        );
        raw = JSON.parse(stdout.trim() || '[]');
    } catch (err) {
        debug(`collectShuttleFibers: felt ls failed (${err?.message ?? err})`);
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const fiber of raw) {
        const projected = shuttleFiberFromFeltJson(fiber);
        if (projected) out.push(projected);
    }
    return out;
}

/**
 * Eligibility predicate. Mirror of server/src/Shuttle.ts
 * `computeEligibility` semantics:
 *   1. tags includes 'constitution'
 *   2. NOT tagged 'draft'
 *   3. status != 'closed'
 *   4. all dependsOn references resolve to fibers with tempered === true
 *   5. id is in scope per SHUTTLE_PREFIXES (when set)
 */
export function computeShuttleEligibility(fibers, prefixes) {
    const byId = new Map(fibers.map(f => [f.id, f]));
    const eligible = [];
    const blocked = [];

    const inScope = (id) => {
        if (!prefixes || prefixes.length === 0) return true;
        return prefixes.some(p => id === p || id.startsWith(p + '/'));
    };

    for (const f of fibers) {
        if (!f.tags || !f.tags.includes('constitution')) continue;
        if (!inScope(f.id)) continue;
        if (f.tags.includes('draft')) {
            blocked.push({ fiberId: f.id, reason: 'tag: draft' });
            continue;
        }
        if (f.status === 'closed') {
            blocked.push({ fiberId: f.id, reason: 'status: closed' });
            continue;
        }
        const deps = f.dependsOn || [];
        const unsatisfied = deps.filter(depId => {
            const dep = byId.get(depId);
            return !dep || dep.tempered !== true;
        });
        if (unsatisfied.length > 0) {
            blocked.push({
                fiberId: f.id,
                reason: `blocked on: ${unsatisfied.join(', ')}`,
            });
            continue;
        }
        eligible.push(f);
    }
    return { eligible, blocked };
}

/** Probe tmux for `shuttle-*` sessions. Empty array if tmux isn't running. */
async function listShuttleSessions() {
    try {
        const { stdout } = await execAsync(
            'tmux ls -F "#{session_name}" 2>/dev/null',
            { timeout: 3000 }
        );
        return stdout.split('\n').map(s => s.trim()).filter(s => s.startsWith('shuttle-'));
    } catch {
        return [];
    }
}

function shuttleSessionName(fiberId) {
    return `shuttle-${fiberId}`;
}

/**
 * Map a fiber's tags to the dispatch agent. Mirrors `agentForFiber()`
 * in `server/src/Shuttle.ts` — the `codex` tag selects codex, anything
 * else falls back to claude. Same semantics, kept in lockstep so a
 * single fiber dispatches identically whether picked up by the
 * server-side Shuttle or by an agent on its own host.
 */
function agentForFiber(tags) {
    if (Array.isArray(tags) && tags.includes('codex')) return 'codex';
    return 'claude';
}

/**
 * Spawn a shuttle worker on this host. Detached so the worker survives
 * the agent restarting; matches the server-side dispatcher's contract.
 * The worker script itself runs `tmux new-session -d`, so we shell out
 * once and trust tmux to take ownership of the actual session.
 *
 * `agent` ('claude' | 'codex') is appended as `--agent <agent>` so the
 * worker script picks the right CLI invocation; selection is
 * tag-driven (see `agentForFiber`).
 */
function spawnShuttleWorker(fiberId, agent) {
    if (!existsSync(SHUTTLE_WORKER_SCRIPT)) {
        log(`[shuttle] worker script missing at ${SHUTTLE_WORKER_SCRIPT}; skipping ${fiberId}`);
        return null;
    }
    try {
        const child = spawn('bash', ['-l', SHUTTLE_WORKER_SCRIPT, fiberId, '--agent', agent], {
            cwd: FELT_HOST,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        debug(`[shuttle] spawned worker for ${fiberId} (agent=${agent})`);
        return shuttleSessionName(fiberId);
    } catch (err) {
        log(`[shuttle] spawn failed for ${fiberId}: ${err.message}`);
        return null;
    }
}

/**
 * One reconcile pass. Walks FELT_DIR, computes eligibility, probes tmux,
 * spawns workers for newly-eligible fibers, and ships a `shuttle_snapshot`
 * to the server. Single-shot semantics: if a worker exits and the fiber
 * is still eligible on the next tick, we redispatch.
 */
async function pollShuttle() {
    const fibers = await collectShuttleFibers();
    const { eligible: eligibleFibers, blocked } = computeShuttleEligibility(fibers, SHUTTLE_PREFIXES);
    const liveSessions = new Set(await listShuttleSessions());
    const eligibleIds = new Set(eligibleFibers.map(f => f.id));

    // Reconcile in-memory dispatch state with reality.
    for (const [id, entry] of shuttleDispatched) {
        if (entry.tmuxSession && !liveSessions.has(entry.tmuxSession)) {
            entry.state = 'gone';
        }
        if (!eligibleIds.has(id)) {
            shuttleDispatched.delete(id);
        }
    }

    const eligibleEntries = [];
    for (const f of eligibleFibers) {
        const expectedSession = shuttleSessionName(f.id);
        const existing = shuttleDispatched.get(f.id);
        const sessionLive = existing && existing.tmuxSession && liveSessions.has(existing.tmuxSession);
        const agent = agentForFiber(f.tags);

        if (sessionLive) {
            eligibleEntries.push(existing);
            continue;
        }

        // Adopt an external shuttle session by name (e.g. one we spawned
        // before agent restart, or a manual launch).
        if (liveSessions.has(expectedSession)) {
            const adopted = {
                fiberId: f.id,
                tmuxSession: expectedSession,
                state: 'running',
                startedAt: existing?.startedAt ?? Date.now(),
                agent,
                reason: 'adopted existing tmux session',
            };
            shuttleDispatched.set(f.id, adopted);
            eligibleEntries.push(adopted);
            continue;
        }

        const session = spawnShuttleWorker(f.id, agent);
        if (!session) {
            eligibleEntries.push({
                fiberId: f.id,
                state: 'idle',
                agent,
                reason: 'spawn failed (worker script missing or unavailable)',
            });
            continue;
        }
        const entry = {
            fiberId: f.id,
            tmuxSession: session,
            state: 'running',
            startedAt: Date.now(),
            agent,
        };
        shuttleDispatched.set(f.id, entry);
        eligibleEntries.push(entry);
    }

    const trackedSessions = new Set(
        Array.from(shuttleDispatched.values())
            .map(e => e.tmuxSession)
            .filter(Boolean)
    );
    const orphans = Array.from(liveSessions).filter(s => !trackedSessions.has(s));

    const snapshot = {
        pollAt: Date.now(),
        eligible: eligibleEntries,
        blocked,
        orphans,
    };
    lastShuttleSnapshot = snapshot;

    if (connected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'shuttle_snapshot',
            payload: { snapshot },
        }));
        debug(`[shuttle] snapshot: ${eligibleEntries.length} eligible, ${blocked.length} blocked, ${orphans.length} orphans`);
    }
    return snapshot;
}

function startShuttlePoller() {
    if (!SHUTTLE_ENABLED) {
        log('[shuttle] disabled (set PORTOLAN_SHUTTLE_ENABLED=1 to enable)');
        return;
    }
    if (!existsSync(FELT_DIR)) {
        log(`[shuttle] FELT_DIR missing (${FELT_DIR}); shuttle poller will idle until it appears`);
    }
    log(`[shuttle] poller starting — interval ${SHUTTLE_INTERVAL_MS}ms, worker ${SHUTTLE_WORKER_SCRIPT}` +
        (SHUTTLE_PREFIXES.length ? `, scope ${SHUTTLE_PREFIXES.join(',')}` : ', unscoped'));
    pollShuttle().catch(err => log(`[shuttle] tick error: ${err.message}`));
    shuttleInterval = setInterval(() => {
        pollShuttle().catch(err => log(`[shuttle] tick error: ${err.message}`));
    }, SHUTTLE_INTERVAL_MS);
}

function stopShuttlePoller() {
    if (shuttleInterval) {
        clearInterval(shuttleInterval);
        shuttleInterval = null;
    }
}

// ============================================================================
// WebSocket Connection
// ============================================================================

/**
 * Build specific node SSH alias from base sshHost and hostname.
 * e.g., sshHost="cineca", hostname="login05.leonardo.local" → "cineca-login05"
 */
function buildSpecificSshHost(baseSshHost) {
    if (!baseSshHost) return null;

    const nodeMatch = ORIGIN_NAME.match(/^(login\d+)\./);
    if (nodeMatch) {
        // Don't double-append if baseSshHost already ends with this login node
        if (baseSshHost.endsWith(`-${nodeMatch[1]}`)) {
            log(`SSH host already specific: ${baseSshHost}`);
            return baseSshHost;
        }
        const specificHost = `${baseSshHost}-${nodeMatch[1]}`;
        log(`Using specific node SSH host: ${specificHost} (from ${ORIGIN_NAME})`);
        return specificHost;
    }
    return baseSshHost;
}

/**
 * Connect to portolan server
 */
function connect(serverUrl, sshHost) {
    if (ws) {
        ws.close();
    }

    // Build specific node SSH alias for multi-node HPC systems
    const specificSshHost = buildSpecificSshHost(sshHost);

    // Build URL with query params
    let url = `ws://${serverUrl}?agent=true&origin=${encodeURIComponent(ORIGIN_NAME)}`;
    if (specificSshHost) {
        url += `&sshHost=${encodeURIComponent(specificSshHost)}`;
    }
    if (PLANNOTATOR_PORT) {
        url += `&plannotatorPort=${PLANNOTATOR_PORT}`;
    }

    log(`Connecting to ${url}...`);

    ws = new WebSocket(url);

    ws.on('open', () => {
        connected = true;
        log(`Connected to portolan server at ${serverUrl}`);

        // Send initial sessions
        pollSessions();

        // Stage 3a: ship the fiber tree on connect. The server replaces
        // any prior snapshot wholesale — reconnects don't need state-diff
        // coordination because the agent is the sole writer to its
        // host's `.felt/`.
        void sendFiberTreeDump();

        // Constitution shuttle-remote-dispatch: ship the most recent
        // shuttle snapshot if we have one. Lets the server pick up the
        // dispatch view immediately after a reconnect rather than
        // waiting up to SHUTTLE_INTERVAL_MS for the next tick.
        if (lastShuttleSnapshot) {
            ws.send(JSON.stringify({
                type: 'shuttle_snapshot',
                payload: { snapshot: lastShuttleSnapshot },
            }));
            debug(`[shuttle] resent last snapshot on reconnect`);
        }
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(message);
        } catch (e) {
            debug(`Failed to parse message: ${e}`);
        }
    });

    ws.on('close', () => {
        connected = false;
        log('Disconnected from server');
        scheduleReconnect(serverUrl, sshHost);
    });

    ws.on('error', (error) => {
        debug(`WebSocket error: ${error.message}`);
    });
}

/**
 * Handle incoming messages from server
 */
function handleMessage(message) {
    switch (message.type) {
        case 'connected':
            log(`Registered with server (origin: ${message.payload?.originId})`);
            break;

        case 'kanban-transition':
            handleKanbanTransition(message);
            break;

        default:
            debug(`Unhandled message type: ${message.type}`);
    }
}

/**
 * Schedule reconnection
 */
function scheduleReconnect(serverUrl, sshHost) {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }

    log(`Reconnecting in ${RECONNECT_INTERVAL / 1000}s...`);
    reconnectTimeout = setTimeout(() => {
        connect(serverUrl, sshHost);
    }, RECONNECT_INTERVAL);
}

// ============================================================================
// CLI
// ============================================================================
function printUsage() {
    console.log(`
Portolan Remote Agent

Usage:
  portolan-agent connect [host:port] [--ssh-host=name]
  portolan-agent status
  portolan-agent help

Options:
  host:port       Server address (default: localhost:4004)
  --ssh-host=X    SSH config name for this host (default: hostname)

Environment:
  PORTOLAN_ORIGIN     Origin name (default: hostname)
  PORTOLAN_DEBUG      Enable debug logging (true/false)

SSH tunnel setup (in local ~/.ssh/config):
  Host yourserver
    RemoteForward 4004 127.0.0.1:4004

Example:
  # On remote machine (with SSH tunnel active)
  portolan-agent connect

  # With custom SSH host name (for focus commands)
  portolan-agent connect --ssh-host=myserver
`);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    // Parse --ssh-host flag
    let sshHost = null;
    const sshHostArg = args.find(a => a.startsWith('--ssh-host='));
    if (sshHostArg) {
        sshHost = sshHostArg.split('=')[1];
    }

    // Get server URL (first positional arg that doesn't start with --)
    const positionalArgs = args.filter(a => !a.startsWith('--'));

    switch (command) {
        case 'connect': {
            const serverUrl = positionalArgs[1] || DEFAULT_SERVER;
            log(`Starting portolan-agent (origin: ${ORIGIN_NAME})`);

            // Start session polling
            pollInterval = setInterval(pollSessions, POLL_INTERVAL);
            await pollSessions();

            // Start events watcher (for activity stream)
            startEventsWatcher();

            // Start fiber-tree watcher (debounced delta push). Started up
            // front so it's running by the time the WS opens; events that
            // fire before connect just queue in the pending map and
            // flush on the first scheduled timer tick after the socket
            // is ready.
            startFiberTreeWatcher();

            // Constitution shuttle-remote-dispatch: poller runs whether or
            // not the WS is up, so dispatch survives tunnel drops and
            // laptop-closes. The first tick fires immediately so
            // already-eligible fibers don't wait a full interval.
            startShuttlePoller();

            // Connect to server
            connect(serverUrl, sshHost);

            // Keep alive
            process.on('SIGINT', () => {
                log('Shutting down...');
                if (pollInterval) clearInterval(pollInterval);
                if (eventsWatchInterval) clearInterval(eventsWatchInterval);
                stopFiberTreeWatcher();
                stopShuttlePoller();
                if (ws) ws.close();
                process.exit(0);
            });
            break;
        }

        case 'status': {
            const sessions = await discoverSessions();
            if (sessions.length === 0) {
                console.log('No Claude Code sessions found');
            } else {
                console.log(`Found ${sessions.length} Claude Code session(s):\n`);
                for (const session of sessions) {
                    console.log(`  ${session.tmuxSession}`);
                    console.log(`    cwd: ${session.cwd}`);
                    console.log();
                }
            }
            break;
        }

        case 'help':
        case '--help':
        case '-h':
            printUsage();
            break;

        default:
            if (command) {
                console.error(`Unknown command: ${command}\n`);
            }
            printUsage();
            process.exit(command ? 1 : 0);
    }
}

// Run as CLI only when invoked directly. Importing this file (e.g. for the
// frontmatter-parity test in server/src/__tests__/) must not trigger main()
// or the import would call printUsage() + process.exit().
import { fileURLToPath as _fileURLToPath } from 'url';
const _isMain = process.argv[1] === _fileURLToPath(import.meta.url);
if (_isMain) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
