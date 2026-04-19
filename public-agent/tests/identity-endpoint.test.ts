/**
 * GET /identity serves the on-chain identity fields delivered by the manager
 * over SCP. Contract:
 *   { name, ows_address, idchain_domain, token_id, service_endpoint, registered_at }
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { identityRoutes } from '../src/routes/identity.js';
import { makeEnv } from './helpers/makeEnv.js';
import { req } from './helpers/httpClient.js';

describe('GET /identity', () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `identity-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpPath); } catch { /* noop */ }
  });

  it('returns the on-chain identity when the file exists', async () => {
    const identity = {
      name: 'example.idchain',
      ows_address: '0xABCDEF',
      idchain_domain: 'example.idchain',
      token_id: '42',
      service_endpoint: 'https://example.com',
      registered_at: '2026-04-18T00:00:00Z',
    };
    fs.writeFileSync(tmpPath, JSON.stringify(identity));
    const env = makeEnv({ identityPath: tmpPath });
    const app = new Hono().route('/', identityRoutes(env));

    const res = await req(app, 'GET', '/identity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(identity);
  });

  it('returns 404 identity_not_provisioned when the file is missing', async () => {
    const env = makeEnv({ identityPath: tmpPath });
    const app = new Hono().route('/', identityRoutes(env));
    const res = await req(app, 'GET', '/identity');
    expect(res.status).toBe(404);
    expect((res.body as Record<string, unknown>).error).toBe('identity_not_provisioned');
  });

  it('returns 500 identity_corrupt on malformed JSON', async () => {
    fs.writeFileSync(tmpPath, '{not json}');
    const env = makeEnv({ identityPath: tmpPath });
    const app = new Hono().route('/', identityRoutes(env));
    const res = await req(app, 'GET', '/identity');
    expect(res.status).toBe(500);
    expect((res.body as Record<string, unknown>).error).toBe('identity_corrupt');
  });
});
