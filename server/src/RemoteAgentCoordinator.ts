import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import type { ActivityEvent } from './EventWatcher.js';
import type { GitStatus } from './GitStatusManager.js';
import type { AgentActivityMessage, AgentSessionsUpdateMessage } from './MessageRouter.js';
import { OriginManager } from './OriginManager.js';
import { RecentFileTracker } from './RecentFileTracker.js';
import { RemoteWorkingSessionTracker } from './RemoteWorkingSessionTracker.js';
import { shellEscape } from './ShellPathUtils.js';
import type { Session } from './SessionTracker.js';
import { CityManager, type City } from './CityManager.js';

const ACTIVITY_PERSISTENCE_PATH = join(homedir(), '.portolan', 'remote-activities.json');
const MAX_REMOTE_ACTIVITIES = 50;
const REMOTE_AGENT_TMUX_SESSION = 'portolan-agent';
const REMOTE_AGENT_RECOVERY_COOLDOWN_MS = 60_000;
const execFileAsync = promisify(execFile);

interface RemoteActivityPersistence {
  version: 1;
  activities: Record<string, ActivityEvent[]>;
}

interface RemoteAgentCoordinatorCallbacks {
  assignSessionToCity(session: Session, city: City): void;
  broadcastActivity(activity: ActivityEvent, originId: string): void;
  broadcastState(): void;
  rebuildCities(): void;
  recoverRemoteAgent(sshHost: string): Promise<RemoteAgentRecoveryResult>;
}

export interface RemoteAgentRecoveryResult {
  sshHost: string;
  tunnel: 'reachable' | 'unreachable';
  agent: 'already_running' | 'restarted' | 'failed';
  message: string;
}

interface RemoteAgentRecoveryState {
  originId: string;
  sshHost: string;
  disconnectedAt: number;
  lastAttemptAt?: number;
  lastResult?: RemoteAgentRecoveryResult;
  lastError?: string;
  inFlight?: boolean;
}

export class RemoteAgentCoordinator {
  private remoteSessions = new Map<string, Map<string, Session>>();
  private remoteGitStatuses = new Map<string, GitStatus>();
  private remoteActivities = new Map<string, ActivityEvent[]>();
  private remoteWorkingSessions = new RemoteWorkingSessionTracker();
  private recoveryStates = new Map<string, RemoteAgentRecoveryState>();

  constructor(
    private cityManager: CityManager,
    private originManager: OriginManager,
    private recentFileTracker: RecentFileTracker,
    private previousSessions: Map<string, Session>,
    private callbacks: RemoteAgentCoordinatorCallbacks,
  ) {
    this.loadActivityPersistence();
  }

  findSession(sessionId: string): Session | undefined {
    for (const originSessions of this.remoteSessions.values()) {
      for (const session of originSessions.values()) {
        if (session.id === sessionId) return session;
      }
    }
    return undefined;
  }

  getAllSessions(): Session[] {
    const all: Session[] = [];
    for (const originSessions of this.remoteSessions.values()) {
      all.push(...originSessions.values());
    }
    return all;
  }

  getRemoteSessionCount(): number {
    let total = 0;
    for (const sessionsByOrigin of this.remoteSessions.values()) {
      total += sessionsByOrigin.size;
    }
    return total;
  }

  getRemoteSessionOriginCount(): number {
    return this.remoteSessions.size;
  }

  getRemoteActivityStoreCount(): number {
    return this.remoteActivities.size;
  }

  getRemoteGitStatusCount(): number {
    return this.remoteGitStatuses.size;
  }

  getRemoteActivityEventCount(): number {
    let total = 0;
    for (const activities of this.remoteActivities.values()) {
      total += activities.length;
    }
    return total;
  }

  getRemoteWorkingStats() {
    return this.remoteWorkingSessions.getStats();
  }

