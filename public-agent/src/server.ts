import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadEnv } from './env.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { talkRoutes } from './routes/talk.js';
import { newsRoutes } from './routes/news.js';
import { inboxRoutes } from './routes/inbox.js';

const env = loadEnv();
const app = new Hono();

const TALK_BODY_LIMIT = 64 * 1024;
const NEWS_BODY_LIMIT = 16 * 1024;

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

app.route('/', wellknownRoutes(env));
app.route('/', talkRoutes(env));
app.route('/', newsRoutes(env));
app.route('/', inboxRoutes(env));

app.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[public-agent] ${env.agentName} listening on :${info.port} (model=${env.openRouterModel}, auth=${env.authKey ? 'keyed' : 'open'})`);
});
