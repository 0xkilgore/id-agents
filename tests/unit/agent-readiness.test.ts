// SPDX-License-Identifier: MIT
/**
 * Tests for the post-spawn readiness probe used by /deploy and /sync.
 *
 * The probe closes a window where the daemon has marked the agent
 * 'running' but the agent's HTTP server is not yet accepting requests.
 * Without it, an immediate /ask after deploy hangs waiting for a reply
 * that the agent never received.
 */

import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { waitForAgentReady } from '../../src/cli/agent-readiness.js';

async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

describe('waitForAgentReady', () => {
  it('returns true once the agent is listening', async () => {
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;

    // Start the server 200ms after the probe begins to simulate a slow boot.
    const probe = waitForAgentReady(url, { timeoutMs: 3000, intervalMs: 100, perRequestTimeoutMs: 250 });

    let server: http.Server | null = null;
    setTimeout(() => {
      server = http.createServer((req, res) => {
        if (req.url === '/.well-known/restap.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ restap_version: '1.0' }));
        } else {
          res.writeHead(404).end();
        }
      });
      server.listen(port, '127.0.0.1');
    }, 200);

    try {
      const ready = await probe;
      expect(ready).toBe(true);
    } finally {
      await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    }
  });

  it('returns false when the agent never comes up before the deadline', async () => {
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;
    const start = Date.now();
    const ready = await waitForAgentReady(url, { timeoutMs: 600, intervalMs: 100, perRequestTimeoutMs: 150 });
    expect(ready).toBe(false);
    // Should not blow well past the requested deadline.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('returns false when the agent responds with a non-2xx status', async () => {
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;
    const server = http.createServer((_req, res) => {
      res.writeHead(503).end();
    });
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
    try {
      const ready = await waitForAgentReady(url, { timeoutMs: 600, intervalMs: 100, perRequestTimeoutMs: 150 });
      expect(ready).toBe(false);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
