import type { Env } from './env.js';

export function buildCatalog(env: Env) {
  const authed = env.authKey !== null;
  return {
    restap_version: '1.0',
    agent: {
      name: env.agentName,
      description: 'Public-facing assistant. Synchronous Q&A over OpenRouter. External messages land in an inbox for human review.',
      role: 'public-assistant',
      expertise: [],
      status: 'available',
    },
    provider: {
      name: 'openrouter',
      version: '1.0',
      model: env.openRouterModel,
    },
    endpoints: {
      talk: '/talk',
      news: '/news',
      news_post: '/news',
      catalog: '/.well-known/restap.json',
      skill: '/.well-known/skill.md',
      inbox: '/inbox',
      mcp: '/mcp',
    },
    mcp_endpoint: '/mcp',
    capabilities: [
      {
        id: 'talk',
        title: 'Ask a question',
        method: 'POST',
        endpoint: '/talk',
        description: 'Synchronous Q&A. Returns the LLM reply in the response body. Every call is appended to the inbox for human review.',
        input_schema: { message: 'string (required)', from: 'string (optional)' },
      },
      {
        id: 'news-get',
        title: 'Tail public news feed',
        method: 'GET',
        endpoint: '/news',
        description: 'Read-only tail. Query ?since_id=N to poll.',
        input_schema: { since_id: 'number (optional)', limit: 'number (optional)' },
      },
      {
        id: 'news-post',
        title: 'Push a notification from a trusted caller',
        method: 'POST',
        endpoint: '/news',
        description: 'Fire-and-forget notify. No reply. Local id-agents team members push here.',
        input_schema: { type: 'string (optional)', from: 'string (required)', message: 'string (required)', data: 'object (optional)' },
      },
      {
        id: 'inbox-list',
        title: 'List external messages awaiting human review',
        method: 'GET',
        endpoint: '/inbox',
        input_schema: { status: "'unread' | 'archived' | 'all' (optional)" },
      },
      {
        id: 'inbox-archive',
        title: 'Mark an inbox entry reviewed',
        method: 'POST',
        endpoint: '/inbox/:id/archive',
        input_schema: { id: 'string (path)' },
      },
      {
        id: 'mcp',
        title: 'HTTP MCP shim (JSON-RPC 2.0)',
        method: 'POST',
        endpoint: '/mcp',
        description: 'MCP transport. Exposes two tools (talk, news) that relay to the REST endpoints.',
        input_schema: { jsonrpc: '"2.0"', id: 'number|string', method: 'initialize|tools/list|tools/call', params: 'object' },
      },
    ],
    mode: 'synchronous',
    trust: {
      direction: 'inbound-only',
      inbox: 'human-reviewed',
      authentication: authed ? 'bearer-required' : 'open',
    },
  };
}
