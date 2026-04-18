import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadEnv } from './env.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { talkRoutes } from './routes/talk.js';
import { newsRoutes } from './routes/news.js';
import { inboxRoutes } from './routes/inbox.js';
import { mcpRoutes } from './routes/mcp.js';
import { loadManifest } from './lib/knowledge.js';
import { purgeOldArtifacts } from './lib/tool-truncate.js';

const env = loadEnv();

// Hard-fail at startup if the knowledge dir has any rejectable file. We'd
// rather crash on boot than serve partially-indexed or attacker-controlled
// knowledge to callers.
let knowledge;
try {
  knowledge = loadManifest(env.knowledgeDir);
  console.log(`[public-agent] knowledge manifest: ${knowledge.entries.size} file(s) from ${knowledge.root}`);
} catch (err) {
  console.error(`[public-agent] knowledge load failed: ${(err as Error).message}`);
  process.exit(1);
}

try {
  const swept = purgeOldArtifacts(env.dataDir);
  if (swept.removed > 0 || swept.kept > 0) {
    console.log(`[public-agent] tool-artifacts purge: removed=${swept.removed} kept=${swept.kept}`);
  }
} catch (err) {
  console.error('[public-agent] tool-artifacts purge failed:', err);
}

const app = new Hono();

const TALK_BODY_LIMIT = 64 * 1024;
const NEWS_BODY_LIMIT = 16 * 1024;
const MCP_BODY_LIMIT = 64 * 1024;

const oversize = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: 'payload_too_large', limit: maxSize }, 413),
  });

app.get('/healthz', (c) => c.json({ ok: true, agent: env.agentName }));

// Body-size caps have to attach to the exact method+path so other routes
// aren't forced to read the body. Hono's bodyLimit reads Content-Length up
// front and short-circuits the request before the handler runs.
app.on('POST', '/talk', oversize(TALK_BODY_LIMIT));
app.on('POST', '/news', oversize(NEWS_BODY_LIMIT));
app.on('POST', '/mcp', oversize(MCP_BODY_LIMIT));

app.route('/', wellknownRoutes(env));
app.route('/', talkRoutes(env, knowledge));
app.route('/', newsRoutes(env));
app.route('/', inboxRoutes(env));
app.route('/', mcpRoutes(env));

app.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[public-agent] ${env.agentName} listening on :${info.port} (model=${env.openRouterModel}, auth=${env.authKey ? 'keyed' : 'open'})`);
});