  getRemoteAgentRecoveryStats() {
    return Array.from(this.recoveryStates.values()).map((state) => ({
      originId: state.originId,
      sshHost: state.sshHost,
      disconnectedAt: new Date(state.disconnectedAt).toISOString(),
      lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
      inFlight: !!state.inFlight,
      lastResult: state.lastResult ?? null,
      lastError: state.lastError ?? null,
    }));
  }

  getGitStatus(originId: string, path: string): GitStatus | undefined {
    return this.remoteGitStatuses.get(`${originId}:${path}`);
  }

  getActivities(originId: string, tmuxSession: string): ActivityEvent[] {
    return this.remoteActivities.get(this.getActivitySessionKey(originId, tmuxSession)) || [];
  }

  handleAgentSessionsUpdate(
    originId: string,
    agentSessions: AgentSessionsUpdateMessage['payload']['sessions'],
  ): void {
    this.recoveryStates.delete(originId);

    let originSessionsMap = this.remoteSessions.get(originId);
    if (!originSessionsMap) {
      originSessionsMap = new Map();
      this.remoteSessions.set(originId, originSessionsMap);
    }

    const updatedTmuxSessions = new Set(agentSessions.map((session) => session.tmuxSession));
    const removedSessions: Session[] = [];

    for (const [tmuxSession, session] of originSessionsMap) {
      if (updatedTmuxSessions.has(tmuxSession)) continue;
      if (session.cityId && session.workerHex) {
        this.cityManager.releaseWorkerHex(session.cityId, session.workerHex);
      }
      originSessionsMap.delete(tmuxSession);
      this.previousSessions.delete(session.id);
      removedSessions.push(session);
      console.log(`Remote session removed: ${session.name} from ${originId}`);
    }

    let activityChanged = false;
    for (const removed of removedSessions) {
      this.recentFileTracker.removeSession(removed.id);
      activityChanged = this.cleanupRemoteSessionData(originId, removed) || activityChanged;
    }
    activityChanged = this.pruneStaleRemoteActivities() || activityChanged;
    if (activityChanged) {
      this.saveActivityPersistence();
    }

    for (const agentSession of agentSessions) {
      const status = agentSession.status || 'idle';
      const existing = originSessionsMap.get(agentSession.tmuxSession);
      if (existing) {
        existing.cwd = agentSession.cwd;
        existing.status = status;
        if (status === 'working') {
          existing.lastActivity = Date.now();
        }
      } else {
        const session: Session = {
          id: `remote-${originId}-${agentSession.tmuxSession}`,
          name: agentSession.name,
          tmuxSession: agentSession.tmuxSession,
          cwd: agentSession.cwd,
          status,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          originId,
        };
        originSessionsMap.set(agentSession.tmuxSession, session);
        console.log(`Remote session discovered: ${session.name} from ${originId}`);
      }

      this.remoteWorkingSessions.reconcile(originId, agentSession.tmuxSession, status);
    }

    this.callbacks.rebuildCities();

    const claimsByCwd = new Map<string, boolean>();
    const playgroundsByCwd = new Map<string, boolean>();
    for (const agentSession of agentSessions) {
      if (agentSession.hasClaims !== undefined) {
        claimsByCwd.set(agentSession.cwd, agentSession.hasClaims);
      }
      if (agentSession.hasPlaygrounds !== undefined) {
        playgroundsByCwd.set(agentSession.cwd, agentSession.hasPlaygrounds);
      }
      if (agentSession.gitStatus) {
        this.remoteGitStatuses.set(`${originId}:${agentSession.cwd}`, agentSession.gitStatus);
      }
    }
    this.pruneRemoteGitStatus(originId, new Set(agentSessions.map((session) => session.cwd)));

    for (const session of originSessionsMap.values()) {
      if (!session.cwd) continue;
      const city = this.cityManager.findCityForPath(session.cwd, session.originId);
      if (!city) continue;

      const hasClaims = claimsByCwd.get(session.cwd);
      if (hasClaims !== undefined) {
        city.hasClaims = hasClaims;
      }

      const hasPlaygrounds = playgroundsByCwd.get(session.cwd);
      if (hasPlaygrounds !== undefined) {
        city.hasPlaygrounds = hasPlaygrounds;
      }

      this.callbacks.assignSessionToCity(session, city);
      this.previousSessions.set(session.id, session);
    }

    this.callbacks.broadcastState();
  }

