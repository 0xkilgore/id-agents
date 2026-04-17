export interface Env {
  openRouterApiKey: string;
  openRouterModel: string;
  port: number;
  agentName: string;
  authKey: string | null;
  maxTokensPerDay: number;
  talkRateLimitPerMin: number;
  dataDir: string;
  trustedProxy: boolean;
  maxReplyTokens: number;
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

export function loadEnv(): Env {
  return {
    openRouterApiKey: required('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY),
    openRouterModel: required('OPENROUTER_MODEL', process.env.OPENROUTER_MODEL),
    port: intOr('PUBLIC_AGENT_PORT', process.env.PUBLIC_AGENT_PORT, 4200),
    agentName: process.env.PUBLIC_AGENT_NAME?.trim() || 'public-agent',
    authKey: process.env.PUBLIC_AGENT_AUTH_KEY?.trim() || null,
    maxTokensPerDay: intOr('MAX_TOKENS_PER_DAY', process.env.MAX_TOKENS_PER_DAY, 0),
    talkRateLimitPerMin: intOr('TALK_RATE_LIMIT_PER_MIN', process.env.TALK_RATE_LIMIT_PER_MIN, 10),
    dataDir: process.env.PUBLIC_AGENT_DATA_DIR?.trim() || '/app/data',
    trustedProxy: (process.env.TRUSTED_PROXY ?? '').trim().toLowerCase() === 'true',
    maxReplyTokens: intOr('MAX_REPLY_TOKENS', process.env.MAX_REPLY_TOKENS, 1024),
  };
}
