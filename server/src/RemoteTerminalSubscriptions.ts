import type { WebSocket } from 'ws';

export interface RemoteTerminalSubscriptionEntry {
  originId: string;
  subscriptionId: string;
  tmuxSession: string;
}

export interface RemoteTerminalSubscriptionStats {
  originId: string;
  tmuxSession: string;
  browserClients: number;
  browserSessions: number;
  subscriptions: number;
}

export interface RemoteTerminalSendFrame {
  type: 'terminal:bytes' | 'terminal:exit';
  sessionId: string;
  bytes?: string;
  reason?: string;
}

export class RemoteTerminalSubscriptions {
  private readonly byClient = new Map<WebSocket, Map<string, RemoteTerminalSubscriptionEntry>>();
  private readonly bySubscription = new Map<string, {
    originId: string;
    tmuxSession: string;
    clients: Map<WebSocket, Set<string>>;
  }>();
  private readonly byTarget = new Map<string, string>();

  getStats(): RemoteTerminalSubscriptionStats[] {
    return [...this.bySubscription.entries()]
      .map(([, entry]) => ({
        originId: entry.originId,
        tmuxSession: entry.tmuxSession,
        browserClients: entry.clients.size,
        browserSessions: [...entry.clients.values()].reduce((total, sessions) => total + sessions.size, 0),
        subscriptions: 1,
      }))
      .sort((a, b) =>
        a.originId.localeCompare(b.originId) || a.tmuxSession.localeCompare(b.tmuxSession),
      );
  }

  hasTarget(originId: string, tmuxSession: string): boolean {
    return this.byTarget.has(this.targetKey(originId, tmuxSession));
  }

  getTargetSubscriptionId(originId: string, tmuxSession: string): string | undefined {
    return this.byTarget.get(this.targetKey(originId, tmuxSession));
  }

  set(ws: WebSocket, sessionId: string, entry: RemoteTerminalSubscriptionEntry): RemoteTerminalSubscriptionEntry | undefined {
    const previous = this.get(ws, sessionId);
    if (previous) this.delete(ws, sessionId);

    let perClient = this.byClient.get(ws);
    if (!perClient) {
      perClient = new Map();
      this.byClient.set(ws, perClient);
    }
    perClient.set(sessionId, entry);

    let backing = this.bySubscription.get(entry.subscriptionId);
    if (!backing) {
      backing = {
        originId: entry.originId,
        tmuxSession: entry.tmuxSession,
        clients: new Map(),
      };
      this.bySubscription.set(entry.subscriptionId, backing);
      this.byTarget.set(this.targetKey(entry.originId, entry.tmuxSession), entry.subscriptionId);
    }
    let clientSessions = backing.clients.get(ws);
    if (!clientSessions) {
      clientSessions = new Set();
      backing.clients.set(ws, clientSessions);
    }
    clientSessions.add(sessionId);
    return previous && !this.bySubscription.has(previous.subscriptionId) ? previous : undefined;
  }

  get(ws: WebSocket, sessionId: string): RemoteTerminalSubscriptionEntry | undefined {
    return this.byClient.get(ws)?.get(sessionId);
  }

  delete(ws: WebSocket, sessionId: string): RemoteTerminalSubscriptionEntry | undefined {
    const perClient = this.byClient.get(ws);
    if (!perClient) return undefined;
    const entry = perClient.get(sessionId);
    if (!entry) return undefined;
    perClient.delete(sessionId);
    if (perClient.size === 0) this.byClient.delete(ws);
    return this.detachFromBacking(ws, sessionId, entry);
  }

  deleteClient(ws: WebSocket): RemoteTerminalSubscriptionEntry[] {
    const perClient = this.byClient.get(ws);
    if (!perClient) return [];
    const entries: RemoteTerminalSubscriptionEntry[] = [];
    for (const [sessionId, entry] of perClient) {
      const unsubscribe = this.detachFromBacking(ws, sessionId, entry);
      if (unsubscribe) entries.push(unsubscribe);
    }
    this.byClient.delete(ws);
    return entries;
  }

  routeBytes(originId: string, subscriptionId: string, bytesBase64: string): void {
    this.route(originId, subscriptionId, ({ sessionId }) => ({
      type: 'terminal:bytes',
      sessionId,
      bytes: bytesBase64,
    }));
  }

  routeExit(originId: string, subscriptionId: string, reason?: string): void {
    this.route(originId, subscriptionId, ({ sessionId }) => ({
      type: 'terminal:exit',
      sessionId,
      reason,
    }), { remove: true });
  }

  closeOrigin(originId: string, reason: string): void {
    for (const [ws, perClient] of this.byClient) {
      for (const [sessionId, entry] of [...perClient]) {
        if (entry.originId !== originId) continue;
        this.sendIfOpen(ws, { type: 'terminal:exit', sessionId, reason });
        perClient.delete(sessionId);
      }
      if (perClient.size === 0) this.byClient.delete(ws);
    }
    for (const [subscriptionId, entry] of [...this.bySubscription]) {
      if (entry.originId !== originId) continue;
      this.bySubscription.delete(subscriptionId);
      this.byTarget.delete(this.targetKey(entry.originId, entry.tmuxSession));
    }
  }

  private route(
    originId: string,
    subscriptionId: string,
    makeFrame: (match: { ws: WebSocket; sessionId: string }) => RemoteTerminalSendFrame,
    options: { remove?: boolean } = {},
  ): void {
    for (const [ws, perClient] of this.byClient) {
      for (const [sessionId, entry] of [...perClient]) {
        if (entry.originId !== originId || entry.subscriptionId !== subscriptionId) continue;
        this.sendIfOpen(ws, makeFrame({ ws, sessionId }));
        if (options.remove) perClient.delete(sessionId);
      }
      if (perClient.size === 0) this.byClient.delete(ws);
    }
    if (options.remove) {
      const entry = this.bySubscription.get(subscriptionId);
      if (entry) {
        this.bySubscription.delete(subscriptionId);
        this.byTarget.delete(this.targetKey(entry.originId, entry.tmuxSession));
      }
    }
  }

  private sendIfOpen(ws: WebSocket, frame: RemoteTerminalSendFrame): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  private detachFromBacking(
    ws: WebSocket,
    sessionId: string,
    entry: RemoteTerminalSubscriptionEntry,
  ): RemoteTerminalSubscriptionEntry | undefined {
    const backing = this.bySubscription.get(entry.subscriptionId);
    if (!backing) return entry;
    const sessions = backing.clients.get(ws);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) backing.clients.delete(ws);
    if (backing.clients.size > 0) return undefined;
    this.bySubscription.delete(entry.subscriptionId);
    this.byTarget.delete(this.targetKey(entry.originId, entry.tmuxSession));
    return entry;
  }

  private targetKey(originId: string, tmuxSession: string): string {
    return `${originId}\0${tmuxSession}`;
  }
}
