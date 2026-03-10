import { Session } from './SessionTracker.js';

/**
 * Keep previousSessions bounded for local lifecycle ownership.
 * Returns local sessions that disappeared since the prior snapshot.
 */
export function reconcilePreviousLocalSessions(
  previousSessions: Map<string, Session>,
  localSessions: Session[],
  localOriginId = 'local',
): Session[] {
  const activeLocalSessionIds = new Set(localSessions.map((session) => session.id));
  const removedLocalSessions: Session[] = [];

  for (const [sessionId, previousSession] of previousSessions.entries()) {
    if (previousSession.originId !== localOriginId) continue;
    if (activeLocalSessionIds.has(sessionId)) continue;
    previousSessions.delete(sessionId);
    removedLocalSessions.push(previousSession);
  }

  for (const session of localSessions) {
    previousSessions.set(session.id, session);
  }

  return removedLocalSessions;
}
