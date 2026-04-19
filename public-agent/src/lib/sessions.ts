import crypto from 'node:crypto';
import type { Env } from '../env.js';
import type { ChatMessage } from './openrouter.js';

// In-memory session store for /talk. Public clients (REST + MCP) cannot be
// trusted to maintain history themselves, so the server threads turns by
// session_id. State is process-local and dies on restart — persistence is a
// future concern.

export interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  lastAccessedAt: number;
  turnCount: number;
}

export interface SessionStore {
  getOrCreate(sessionId?: string | null): { session: Session; created: boolean };
  append(id: string, role: ChatMessage['role'], content: string): void;
  all(): Session[];
  purgeIdle(now?: number): number;
  size(): number;
  limits(): { maxSessions: number; idleMs: number; maxTurns: number };
}

function newSessionId(): string {
  return crypto.randomUUID();
}

export function createSessionStore(env: Env): SessionStore {
  const sessions = new Map<string, Session>();
  const idleMs = env.sessionIdleMinutes * 60_000;
  const maxSessions = env.maxSessions;
  const maxTurns = env.maxTurnsPerSession;

  function purgeIdle(now: number = Date.now()): number {
    if (idleMs <= 0) return 0;
    let removed = 0;
    for (const [id, s] of sessions) {
      if (now - s.lastAccessedAt > idleMs) {
        sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  function evictOldest(): void {
    if (maxSessions <= 0) return;
    while (sessions.size >= maxSessions) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [id, s] of sessions) {
        if (s.lastAccessedAt < oldestAt) {
          oldestAt = s.lastAccessedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      sessions.delete(oldestId);
    }
  }

  return {
    getOrCreate(sessionId) {
      const now = Date.now();
      purgeIdle(now);
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
          existing.lastAccessedAt = now;
          return { session: existing, created: false };
        }
      }
      evictOldest();
      const id = newSessionId();
      const session: Session = {
        id,
        messages: [],
        createdAt: now,
        lastAccessedAt: now,
        turnCount: 0,
      };
      sessions.set(id, session);
      return { session, created: true };
    },
    append(id, role, content) {
      const s = sessions.get(id);
      if (!s) return;
      s.messages.push({ role, content });
      s.lastAccessedAt = Date.now();
      if (role === 'user') s.turnCount += 1;
    },
    all() {
      return Array.from(sessions.values());
    },
    purgeIdle,
    size() {
      return sessions.size;
    },
    limits() {
      return { maxSessions, idleMs, maxTurns };
    },
  };
}
