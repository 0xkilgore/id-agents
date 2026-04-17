import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../lib/auth.js';

// HTTP MCP shim. JSON-RPC 2.0 over a single POST endpoint.
// Exposes exactly two tools: `talk` and `news`. Both relay through the
// already-running /talk and /news HTTP routes via localhost — they do NOT
// import openrouter/inbox/budget modules. That keeps the MCP boundary thin:
// any hardening we add to the REST routes (auth, rate-limit, body-size,
// budget, inbox) automatically applies to MCP callers too.

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function toolsList(env: Env) {
  return {
    tools: [
      {
        name: 'talk',
        description:
          `Send a question to ${env.agentName}. Synchronous — returns the model reply in the same call. ` +
          'Every call is appended to the inbox for human review.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Your question or message. Required.' },
            from: { type: 'string', description: 'Client-declared sender. Optional, not verified.' },
          },
          required: ['message'],
        },
      },
      {
        name: 'news',
        description:
          `Append an item to ${env.agentName}'s news feed. Fire-and-forget; no reply body beyond an id.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: "Optional. Defaults to 'notify'." },
            from: { type: 'string', description: 'Sender identifier. Required.' },
            message: { type: 'string', description: 'News message. Required.' },
            data: { type: 'object', description: 'Optional free-form payload.' },
          },
          required: ['from', 'message'],
        },
      },
    ],
  };
}

async function relay(env: Env, incomingAuth: string | null, path: '/talk' | '/news', body: unknown) {
  // Loopback so we don't leave the container. The egress iptables rules
  // in entrypoint.sh allow lo freely, so this stays inside the sandbox.
  const url = `http://127.0.0.1:${env.port}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (incomingAuth) headers.Authorization = incomingAuth;
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, body: parsed };
}

function toolResult(content: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      },
    ],
    isError,
  };
}

export function mcpRoutes(env: Env): Hono {
  const app = new Hono();

  // When PUBLIC_AGENT_AUTH_KEY is set, the MCP endpoint demands the same
  // bearer token. MCP clients pass it as Authorization: Bearer <key>, which
  // we then forward to the internal /talk and /news calls so they also pass.
  app.post('/mcp', requireAuth(env), async (c) => {
    let req: JsonRpcRequest;
    try {
      req = (await c.req.json()) as JsonRpcRequest;
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return c.json(rpcError(req.id, -32600, 'Invalid Request'), 400);
    }

    const incomingAuth = c.req.header('authorization') ?? null;

    switch (req.method) {
      case 'initialize':
        return c.json(rpcResult(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: env.agentName, version: '0.1.0' },
        }));

      case 'tools/list':
        return c.json(rpcResult(req.id, toolsList(env)));

      case 'tools/call': {
        const params = req.params ?? {};
        const name = params.name as string | undefined;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!name) return c.json(rpcError(req.id, -32602, 'Missing tool name'));

        if (name === 'talk') {
          const message = typeof args.message === 'string' ? args.message : '';
          const from = typeof args.from === 'string' ? args.from : undefined;
          if (!message.trim()) {
            return c.json(rpcResult(req.id, toolResult({ error: 'missing_message' }, true)));
          }
          const relayed = await relay(env, incomingAuth, '/talk', { message, from });
          return c.json(rpcResult(req.id, toolResult(relayed.body, !relayed.ok)));
        }

        if (name === 'news') {
          const from = typeof args.from === 'string' ? args.from : '';
          const message = typeof args.message === 'string' ? args.message : '';
          const type = typeof args.type === 'string' ? args.type : undefined;
          const data = args.data;
          if (!from || !message) {
            return c.json(rpcResult(req.id, toolResult({ error: 'missing_from_or_message' }, true)));
          }
          const relayed = await relay(env, incomingAuth, '/news', { from, message, type, data });
          return c.json(rpcResult(req.id, toolResult(relayed.body, !relayed.ok)));
        }

        return c.json(rpcError(req.id, -32601, `Unknown tool: ${name}`));
      }

      default:
        return c.json(rpcError(req.id, -32601, `Method not found: ${req.method}`));
    }
  });

  return app;
}
