import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Env {
  openRouterApiKey: string;
  openRouterModel: string;
  /** Public listener port — serves /talk, /health, /identity, /.well-known/* */
  port: number;
  /** Operator listener port — serves /inbox, /news, /mcp */
  operatorPort: number;
  /** Public listener bind host. Defaults to 0.0.0.0 (internet-reachable). */
  publicHost: string;
  /** Operator listener bind host. Defaults to 127.0.0.1 (loopback-only). */
  operatorHost: string;
  /** Absolute public URL advertised in /.well-known (must be an HTTPS URL). */
  publicUrl: string;
  /** Service version — read from package.json at startup. */
  version: string;
  agentName: string;
  authKey: string | null;
  allowPublicUnauthenticated: boolean;
  maxTokensPerDay: number;
  talkRateLimitPerMin: number;
  dataDir: string;
  trustedProxy: boolean;
  maxReplyTokens: number;
  maxSessions: number;
  sessionIdleMinutes: number;
  maxTurnsPerSession: number;
  guardModel: string;
  maxGuardTokens: number;
  maxMessageChars: number;
  knowledgeDir: string;
  upstreamDeadlineMs: number;
  maxRetryAfterMs: number;
  requestDeadlineMs: number;
  /** When true, /talk returns 503. /health and /.well-known stay up. */
  maintenance: boolean;
  /** Path to identity.json on disk (delivered by manager via SSH). */
  identityPath: string;
  /** When true, startup boot timestamp for /health uptime calculations. */
  bootTimeMs: number;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function intOr(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env var ${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/env.ts → ../package.json when running via tsx; dist/env.js → ../package.json when compiled.
    const candidates = [
      path.resolve(here, '../package.json'),
      path.resolve(here, '../../package.json'),
    ];
    for (const p of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg && typeof pkg.version === 'string') return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function derivePublicUrl(name: string, host: string | undefined): string {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const publicHost = process.env.PUBLIC_HOST?.trim();
  if (publicHost) return `https://${publicHost}`;
  throw new Error(
    `Missing required env var PUBLIC_URL (or PUBLIC_HOST fallback). Set PUBLIC_URL=https://<your-domain> so /.well-known/restap.json can advertise an absolute public URL.`,
  );
}

export function loadEnv(): Env {
  const agentName = process.env.PUBLIC_AGENT_NAME?.trim() || 'public-agent';
  const publicUrl = derivePublicUrl(agentName, process.env.PUBLIC_HOST);
  return {
    openRouterApiKey: required('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY),
    openRouterModel: required('OPENROUTER_MODEL', process.env.OPENROUTER_MODEL),
    port: intOr('PUBLIC_AGENT_PORT', process.env.PUBLIC_AGENT_PORT, 4200),
    operatorPort: intOr('OPERATOR_PORT', process.env.OPERATOR_PORT, 4201),
    publicHost: process.env.PUBLIC_AGENT_HOST?.trim() || '0.0.0.0',
    operatorHost: process.env.OPERATOR_HOST?.trim() || '127.0.0.1',
    publicUrl,
    version: readPackageVersion(),
    agentName,
    authKey: process.env.PUBLIC_AGENT_AUTH_KEY?.trim() || null,
    allowPublicUnauthenticated: process.env.ALLOW_PUBLIC_UNAUTHENTICATED === 'true',
    maxTokensPerDay: intOr('MAX_TOKENS_PER_DAY', process.env.MAX_TOKENS_PER_DAY, 0),
    talkRateLimitPerMin: intOr('TALK_RATE_LIMIT_PER_MIN', process.env.TALK_RATE_LIMIT_PER_MIN, 10),
    dataDir: process.env.PUBLIC_AGENT_DATA_DIR?.trim() || '/app/data',
    trustedProxy: (process.env.TRUSTED_PROXY ?? '').trim().toLowerCase() === 'true',
    maxReplyTokens: intOr('MAX_REPLY_TOKENS', process.env.MAX_REPLY_TOKENS, 1024),
    maxSessions: intOr('MAX_SESSIONS', process.env.MAX_SESSIONS, 100),
    sessionIdleMinutes: intOr('SESSION_IDLE_MINUTES', process.env.SESSION_IDLE_MINUTES, 60),
    maxTurnsPerSession: intOr('MAX_TURNS_PER_SESSION', process.env.MAX_TURNS_PER_SESSION, 50),
    guardModel: process.env.GUARD_MODEL?.trim() || process.env.OPENROUTER_MODEL || required('OPENROUTER_MODEL', process.env.OPENROUTER_MODEL),
    maxGuardTokens: intOr('MAX_GUARD_TOKENS', process.env.MAX_GUARD_TOKENS, 256),
    maxMessageChars: intOr('MAX_MESSAGE_CHARS', process.env.MAX_MESSAGE_CHARS, 8000),
    knowledgeDir: process.env.PUBLIC_AGENT_KNOWLEDGE_DIR?.trim() || '/app/knowledge',
    upstreamDeadlineMs: intOr('UPSTREAM_DEADLINE_MS', process.env.UPSTREAM_DEADLINE_MS, 45000),
    maxRetryAfterMs: intOr('MAX_RETRY_AFTER_MS', process.env.MAX_RETRY_AFTER_MS, 10000),
    requestDeadlineMs: intOr('REQUEST_DEADLINE_MS', process.env.REQUEST_DEADLINE_MS, 60000),
    maintenance: process.env.MAINTENANCE === 'true',
    identityPath: process.env.IDENTITY_PATH?.trim() || '/opt/public-agent/identity.json',
    bootTimeMs: Date.now(),
  };
}