  handleAgentActivity(originId: string, activity: AgentActivityMessage['activity']): void {
    if (!['Read', 'Write', 'Edit'].includes(activity.tool)) {
      return;
    }

    const activitySessionKey = this.getActivitySessionKey(originId, activity.tmuxSession);
    let activities = this.remoteActivities.get(activitySessionKey);
    if (!activities) {
      activities = [];
      this.remoteActivities.set(activitySessionKey, activities);
    }

    const recent = activities[0];
    if (
      recent &&
      recent.tool === activity.tool &&
      recent.fullPath === activity.fullPath &&
      Math.abs(recent.timestamp - activity.timestamp) < 2000
    ) {
      return;
    }

    activities.unshift(activity);
    if (activities.length > MAX_REMOTE_ACTIVITIES) {
      activities.pop();
    }
    this.saveActivityPersistence();

    const session = this.remoteSessions.get(originId)?.get(activity.tmuxSession);
    const now = Date.now();
    if (session && activity.fullPath) {
      this.recentFileTracker.recordTouch(session.id, activity.tool, activity.fullPath, activity.timestamp);
    }
    if (session && session.status !== 'working') {
      session.status = 'working';
      session.lastActivity = now;
      this.remoteWorkingSessions.touch(originId, activity.tmuxSession, now);
      this.callbacks.broadcastState();
    } else if (session) {
      session.lastActivity = now;
      this.remoteWorkingSessions.touch(originId, activity.tmuxSession, now);
    }

    this.callbacks.broadcastActivity(activity, originId);
  }

  handleAgentDisconnect(originId: string, sshHost?: string): void {
    const originSessionsMap = this.remoteSessions.get(originId);
    if (this.originManager.isOriginConnected(originId)) return;

    let activityChanged = false;
    if (originSessionsMap) {
      for (const [tmuxSession, session] of originSessionsMap) {
        if (session.cityId && session.workerHex) {
          this.cityManager.releaseWorkerHex(session.cityId, session.workerHex);
        }
        originSessionsMap.delete(tmuxSession);
        this.previousSessions.delete(session.id);
        this.recentFileTracker.removeSession(session.id);
        activityChanged = this.cleanupRemoteSessionData(originId, session) || activityChanged;
      }
    }
    activityChanged = this.pruneStaleRemoteActivities() || activityChanged;
    if (activityChanged) {
      this.saveActivityPersistence();
    }

    this.pruneRemoteGitStatus(originId, new Set<string>());
    this.remoteWorkingSessions.clearOrigin(originId);

    this.remoteSessions.delete(originId);
    this.callbacks.rebuildCities();
    this.callbacks.broadcastState();

    if (sshHost) {
      this.recoveryStates.set(originId, {
        originId,
        sshHost,
        disconnectedAt: Date.now(),
      });
      void this.recoverRemoteAgent(originId, sshHost);
    }
  }

  recoverDisconnectedAgents(now = Date.now()): void {
    for (const origin of this.originManager.getOrigins()) {
      if (origin.type !== 'remote' || !origin.sshHost || this.originManager.isOriginConnected(origin.id)) {
        continue;
      }
      const state = this.recoveryStates.get(origin.id);
      if (!state) continue;
      if (now - state.disconnectedAt < 15_000) continue;
      void this.recoverRemoteAgent(origin.id, origin.sshHost, now);
    }
  }

