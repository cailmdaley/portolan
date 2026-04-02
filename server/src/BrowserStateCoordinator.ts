import { execFile } from 'child_process';
import { promisify } from 'util';

import { WebSocket } from 'ws';

import { countOpenFibers, getOpenFibers, getRecentlyClosed } from './FiberReader.js';
import type { ActivityEvent } from './EventWatcher.js';
import type { GitStatus } from './GitStatusManager.js';
import type { MeetingBridgeState } from './MeetingBridge.js';
import { expandHome, shellEscape } from './ShellPathUtils.js';
import type { Origin, OriginManager } from './OriginManager.js';
import { reconcilePreviousLocalSessions } from './PreviousSessionReconciler.js';
import type { RecentFileTracker } from './RecentFileTracker.js';
import type { Session } from './SessionTracker.js';
import type { City, CityManager, SessionInfo } from './CityManager.js';
import type { CityPersistence } from './CityPersistence.js';
import type { EventWatcher } from './EventWatcher.js';
import type { GitStatusManager } from './GitStatusManager.js';

const execFileAsync = promisify(execFile);

export interface StateUpdate {
  cities: City[];
  sessions: Session[];
  origins?: Origin[];
  activities?: Record<string, ActivityEvent[]>;
  meetingBridge?: MeetingBridgeState | null;
}

interface SessionLookup {
  getAllSessions(): Session[];
}

interface RemoteAgentStateSource {
  getActivities(originId: string, tmuxSession: string): ActivityEvent[];
  getAllSessions(): Session[];
  getGitStatus(originId: string, path: string): GitStatus | undefined;
}

interface BrowserStateCoordinatorOptions {
  cityManager: CityManager;
  cityPersistence: CityPersistence;
  eventWatcher: EventWatcher;
  gitStatusManager: GitStatusManager;
  originManager: OriginManager;
  previousSessions: Map<string, Session>;
  recentFileTracker: RecentFileTracker;
  sessionLookup: SessionLookup;
  getMeetingState?: () => MeetingBridgeState | null;
  localOriginId?: string;
}

export class BrowserStateCoordinator {
  private readonly clients = new Set<WebSocket>();
  private readonly localOriginId: string;
  private lastBroadcastState: StateUpdate | null = null;
  private fiberRefreshIntervalHandle: NodeJS.Timeout | null = null;
  private remoteAgentStateSource: RemoteAgentStateSource | null = null;

  constructor(private options: BrowserStateCoordinatorOptions) {
    this.localOriginId = options.localOriginId ?? 'local';
  }

