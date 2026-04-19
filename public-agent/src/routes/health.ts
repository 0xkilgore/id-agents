import { Hono } from 'hono';
import type { Env } from '../env.js';

/**
 * Probes the OpenRouter API base URL. Returns "ok" on 2xx/3xx/4xx (reachable),
 * "error" on network failure or timeout. We intentionally treat 401/403 as
 * reachable: the service responds, which is what /health cares about.
 */
async function probeOpenRouter(signal: AbortSignal): Promise<'ok' | 'error'> {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'HEAD',
      signal,
    });
    if (resp.status >= 200 && resp.status < 500) return 'ok';
    return 'error';
  } catch {
    return 'error';
  }
}

export function healthRoutes(env: Env): Hono {
  const app = new Hono();

  const handler = async (c: import('hono').Context) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let upstream: 'ok' | 'error';
    try {
      upstream = await probeOpenRouter(controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const now = Date.now();
    return c.json({
      status: 'ok',
      version: env.version,
      uptime_s: Math.floor((now - env.bootTimeMs) / 1000),
      last_boot: new Date(env.bootTimeMs).toISOString(),
      upstream: { openrouter: upstream },
    });
  };

  app.get('/health', handler);
  // Backward-compat alias: mirror the same body so legacy callers keep working.
  app.get('/healthz', handler);

  return app;
}
