import type { Env } from './env.js';

export function buildCatalog(env: Env) {
  return {
    service_type: 'public-agent',
    version: env.version,
    name: env.agentName,
    endpoints: {
      talk: '/talk',
      news: '/news',
      well_known: '/.well-known/restap.json',
      health: '/health',
      identity: '/identity',
    },
    capabilities: ['talk', 'news', 'search_knowledge', 'read_knowledge'],
    auth: {
      talk: 'none',
      operator: 'ssh-tunnel',
    },
    limits: {
      max_message_chars: env.maxMessageChars,
      talk_rate_per_min: env.talkRateLimitPerMin,
    },
    public_url: env.publicUrl,
  };
}
