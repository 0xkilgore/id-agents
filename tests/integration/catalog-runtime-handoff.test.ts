// SPDX-License-Identifier: MIT
/**
 * Catalog runtime handoff integration test.
 *
 * Proves that the spawned local-agent-server picks up `ID_AGENT_CATALOG`
 * (base64-encoded JSON) and serves it via `GET /catalog` immediately after
 * binding — no manual PATCH from the manager required.
 *
 * This covers the runtime-bootstrap gap at `src/local-agent-server.ts:237`.
 *
 * The test:
 *   - forks the built `dist/local-agent-server.js` child with an ephemeral
 *     port, a temp SQLite path, and a base64 ID_AGENT_CATALOG seed;
 *   - waits for the child's HTTP listener to come up;
 *   - asserts `GET http://127.0.0.1:<port>/catalog` returns the seeded fields
 *     (role, expertise, costTier, status) before any PATCH is issued;
 *   - tears the child down and cleans up its temp files.
 *
 * No live daemon is touched. Manager registration is intentionally pointed
 * at an unreachable URL so the child runs in standalone mode.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function pollUntil<T>(fn: () => Promise<T | null>, deadlineMs: number, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const out = await fn();
      if (out) return out;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

describe('catalog runtime handoff', () => {
  const children: ChildProcess[] = [];
  const tempPaths: string[] = [];

  afterAll(async () => {
    for (const c of children) {
      if (!c.killed) {
        try { c.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    await new Promise(r => setTimeout(r, 300));
    for (const c of children) {
      if (!c.killed) {
        try { c.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    for (const p of tempPaths) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('spawned local agent serves the seeded catalog from ID_AGENT_CATALOG without a manual PATCH', async () => {
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'local-agent-server.js');
    if (!fs.existsSync(distPath)) {
      throw new Error(`dist/local-agent-server.js not found at ${distPath}. Run 'npm run build' before this test.`);
    }

    const agentPort = await findFreePort();
    const sqlitePath = path.join(os.tmpdir(), `id-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-handoff-'));
    tempPaths.push(sqlitePath, workDir);

    const seed = {
      role: 'junior-developer',
      description: 'Seeded via env var',
      expertise: ['typescript', 'simple-refactors'],
      costTier: 'low',
      notSuitableFor: ['security-key-handling'],
      status: 'available',
      model: 'gpt-5-codex',
    };
    const catalogEnv = Buffer.from(JSON.stringify(seed), 'utf8').toString('base64');

    const child = spawn(
      process.execPath,
      [distPath, 'jrdev-handoff', '--team', 'catalog-runtime-handoff', '--port', String(agentPort), '--dir', workDir],
      {
        env: {
          ...process.env,
          ID_HARNESS: 'claude-code-cli',
          ID_AGENT_CATALOG: catalogEnv,
          SQLITE_PATH: sqlitePath,
          // Point at an unreachable manager so we don't accidentally talk to a
          // live daemon on :4100. The child warns and continues in standalone.
          MANAGER_URL: 'http://127.0.0.1:1',
          // Don't inherit DATABASE_URL — keep this test on temp SQLite.
          DATABASE_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    children.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const url = `http://127.0.0.1:${agentPort}/catalog`;
    const body = await pollUntil<any>(async () => {
      const r = await fetch(url);
      if (!r.ok) return null;
      return r.json();
    }, 15000);

    expect(
      body,
      `agent /catalog never came up.\nstdout=${stdout}\nstderr=${stderr}`
    ).not.toBeNull();

    expect(body.role).toBe('junior-developer');
    expect(body.expertise).toEqual(['typescript', 'simple-refactors']);
    expect(body.costTier).toBe('low');
    expect(body.notSuitableFor).toEqual(['security-key-handling']);
    expect(body.status).toBe('available');
    expect(body.description).toBe('Seeded via env var');
    expect(body.model).toBeUndefined();
    expect(body.desiredModel).toBe('gpt-5-codex');

    child.kill('SIGTERM');
  }, 30000);
});
