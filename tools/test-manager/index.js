#!/usr/bin/env node
/**
 * Test Manager - Standalone REST-AP manager for testing
 *
 * A lightweight manager that runs independently from the CLI for testing
 * agent communication. Uses in-memory storage (no database required).
 *
 * Usage:
 *   node tools/test-manager/index.js [--port 5000]
 *
 * Features:
 *   - Register external agents by URL
 *   - List registered agents
 *   - Send messages to agents (sync via /talk-to)
 *   - Receive replies
 *   - No database required
 */

import express from 'express';
import fetch from 'node-fetch';

const PORT = parseInt(process.env.TEST_MANAGER_PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '5000');

// In-memory agent registry
const agents = new Map();
let agentCounter = 1;

// News items for this manager
const newsItems = [];
let newsCounter = 1;

// Pending queries waiting for replies
const pendingQueries = new Map();

const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', type: 'test-manager', agents: agents.size });
});

// Discovery document
app.get('/.well-known/restap.json', (req, res) => {
  res.json({
    restap_version: '1.0',
    agent: {
      name: 'test-manager',
      description: 'Standalone test manager for REST-AP testing'
    },
    endpoints: {
      talk: '/talk',
      news: '/news'
    }
  });
});

// List agents
app.get('/agents', (req, res) => {
  const agentList = Array.from(agents.values()).map(a => ({
    id: a.id,
    name: a.name,
    alias: a.alias || a.name,
    tokenId: a.tokenId,
    url: a.url,
    internal_url: a.url,
    status: a.status || 'registered',
    type: 'virtual'
  }));
  res.json({ agents: agentList });
});

// Register an external agent
app.post('/agents/register', (req, res) => {
  const { name, url, tokenId } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Missing name or url' });
  }

  const id = `test_agent_${agentCounter++}`;
  const agent = {
    id,
    name: tokenId ? `${name}.${tokenId}` : name,
    alias: name,
    tokenId: tokenId || null,
    url,
    status: 'registered',
    registeredAt: Date.now()
  };

  agents.set(id, agent);
  console.log(`[TestManager] Registered agent: ${agent.name} at ${url}`);

  res.json({ ok: true, agent });
});

// Get agent by name
app.get('/agents/by-name/:name', (req, res) => {
  const name = req.params.name.toLowerCase();
  const agent = Array.from(agents.values()).find(a =>
    a.name.toLowerCase() === name || a.alias?.toLowerCase() === name
  );
  if (!agent) {
    return res.status(404).json({ error: `Agent not found: ${req.params.name}` });
  }
  res.json(agent);
});

// Resolve agent reference
app.get('/agents/resolve/:ref', (req, res) => {
  const ref = req.params.ref.toLowerCase();
  const matches = Array.from(agents.values()).filter(a =>
    a.name.toLowerCase() === ref ||
    a.alias?.toLowerCase() === ref ||
    a.id.toLowerCase() === ref ||
    a.tokenId === ref
  );

  if (matches.length === 0) {
    return res.status(404).json({ error: `Agent not found: ${req.params.ref}` });
  }

  if (matches.length > 1) {
    return res.json({
      ambiguous: true,
      warning: `Multiple agents match "${req.params.ref}"`,
      agents: matches
    });
  }

  res.json({ agent: matches[0] });
});

// Delete agent
app.delete('/agents/:id', (req, res) => {
  const agent = agents.get(req.params.id) ||
    Array.from(agents.values()).find(a => a.name === req.params.id || a.alias === req.params.id);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  agents.delete(agent.id);
  console.log(`[TestManager] Deleted agent: ${agent.name}`);
  res.json({ ok: true });
});

// Receive message (POST /talk)
app.post('/talk', (req, res) => {
  const { message, from, reply_endpoint } = req.body;

  const newsItem = {
    id: newsCounter++,
    type: 'message',
    from: from || 'unknown',
    message,
    reply_endpoint,
    timestamp: new Date().toISOString()
  };

  newsItems.push(newsItem);
  console.log(`[TestManager] Received message from ${from}: ${message.substring(0, 50)}...`);

  res.json({
    ok: true,
    query_id: `query_${newsItem.id}`,
    message: 'Message received by test-manager'
  });
});

