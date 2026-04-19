import { Hono } from 'hono';
import fs from 'node:fs';
import type { Env } from '../env.js';

/**
 * GET /identity returns the on-chain identity fields delivered to the VPS by
 * the manager (see docs/public-team-design.md §8). The file is watched by the
 * service and re-read on each request, so the manager's SCP delivery is picked
 * up without a restart.
 *
 * Shape per design:
 *   { name, ows_address, idchain_domain, token_id, service_endpoint, registered_at }
 */
export function identityRoutes(env: Env): Hono {
  const app = new Hono();

  app.get('/identity', (c) => {
    let raw: string;
    try {
      raw = fs.readFileSync(env.identityPath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return c.json(
          {
            error: 'identity_not_provisioned',
            message: 'On-chain identity has not been delivered to this host yet.',
          },
          404,
        );
      }
      return c.json({ error: 'identity_unreadable' }, 500);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'identity_corrupt' }, 500);
    }
    const i = parsed as Record<string, unknown>;
    return c.json({
      name: typeof i.name === 'string' ? i.name : null,
      ows_address: typeof i.ows_address === 'string' ? i.ows_address : null,
      idchain_domain: typeof i.idchain_domain === 'string' ? i.idchain_domain : null,
      token_id: typeof i.token_id === 'string' ? i.token_id : null,
      service_endpoint: typeof i.service_endpoint === 'string' ? i.service_endpoint : null,
      registered_at: typeof i.registered_at === 'string' ? i.registered_at : null,
    });
  });

  return app;
}
