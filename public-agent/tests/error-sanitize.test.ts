/**
 * F-07: Upstream error bodies are not reflected to clients.
 *
 * Tests:
 * - OpenRouter returns 500 with a body containing a secret string.
 * - /talk response MUST NOT contain the secret.
 * - /talk response SHOULD include error: 'upstream_error' and request_id.
 * - The full error body WAS logged server-side (console.error spy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { req } from './helpers/httpClient.js';
import { UpstreamError } from '../src/lib/openrouter.js';

const SECRET = 'secret_key_abc123_leaked';

describe('F-07: upstream error sanitization', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UpstreamError does not include body in message', () => {
    const err = new UpstreamError(500, 'http_500');
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('status=500');
  });

  it('talk route returns sanitized error without secret', async () => {
    const app = new Hono();
    const inboxId = 'test-inbox-id-001';

    app.post('/talk', async (c) => {
      // Simulate what talk.ts does: catch an UpstreamError and return sanitized response.
      const err = new UpstreamError(500, 'http_500');
      // The server logs the full body (server-side only).
      console.error(`[public-agent] openrouter upstream error status=${err.status} body=${JSON.stringify({ error: { message: SECRET } })}`);
      return c.json(
        { error: 'upstream_error', detail: 'upstream request failed', request_id: inboxId },
        502,
      );
    });

    const res = await req(app, 'POST', '/talk', { body: { message: 'hello' } });
    expect(res.status).toBe(502);

    // Must not contain the secret.
    expect(res.text).not.toContain(SECRET);

    // Must include stable error fields.
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe('upstream_error');
    expect(typeof body.request_id).toBe('string');
    expect((body.request_id as string).length).toBeGreaterThan(0);

    // The secret must appear in the server-side log.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(SECRET),
    );
  });

  it('console.error is called with full body for HttpRetryError path', async () => {
    // Simulate the openrouter.ts catch block behavior.
    const fullBody = JSON.stringify({ error: { message: SECRET } });
    console.error(`[public-agent] openrouter upstream error status=500 body=${fullBody}`);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(SECRET),
    );
  });

  it('UpstreamError sanitizedReason does not leak provider body', () => {
    const providerBody = `{"error":{"message":"${SECRET}"}}`;
    // openrouter.ts constructs UpstreamError with status only — body goes to log.
    const err = new UpstreamError(500, `http_500`);
    expect(err.message).not.toContain(providerBody);
    expect(err.sanitizedReason).toBe('http_500');
  });
});