// Get news feed
app.get('/news', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const items = newsItems.filter(item => item.id > since);
  res.json({ items });
});

// Receive news/reply (POST /news)
app.post('/news', (req, res) => {
  const { type, from, message, in_reply_to } = req.body;

  const newsItem = {
    id: newsCounter++,
    type: type || 'message',
    from,
    message,
    in_reply_to,
    timestamp: new Date().toISOString()
  };

  newsItems.push(newsItem);
  console.log(`[TestManager] Received ${type || 'news'} from ${from}`);

  // Check for pending query waiting for this reply
  if (in_reply_to && pendingQueries.has(in_reply_to)) {
    const resolver = pendingQueries.get(in_reply_to);
    pendingQueries.delete(in_reply_to);
    resolver({ from, message, type });
  }

  res.json({ ok: true });
});

// Talk to agent (synchronous - send and wait for reply)
app.post('/talk-to', async (req, res) => {
  const { to, message, timeout = 120000 } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing to or message' });
  }

  // Find target agent
  const toName = to.toLowerCase();
  const targetAgent = Array.from(agents.values()).find(a =>
    a.name.toLowerCase() === toName ||
    a.alias?.toLowerCase() === toName ||
    a.id.toLowerCase() === toName
  );

  if (!targetAgent) {
    return res.status(404).json({ error: `Agent not found: ${to}` });
  }

  console.log(`[TestManager] Sending to ${targetAgent.name} at ${targetAgent.url}`);

  const queryId = `query_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Create promise that will be resolved when reply arrives
  const replyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(queryId);
      reject(new Error('Timeout waiting for reply'));
    }, timeout);

    pendingQueries.set(queryId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });

  try {
    // First, discover the agent's endpoints
    let talkEndpoint = '/talk';
    try {
      const discoverRes = await fetch(`${targetAgent.url}/.well-known/restap.json`, { timeout: 5000 });
      if (discoverRes.ok) {
        const catalog = await discoverRes.json();
        talkEndpoint = catalog.endpoints?.talk || '/talk';
      }
    } catch (e) {
      // Use default
    }

    // Send message to target agent
    const talkRes = await fetch(`${targetAgent.url}${talkEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        from: 'test-manager',
        query_id: queryId,
        reply_endpoint: `http://localhost:${PORT}/news`
      })
    });

    if (!talkRes.ok) {
      const error = await talkRes.text();
      pendingQueries.delete(queryId);
      return res.status(502).json({ error: `Failed to send: ${error}` });
    }

    // Wait for reply
    const reply = await replyPromise;

    res.json({
      success: true,
      from: reply.from,
      reply: reply.message,
      query_id: queryId
    });

  } catch (err) {
    pendingQueries.delete(queryId);
    res.status(500).json({ error: err.message });
  }
});

// Ping an agent (check if reachable)
app.get('/agents/:id/ping', async (req, res) => {
  const agent = agents.get(req.params.id) ||
    Array.from(agents.values()).find(a =>
      a.name.toLowerCase() === req.params.id.toLowerCase() ||
      a.alias?.toLowerCase() === req.params.id.toLowerCase()
    );

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const pingRes = await fetch(`${agent.url}/health`, { timeout: 5000 });
    const data = await pingRes.json();
    res.json({ ok: pingRes.ok, status: pingRes.status, data });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Clear all agents
app.post('/reset', (req, res) => {
  agents.clear();
  newsItems.length = 0;
  newsCounter = 1;
  agentCounter = 1;
  console.log('[TestManager] Reset - cleared all agents and news');
  res.json({ ok: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                     TEST MANAGER                              ║
╠═══════════════════════════════════════════════════════════════╣
║  Standalone REST-AP manager for testing                       ║
║                                                               ║
║  Listening on: http://localhost:${PORT.toString().padEnd(27)}║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health             - Health check                    ║
║    GET  /agents             - List registered agents          ║
║    POST /agents/register    - Register external agent         ║
║    GET  /agents/resolve/:r  - Resolve agent reference         ║
║    POST /talk-to            - Send message (sync)             ║
║    POST /talk               - Receive message                 ║
║    GET  /news               - Get news feed                   ║
║    POST /news               - Receive reply                   ║
║    POST /reset              - Clear all agents                ║
╚═══════════════════════════════════════════════════════════════╝
`);
});
