import type { WebSocket } from 'ws';

export interface RemoteTerminalSubscriptionEntry {
  originId: string;
  subscriptionId: string;
}

export interface RemoteTerminalSubscriptionStats {
  originId: string;
  browserClients: number;
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

  getStats(): RemoteTerminalSubscriptionStats[] {
    const byOrigin = new Map<string, { browserClients: Set<WebSocket>; subscriptions: number }>();
    for (const [ws, perClient] of this.byClient) {
      for (const entry of perClient.values()) {
        let stats = byOrigin.get(entry.originId);
        if (!stats) {
          stats = { browserClients: new Set(), subscriptions: 0 };
          byOrigin.set(entry.originId, stats);
        }
        stats.browserClients.add(ws);
        stats.subscriptions += 1;
      }
    }
    return [...byOrigin.entries()]
      .map(([originId, stats]) => ({
        originId,
        browserClients: stats.browserClients.size,
        subscriptions: stats.subscriptions,
      }))
      .sort((a, b) => a.originId.localeCompare(b.originId));
  }

  set(ws: WebSocket, sessionId: string, entry: RemoteTerminalSubscriptionEntry): void {
    let perClient = this.byClient.get(ws);
    if (!perClient) {
      perClient = new Map();
      this.byClient.set(ws, perClient);
    }
    perClient.set(sessionId, entry);
  }

  get(ws: WebSocket, sessionId: string): RemoteTerminalSubscriptionEntry | undefined {
    return this.byClient.get(ws)?.get(sessionId);
  }

  delete(ws: WebSocket, sessionId: string): boolean {
    const perClient = this.byClient.get(ws);
    if (!perClient) return false;
    const deleted = perClient.delete(sessionId);
    if (perClient.size === 0) this.byClient.delete(ws);
    return deleted;
  }

  deleteClient(ws: WebSocket): RemoteTerminalSubscriptionEntry[] {
    const perClient = this.byClient.get(ws);
    if (!perClient) return [];
    const entries = [...perClient.values()];
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
  }

  private sendIfOpen(ws: WebSocket, frame: RemoteTerminalSendFrame): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}
