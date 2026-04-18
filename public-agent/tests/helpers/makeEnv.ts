/**
 * Standalone env factory — use this when you only need an Env, not a full app.
 */
import type { Env } from '../../src/env.js';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    openRouterApiKey: 'test-key',
    openRouterModel: 'test-model',
    port: 4200,
    agentName: 'test-agent',
    authKey: null,
    allowPublicUnauthenticated: false,
    maxTokensPerDay: 0,
    talkRateLimitPerMin: 60,
    dataDir: '/tmp/test-data',
    trustedProxy: true,
    maxReplyTokens: 1024,
    maxSessions: 100,
    sessionIdleMinutes: 60,
    maxTurnsPerSession: 50,
    guardModel: 'test-model',
    maxGuardTokens: 256,
    maxMessageChars: 8000,
    knowledgeDir: '/tmp/test-knowledge',
    upstreamDeadlineMs: 45000,
    maxRetryAfterMs: 10000,
    requestDeadlineMs: 60000,
    ...overrides,
  };
}