  private async recoverRemoteAgent(originId: string, sshHost: string, now = Date.now()): Promise<void> {
    const existing = this.recoveryStates.get(originId) ?? {
      originId,
      sshHost,
      disconnectedAt: now,
    };
    if (existing.inFlight) return;
    if (existing.lastAttemptAt && now - existing.lastAttemptAt < REMOTE_AGENT_RECOVERY_COOLDOWN_MS) {
      return;
    }

    existing.inFlight = true;
    existing.lastAttemptAt = now;
    existing.lastError = undefined;
    this.recoveryStates.set(originId, existing);

    try {
      console.log(`[RemoteAgent] ${sshHost}: tunnel/agent recovery starting`);
      existing.lastResult = await this.callbacks.recoverRemoteAgent(sshHost);
      console.log(`[RemoteAgent] ${sshHost}: ${existing.lastResult.message}`);
    } catch (error) {
      existing.lastError = errorMessage(error);
      console.error(`[RemoteAgent] ${sshHost}: recovery failed: ${existing.lastError}`);
    } finally {
      existing.inFlight = false;
    }
  }

  expireWorkingSessions(cutoff: number): boolean {
    let changed = false;
    const expired = this.remoteWorkingSessions.consumeExpired(cutoff);
    for (const { originId, tmuxSession } of expired) {
      const session = this.remoteSessions.get(originId)?.get(tmuxSession);
      if (!session || session.status !== 'working') continue;
      session.status = 'idle';
      changed = true;
    }
    return changed;
  }

  private getActivitySessionKey(originId: string, tmuxSession: string): string {
    return `${originId}:${tmuxSession}`;
  }

  private loadActivityPersistence(): void {
    if (!existsSync(ACTIVITY_PERSISTENCE_PATH)) return;
    try {
      const content = readFileSync(ACTIVITY_PERSISTENCE_PATH, 'utf-8');
      const data = JSON.parse(content) as RemoteActivityPersistence;
      if (data.version !== 1 || !data.activities) return;
      for (const [activitySessionKey, activities] of Object.entries(data.activities)) {
        this.remoteActivities.set(activitySessionKey, activities);
      }
      console.log(`[Activity] Loaded ${this.remoteActivities.size} remote session activities`);
    } catch (error) {
      console.error('[Activity] Failed to load persistence:', error);
    }
  }

  private saveActivityPersistence(): void {
    const dataDir = join(homedir(), '.portolan');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const activities: Record<string, ActivityEvent[]> = {};
    for (const [activitySessionKey, sessionActivities] of this.remoteActivities.entries()) {
      activities[activitySessionKey] = sessionActivities;
    }

    const data: RemoteActivityPersistence = { version: 1, activities };
    const tmpPath = `${ACTIVITY_PERSISTENCE_PATH}.tmp`;

    try {
      writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
      renameSync(tmpPath, ACTIVITY_PERSISTENCE_PATH);
    } catch (error) {
      console.error('[Activity] Failed to save persistence:', error);
    }
  }

  private pruneStaleRemoteActivities(): boolean {
    const activeKeys = new Set<string>();
    for (const [originId, sessionsByOrigin] of this.remoteSessions.entries()) {
      for (const tmuxSession of sessionsByOrigin.keys()) {
        activeKeys.add(this.getActivitySessionKey(originId, tmuxSession));
      }
    }

    let changed = false;
    for (const activitySessionKey of this.remoteActivities.keys()) {
      if (activeKeys.has(activitySessionKey)) continue;
      this.remoteActivities.delete(activitySessionKey);
      changed = true;
    }
    return changed;
  }

  private cleanupRemoteSessionData(originId: string, session: Session): boolean {
    let activityChanged = false;
    this.remoteWorkingSessions.clear(originId, session.tmuxSession);

    if (this.remoteActivities.delete(this.getActivitySessionKey(originId, session.tmuxSession))) {
      activityChanged = true;
    }

    return activityChanged;
  }

