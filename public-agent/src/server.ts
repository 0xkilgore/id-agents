import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadEnv } from './env.js';
import { wellknownRoutes } from './routes/wellknown.js';

const env = loadEnv();
const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, agent: env.agentName }));

app.route('/', wellknownRoutes(env));

// Endpoints /talk, /news, /inbox land in a later commit.
app.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[public-agent] ${env.agentName} listening on :${info.port} (model=${env.openRouterModel}, auth=${env.authKey ? 'keyed' : 'open'})`);
});
