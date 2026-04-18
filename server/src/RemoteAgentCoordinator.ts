import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { ActivityEvent } from './EventWatcher.js';
import type { GitStatus } from './GitStatusManager.js';
import type { AgentActivityMessage, AgentSessionsUpdateMessage } from './MessageRouter.js';
import { OriginManager } from './OriginManager.js';
import { RecentFileTracker } from './RecentFileTracker.js';
import { RemoteWorkingSessionTracker } from './RemoteWorkingSessionTracker.js';
import type { Session } from './SessionTracker.js';
import { CityManager, type City } from './CityManager.js';

const ACTIVITY_PERSISTENCE_PATH = join(homedir(), '.portolan', 'remote-activities.json');
const MAX_REMOTE_ACTIVITIES = 50;

interface RemoteActivityPersistence {
  version: 1;
  activities: Record<string, ActivityEvent[]>;
}

interface RemoteAgentCoordinatorCallbacks {
  assignSessionToCity(session: Session, city: City): void;
  broadcastActivity(activity: ActivityEvent, originId: string): void;
  broadcastState(): void;
  rebuildCities(): void;
  reconnectTunnel(sshHost: string): void | Promise<void>;
}

export class RemoteAgentCoordinator {
  private remoteSessions = new Map<string, Map<string, Session>>();
  private remoteGitStatuses = new Map<string, GitStatus>();
  private remoteActivities = new Map<string, ActivityEvent[]>();
  private remoteWorkingSessions = new RemoteWorkingSessionTracker();

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
    if (!originSessionsMap || this.originManager.isOriginConnected(originId)) return;

    let activityChanged = false;
    for (const [tmuxSession, session] of originSessionsMap) {
      if (session.cityId && session.workerHex) {
        this.cityManager.releaseWorkerHex(session.cityId, session.workerHex);
      }
      originSessionsMap.delete(tmuxSession);
      this.previousSessions.delete(session.id);
      this.recentFileTracker.removeSession(session.id);
      activityChanged = this.cleanupRemoteSessionData(originId, session) || activityChanged;
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
      this.callbacks.reconnectTunnel(sshHost);
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

export function reconnectTunnel(sshHost: string): Promise<void> {
  return new Promise((resolve) => {
    console.log(`Reconnecting SSH tunnel to ${sshHost}...`);
    // Kill stale ControlMaster first — without this, ssh -fN multiplexes
    // through the dead master and the RemoteForward never re-establishes.
    execFile('ssh', ['-O', 'exit', sshHost], (exitError) => {
      if (exitError) {
        console.log(`ControlMaster exit for ${sshHost}: ${exitError.message} (continuing)`);
      }
      setTimeout(() => {
        execFile('ssh', ['-fN', sshHost], (error) => {
          if (error) {
            console.error(`SSH tunnel reconnect to ${sshHost} failed:`, error.message);
          } else {
            console.log(`SSH tunnel to ${sshHost} re-established`);
          }
          resolve();
        });
      }, 1000);
    });
  });
}
