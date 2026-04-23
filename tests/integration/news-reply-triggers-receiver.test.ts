// SPDX-License-Identifier: MIT
/**
 * Replies posted to /news with `in_reply_to` and no explicit `trigger`
 * field must default to triggering the receiver — so an agent that
 * already gave up on its /talk-to wait still wakes when the answer
 * eventually arrives.
 *
 * We don't drive the harness here; we only assert the /news handler's
 * dispatch decision, surfaced in its response payload (`triggered: true`
 * + a generated `query_id`). Loop safety is provided by the existing
 * `noAutoReply: true` flag the handler passes through to startQuery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import { AgentRestServer } from '../../src/claude-agent-server.js';

async function freshServer(): Promise<{ server: AgentRestServer; baseUrl: string }> {
  const server = new AgentRestServer({
    agentName: 'news-default-trigger-test',
    workingDirectory: process.cwd(),
    sharedDirectory: process.cwd(),
  });
  await server.start(0);
  const httpServer = (server as any).httpServer as { address: () => AddressInfo };
  const port = httpServer.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('POST /news — trigger default for replies', () => {
  let server: AgentRestServer | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    const created = await freshServer();
    server = created.server;
    baseUrl = created.baseUrl;
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  it('triggers when in_reply_to is present and trigger is omitted', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        in_reply_to: 'qid-from-a',
        message: 'long-running answer arrives after caller hung up',
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { triggered?: boolean; query_id?: string };
    expect(body.triggered).toBe(true);
    expect(body.query_id).toMatch(/^news_/);
  });

  it('does not trigger when caller explicitly opts out with trigger:false', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        in_reply_to: 'qid-from-a',
        message: 'silent reply',
        trigger: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { triggered?: boolean };
    expect(body.triggered).toBe(false);
  });

  it('does not trigger plain inbound messages with no in_reply_to', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        message: 'just an FYI, no reply expected',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { triggered?: boolean };
    expect(body.triggered).toBe(false);
  });
});