  setRemoteAgentStateSource(remoteAgentStateSource: RemoteAgentStateSource): void {
    this.remoteAgentStateSource = remoteAgentStateSource;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  startFiberRefresh(intervalMs: number): void {
    if (this.fiberRefreshIntervalHandle) return;
    this.fiberRefreshIntervalHandle = setInterval(() => {
      void this.refreshFiberCounts();
    }, intervalMs);
  }

  stop(): void {
    if (!this.fiberRefreshIntervalHandle) return;
    clearInterval(this.fiberRefreshIntervalHandle);
    this.fiberRefreshIntervalHandle = null;
  }

  isFiberRefreshActive(): boolean {
    return this.fiberRefreshIntervalHandle !== null;
  }

  async attachClient(ws: WebSocket): Promise<void> {
    this.clients.add(ws);
    const state = await this.buildState();
    ws.send(JSON.stringify(state));
  }

  detachClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  assignSessionToCity(session: Session, city: City): void {
    const previousCityId = session.cityId;
    if (previousCityId !== city.id) {
      if (previousCityId && session.workerHex) {
        this.options.cityManager.releaseWorkerHex(previousCityId, session.workerHex);
      }
      session.cityId = city.id;
      session.workerHex = this.options.cityManager.assignWorkerHex(city.id);
    } else if (!session.workerHex) {
      session.workerHex = this.options.cityManager.assignWorkerHex(city.id);
    }
  }

  async buildState(): Promise<StateUpdate> {
    const sessions = this.options.sessionLookup.getAllSessions();
    const cities = this.options.cityManager.getCities();

    this.options.cityManager.updateClaimsStatus();
    this.options.cityManager.updatePlaygroundsStatus();

    const activeCityIds = new Set(sessions.filter((session) => session.cityId).map((session) => session.cityId));

    const citiesWithFibers = await Promise.all(
      cities.map(async (city) => {
        let gitStatus: GitStatus | undefined;
        if (city.originId === this.localOriginId) {
          gitStatus = this.options.gitStatusManager.getStatus(city.path) ?? undefined;
        } else {
          gitStatus = this.remoteAgentStateSource?.getGitStatus(city.originId, city.path);
        }

        return {
          ...city,
          fiberCount: city.originId === this.localOriginId ? await countOpenFibers(city.path) : 0,
          hasClaims: city.hasClaims ?? false,
          hasPlaygrounds: city.hasPlaygrounds ?? false,
          isDormant: !activeCityIds.has(city.id),
          gitStatus,
        };
      }),
    );

    const cityMap = new Map(cities.map((city) => [city.id, city]));
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

    const activities: Record<string, ActivityEvent[]> = {};
    for (const session of sessions) {
      const activitySessionKey = this.getActivitySessionKey(session.originId, session.tmuxSession);
      const sessionActivities = session.originId === this.localOriginId
        ? this.options.eventWatcher.getRecentActivities(session.tmuxSession)
        : this.remoteAgentStateSource?.getActivities(session.originId, session.tmuxSession) ?? [];
      if (sessionActivities.length > 0) {
        activities[activitySessionKey] = sessionActivities;
      }
    }

    return {
      cities: citiesWithFibers,
      sessions: sessionsWithAbsoluteHex,
      origins: this.options.originManager.getOrigins(),
      activities,
      meetingBridge: this.options.getMeetingState?.() ?? null,
    };
  }

  broadcast(state: StateUpdate): void {
    const message = JSON.stringify(state);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
    this.lastBroadcastState = state;
  }

  broadcastActivity(activity: ActivityEvent, originId: string): void {
    const message = JSON.stringify({
      type: 'activity',
      activity: {
        ...activity,
        originId,
        activitySessionKey: this.getActivitySessionKey(originId, activity.tmuxSession),
      },
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  async broadcastCurrentState(): Promise<void> {
    this.broadcast(await this.buildState());
  }

  async handleLocalSessionsChange(localSessions: Session[]): Promise<void> {
    this.options.eventWatcher.reconcileActiveSessions(localSessions.map((session) => session.tmuxSession));

    const removedLocalSessions = reconcilePreviousLocalSessions(
      this.options.previousSessions,
      localSessions,
      this.localOriginId,
    );

    for (const removedSession of removedLocalSessions) {
      if (removedSession.cityId && removedSession.workerHex) {
        this.options.cityManager.releaseWorkerHex(removedSession.cityId, removedSession.workerHex);
      }
      this.options.recentFileTracker.removeSession(removedSession.id);
    }

    this.rebuildCities();

    for (const session of localSessions) {
      if (!session.cwd) continue;
      const city = this.options.cityManager.findCityForPath(session.cwd, session.originId);
      if (!city) continue;
      this.assignSessionToCity(session, city);
    }

    await this.broadcastCurrentState();
  }

  rebuildCities(): void {
    const allSessions = this.options.sessionLookup.getAllSessions();
    const sessionInfos: SessionInfo[] = allSessions
      .filter((session) => session.cwd)
      .map((session) => ({ cwd: session.cwd, originId: session.originId }));
    this.options.cityManager.updateFromSessions(sessionInfos);

    for (const city of this.options.cityManager.getCities()) {
      if (!this.options.cityManager.isPinned(city.id)) {
        const sshHost = city.originId !== this.localOriginId
          ? this.options.originManager.getOrigin(city.originId)?.sshHost
          : undefined;
        this.options.cityPersistence.pin(city.path, city.position, city.originId, city.name, sshHost);
        this.options.cityManager.addPinnedCity(city.id, city.path, city.name, city.position, city.originId);
      } else if (city.originId !== this.localOriginId) {
        const origin = this.options.originManager.getOrigin(city.originId);
        const persistedCity = this.options.cityPersistence.getCityById(city.id);
        if (origin?.sshHost && persistedCity && !persistedCity.sshHost) {
          this.options.cityPersistence.pin(city.path, city.position, city.originId, city.name, origin.sshHost);
        }
      }

      if (city.originId === this.localOriginId) {
        this.options.gitStatusManager.track(city.path);
      }
    }
  }

  async handleGetFibers(ws: WebSocket, cityId: string): Promise<void> {
    const city = this.options.cityManager.getCityById(cityId);
    if (!city) {
      ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
      return;
    }

    try {
      if (city.originId === this.localOriginId) {
        const [open, recentlyClosed] = await Promise.all([
          getOpenFibers(city.path),
          getRecentlyClosed(city.path, 5),
        ]);
        ws.send(JSON.stringify({ type: 'fibers', cityId, open, recentlyClosed }));
        return;
      }

      const origin = this.options.originManager.getOrigin(city.originId);
      if (!origin?.sshHost) {
        ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
        return;
      }

      const [open, recentlyClosed] = await Promise.all([
        this.getRemoteFibers(origin.sshHost, city.path, 'open'),
        this.getRemoteFibers(origin.sshHost, city.path, 'closed'),
      ]);
      ws.send(JSON.stringify({ type: 'fibers', cityId, open, recentlyClosed }));
    } catch (error) {
      console.error('Failed to get fibers:', error);
      ws.send(JSON.stringify({ type: 'fibers', cityId, open: [], recentlyClosed: [] }));
    }
  }

  handlePinCity(
    ws: WebSocket,
    path: string,
    position: { q: number; r: number },
    name?: string,
  ): void {
    try {
      const expandedPath = expandHome(path);
      const city = this.options.cityManager.pinCity(expandedPath, position, this.localOriginId, name);
      this.options.cityPersistence.pin(expandedPath, position, this.localOriginId, name || city.name);
      console.log(`City pinned: ${city.name} at (${position.q}, ${position.r})`);
      void this.broadcastCurrentState();
      ws.send(JSON.stringify({ type: 'cityPinned', city }));
    } catch (error) {
      console.error('Failed to pin city:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to pin city' }));
    }
  }

  handleUnpinCity(ws: WebSocket, cityId: string): void {
    try {
      const allSessions = this.options.sessionLookup.getAllSessions();
      const city = this.options.cityManager.getCityById(cityId);
      if (!city) {
        ws.send(JSON.stringify({ type: 'error', message: 'City not found' }));
        return;
      }

      const sessionCount = allSessions.filter(
        (session) => session.cwd && session.cwd === city.path && session.originId === city.originId,
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

      this.performUnpin(ws, cityId);
    } catch (error) {
      console.error('Failed to unpin city:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to unpin city' }));
    }
  }

  performUnpin(ws: WebSocket, cityId: string): void {
    const city = this.options.cityManager.getCityById(cityId);
    if (!city) return;

    this.options.cityManager.unpinCity(cityId);
    this.options.cityPersistence.unpin(cityId);
    console.log(`City unpinned: ${city.name}`);

    this.rebuildCities();
    void this.broadcastCurrentState();
    ws.send(JSON.stringify({ type: 'cityUnpinned', cityId }));
  }

  handleMoveCity(
    ws: WebSocket,
    cityId: string,
    newPosition: { q: number; r: number },
  ): void {
    try {
      const city = this.options.cityManager.getCityById(cityId);
      if (!city) {
        ws.send(JSON.stringify({ type: 'error', message: 'City not found' }));
        return;
      }

      if (!this.options.cityManager.isPinned(cityId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Can only move pinned cities' }));
        return;
      }

      this.options.cityManager.moveCity(cityId, newPosition);
      this.options.cityPersistence.updatePosition(cityId, newPosition);
      console.log(`City moved: ${city.name} to (${newPosition.q}, ${newPosition.r})`);

      void this.broadcastCurrentState();
      ws.send(JSON.stringify({ type: 'cityMoved', cityId, newPosition }));
    } catch (error) {
      console.error('Failed to move city:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to move city' }));
    }
  }

