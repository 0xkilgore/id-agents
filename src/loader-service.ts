/**
 * Loader Service — a minimal, rock-solid process that can restart the manager.
 *
 * Pure Node.js, zero dependencies from the main codebase.
 * Designed to run as a systemd service with Restart=always.
 *
 * Port: 3100 (configurable via LOADER_PORT env var)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

const LOADER_PORT = parseInt(process.env.LOADER_PORT || '3100');
const MANAGER_PORT = parseInt(process.env.AGENT_MANAGER_PORT || '4100');
// Trusted local setup — no auth
const WORK_DIR = process.env.LOADER_WORK_DIR || process.cwd();
const LOG_FILE = process.env.MANAGER_LOG_FILE || '/tmp/manager.log';

function log(msg: string) {
  console.log(`[Loader] ${msg}`);
}

function safeCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(_req: http.IncomingMessage): boolean {
  return true; // Trusted local setup
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function pingManager(): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const resp = await fetch(`http://localhost:${MANAGER_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return { ok: true, data: await resp.json() };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function killManager(): Promise<boolean> {
  const myPid = process.pid;
  let pids: string;
  try {
    pids = execFileSync('lsof', ['-ti', `:${MANAGER_PORT}`], { encoding: 'utf-8' }).trim();
  } catch {
    log('No process on manager port');
    return true; // nothing running
  }
  if (!pids) return true;

  const pidList = pids.split('\n').filter(p => p && parseInt(p) !== myPid);
  if (pidList.length === 0) {
    log('No manager process found (only self)');
    return true;
  }

  for (const pid of pidList) {
    log(`Sending SIGTERM to ${pid}`);
    try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
  }

  // Wait up to 5 seconds for graceful shutdown
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      execFileSync('lsof', ['-ti', `:${MANAGER_PORT}`], { encoding: 'utf-8' });
    } catch {
      return true; // port is free
    }
  }

  // Force kill
  try {
    const remaining = execFileSync('lsof', ['-ti', `:${MANAGER_PORT}`], { encoding: 'utf-8' }).trim();
    for (const pid of remaining.split('\n').filter(p => p && parseInt(p) !== myPid)) {
      log(`Force killing ${pid}`);
      try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
    }
  } catch {}
  return true;
}

function startManager(): { pid: number | undefined } {
  const managerScript = path.join(WORK_DIR, 'dist', 'start-agent-manager.js');
  log(`Starting manager script: ${managerScript}`);
  // Load .env file into environment if it exists
  const env = { ...process.env };
  try {
    const envContent = readFileSync(path.join(WORK_DIR, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
  } catch {
    // No .env file, that's fine
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('node', [managerScript], {
    cwd: WORK_DIR,
    env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  log(`Spawned with pid ${child.pid}`);
  return { pid: child.pid };
}

async function waitForManager(maxAttempts = 30, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const { ok } = await pingManager();
    if (ok) return true;
  }
  return false;
}

function readLogs(lines = 50): string[] {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    return content.split('\n').slice(-lines).filter(Boolean);
  } catch {
    return ['(no log file found)'];
  }
}

// Catch unhandled errors to prevent crashes
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${LOADER_PORT}`);

    // Health — always open
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', service: 'loader', port: LOADER_PORT });
    }

    // Auth check for everything else
    if (!checkAuth(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // Manager status
    if (req.method === 'GET' && url.pathname === '/manager-status') {
      const result = await pingManager();
      return json(res, 200, { running: result.ok, manager: result.data || null });
    }

    // Manager logs
    if (req.method === 'GET' && url.pathname === '/logs') {
      const lines = parseInt(url.searchParams.get('lines') || '50');
      return json(res, 200, { logs: readLogs(lines) });
    }

    // Restart manager
    if (req.method === 'POST' && url.pathname === '/restart-manager') {
      log('Restart requested');
      const wasRunning = (await pingManager()).ok;
      log(`Manager was ${wasRunning ? 'running' : 'down'}`);

      // Kill existing
      await killManager();
      log('Old process killed');

      // Start new
      const { pid } = startManager();
      log(`New manager spawned (pid: ${pid})`);

      // Wait for it to come up
      const started = await waitForManager();
      log(started ? 'Manager is up' : 'Manager failed to start');

      return json(res, started ? 200 : 503, {
        success: started,
        wasRunning,
        pid,
        message: started ? 'Manager restarted successfully' : 'Manager failed to start (check /logs)',
      });
    }

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    log(`Request error: ${err.message}`);
    json(res, 500, { error: err.message });
  }
});

server.listen(LOADER_PORT, '127.0.0.1', () => {
  log(`Listening on port ${LOADER_PORT}`);
  log(`Manager port: ${MANAGER_PORT}`);
  log(`Work dir: ${WORK_DIR}`);
});