  private pruneRemoteGitStatus(originId: string, activeCwds: Set<string>): void {
    const prefix = `${originId}:`;
    for (const [key] of this.remoteGitStatuses.entries()) {
      if (!key.startsWith(prefix)) continue;
      const cwd = key.slice(prefix.length);
      if (activeCwds.has(cwd)) continue;
      this.remoteGitStatuses.delete(key);
    }
  }
}

export function portolanTunnelLabel(sshHost: string): string {
  return `com.cailmdaley.portolan-tunnel-${sshHost}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function legacyReconnectTunnel(sshHost: string): Promise<void> {
  try {
    await execFileAsync('ssh', ['-O', 'exit', sshHost]);
  } catch (error) {
    console.log(`ControlMaster exit for ${sshHost}: ${errorMessage(error)} (continuing)`);
  }

  await delay(1000);

  try {
    await execFileAsync('ssh', [
      '-f',
      '-S',
      'none',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ControlMaster=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      '4004:localhost:4004',
      sshHost,
      'sleep 3600',
    ]);
    console.log(`One-shot SSH tunnel to ${sshHost} re-established`);
  } catch (error) {
    console.error(`SSH tunnel reconnect to ${sshHost} failed:`, errorMessage(error));
  }
}

export async function reconnectTunnel(sshHost: string): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  if (uid !== null) {
    const target = `gui/${uid}/${portolanTunnelLabel(sshHost)}`;
    console.log(`Kickstarting launchd tunnel ${target}...`);

    try {
      await execFileAsync('launchctl', ['kickstart', '-k', target]);
      console.log(`Launchd tunnel ${target} kickstarted`);
      return;
    } catch (error) {
      console.log(`launchctl kickstart for ${target} failed: ${errorMessage(error)}; falling back to one-shot SSH reconnect`);
    }
  }

  await legacyReconnectTunnel(sshHost);
}

async function isRemotePortolanReachable(sshHost: string): Promise<boolean> {
  try {
    await execFileAsync(
      'ssh',
      ['-T', sshHost, 'curl -sS --connect-timeout 3 http://localhost:4004/debug-runtime >/dev/null'],
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForRemotePortolan(sshHost: string, timeoutMs = 20_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRemotePortolanReachable(sshHost)) {
      return true;
    }
    await delay(1_000);
  }
  return false;
}

async function startRemoteAgent(sshHost: string): Promise<void> {
  const agentCommand = `node ~/.local/bin/portolan-agent.js connect --ssh-host=${shellEscape(sshHost)}`;
  const remoteCommand = [
    `tmux kill-session -t ${shellEscape(`=${REMOTE_AGENT_TMUX_SESSION}:`)} 2>/dev/null || true`,
    `tmux new-session -d -s ${shellEscape(REMOTE_AGENT_TMUX_SESSION)} ${shellEscape(`bash -l -c ${shellEscape(agentCommand)}`)}`,
  ].join('; ');

  await execFileAsync('ssh', ['-T', sshHost, remoteCommand], { timeout: 30_000 });
}

export async function recoverRemoteAgent(sshHost: string): Promise<RemoteAgentRecoveryResult> {
  await reconnectTunnel(sshHost);

  const reachable = await waitForRemotePortolan(sshHost);
  if (!reachable) {
    return {
      sshHost,
      tunnel: 'unreachable',
      agent: 'failed',
      message: `${sshHost}: tunnel unreachable after kickstart; portolan-agent was not restarted`,
    };
  }

  try {
    await startRemoteAgent(sshHost);
    return {
      sshHost,
      tunnel: 'reachable',
      agent: 'restarted',
      message: `${sshHost}: tunnel reachable; restarted ${REMOTE_AGENT_TMUX_SESSION}`,
    };
  } catch (error) {
    return {
      sshHost,
      tunnel: 'reachable',
      agent: 'failed',
      message: `${sshHost}: tunnel reachable; failed to restart ${REMOTE_AGENT_TMUX_SESSION}: ${errorMessage(error)}`,
    };
  }
}