  private getActivitySessionKey(originId: string, tmuxSession: string): string {
    return `${originId}:${tmuxSession}`;
  }

  private async refreshFiberCounts(): Promise<void> {
    const state = await this.buildState();
    if (!this.fiberCountsChanged(this.lastBroadcastState, state)) return;
    console.log('Fiber counts changed, broadcasting update');
    this.broadcast(state);
  }

  private fiberCountsChanged(oldState: StateUpdate | null, newState: StateUpdate): boolean {
    if (!oldState) return true;
    if (oldState.cities.length !== newState.cities.length) return true;
    for (const newCity of newState.cities) {
      const oldCity = oldState.cities.find((city) => city.id === newCity.id);
      if (!oldCity || oldCity.fiberCount !== newCity.fiberCount) return true;
    }
    return false;
  }

  private async getRemoteFibers(
    sshHost: string,
    cityPath: string,
    status: 'open' | 'closed',
  ): Promise<Array<{ id: string; title: string; kind: string; status: string; body?: string; outcome?: string }>> {
    const escapedPath = shellEscape(cityPath);
    const statusFlag = status === 'open' ? '-s open' : '-s closed';
    const recentFlag = status === 'closed' ? '--recent 5' : '';

    try {
      const { stdout } = await execFileAsync(
        'ssh',
        [sshHost, `cd ${escapedPath} && felt ls ${statusFlag} ${recentFlag} --json --body 2>/dev/null || echo '[]'`],
        { timeout: 10000 },
      );
      const fibers = JSON.parse(stdout.trim() || '[]');
      return fibers.map((fiber: any) => ({
        id: fiber.id,
        title: fiber.title,
        kind: fiber.kind || 'task',
        status: fiber.status || status,
        body: fiber.body || undefined,
        outcome: fiber.outcome || fiber.close_reason || undefined,
      }));
    } catch (error) {
      console.error(`Failed to get remote fibers from ${sshHost}:${cityPath}:`, error);
      return [];
    }
  }
}
