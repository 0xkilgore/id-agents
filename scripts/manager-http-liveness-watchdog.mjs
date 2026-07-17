#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// External HTTP-liveness watchdog for the id-agents manager. This job runs
// outside the manager process under launchd and treats port/PID liveness as
// diagnostics only. Recovery is driven by bounded HTTP probe failures.
//
// Kill switch: touch /tmp/manager-http-liveness-watchdog.pause
// Dry run: --dry-run or MANAGER_HTTP_LIVENESS_WATCHDOG_DRY_RUN=1

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireWatchdogLock, DEFAULT_LOCK_STALE_MS } from './lib/deploy-watchdog-lock.mjs';
import { decideManagerLivenessWatchdog, ESCALATION_WINDOW_MS } from './lib/manager-liveness-watchdog-decision.mjs';

const HOME = process.env.HOME || '/Users/kilgore';
const MANAGER_URL = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_URL || 'http://127.0.0.1:4100';
const SERVICE = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_SERVICE || 'com.kilgore.id-agents-manager';
const PORT = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_PORT || '4100';
const DEPLOY_REPO = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_DEPLOY_REPO || `${HOME}/Dropbox/Code/cane/id-agents-deploy-main`;
const LOG = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_LOG || '/tmp/manager-http-liveness-watchdog.log';
const STATE_FILE = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_STATE_FILE || '/tmp/manager-http-liveness-watchdog.state';
const PAUSE_FILE = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_PAUSE_FILE || '/tmp/manager-http-liveness-watchdog.pause';
const LOCK_FILE = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_LOCK_FILE || '/tmp/manager-http-liveness-watchdog.lock';
const LOCK_STALE_MS = Number(process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_LOCK_STALE_MS || DEFAULT_LOCK_STALE_MS);
const ARTIFACT_DIR = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_ARTIFACT_DIR || `${HOME}/Dropbox/Code/agent-platform/output`;
const RAW_DIR = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_RAW_DIR || '/tmp/manager-http-liveness-watchdog-diagnostics';
const DRY_RUN = process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_DRY_RUN === '1' || process.argv.includes('--dry-run');
const HEALTH_TIMEOUT_MS = Number(process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_HEALTH_TIMEOUT_MS || 2000);
const DISPATCH_HEALTH_TIMEOUT_MS = Number(process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_DISPATCH_HEALTH_TIMEOUT_MS || 3000);
const RECOVERY_POLL_MS = Number(process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_RECOVERY_POLL_MS || 2000);
const RECOVERY_TIMEOUT_MS = Number(process.env.MANAGER_HTTP_LIVENESS_WATCHDOG_RECOVERY_TIMEOUT_MS || 60000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(msg) {
  const line = `${new Date().toISOString()}  [manager-http-liveness-watchdog${DRY_RUN ? ':dry-run' : ''}] ${msg}`;
  try { appendFileSync(LOG, `${line}\n`); } catch { /* best-effort */ }
  console.log(line);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (err) { log(`WARN could not persist state: ${messageOf(err)}`); }
}

function acquireLock() {
  const result = acquireWatchdogLock({ lockFile: LOCK_FILE, staleMs: LOCK_STALE_MS, log });
  if (!result.acquired) process.exitCode = 0;
  return result.fd;
}

function releaseLock(fd) {
  if (fd === null || fd === undefined) return;
  try { closeSync(fd); } catch { /* best-effort */ }
  try { unlinkSync(LOCK_FILE); } catch { /* best-effort */ }
}

async function probeJson(path, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(`${MANAGER_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, timedOut: false, latencyMs, status: res.status, body: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, timedOut: false, latencyMs, status: res.status, body, error: null };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || latencyMs >= timeoutMs;
    return { ok: false, timedOut, latencyMs: timedOut ? null : latencyMs, status: null, body: null, error: messageOf(err) };
  }
}

function listenerPid() {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const first = out.split(/\s+/).find(Boolean);
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

function launchdStatus() {
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${SERVICE}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pidMatch = out.match(/\bpid\s*=\s*(\d+)/);
    return { ok: true, pid: pidMatch ? Number(pidMatch[1]) : null, output: out };
  } catch (err) {
    return { ok: false, pid: null, output: messageOf(err) };
  }
}

function commandOutput(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 8000,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `ERROR ${cmd} ${args.join(' ')}: ${messageOf(err)}\n${err?.stdout?.toString?.() ?? ''}${err?.stderr?.toString?.() ?? ''}`;
  }
}

function captureCommand(path, cmd, args, opts = {}) {
  const body = commandOutput(cmd, args, opts);
  writeFileSync(path, body);
  return path;
}

function captureTail(src, dest, lines = 300) {
  if (!existsSync(src)) {
    writeFileSync(dest, `missing: ${src}\n`);
    return dest;
  }
  return captureCommand(dest, 'tail', ['-n', String(lines), src], { timeout: 3000 });
}

function captureDiagnostics({ decision, state, launchd, oldPid }) {
  const stamp = timestampSlug();
  const dir = join(RAW_DIR, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), decision, prior_state: state }, null, 2));
  writeFileSync(join(dir, 'launchctl.txt'), launchd.output || '');
  if (oldPid) {
    captureCommand(join(dir, 'ps.txt'), 'ps', ['-o', 'pid,ppid,stat,rss,vsz,etime,command', '-p', String(oldPid)], { timeout: 3000 });
    captureCommand(join(dir, 'lsof.txt'), 'sh', ['-c', `lsof -nP -p ${quoteSh(String(oldPid))} | head -200`], { timeout: 5000 });
    runDiagnosticProcess('sample', [String(oldPid), '5', '-file', join(dir, 'sample.txt')], 8000, join(dir, 'sample.error.txt'));
    runDiagnosticProcess('spindump', [String(oldPid), '-onlyTarget', String(oldPid), '-duration', '5', '-file', join(dir, 'spindump.txt')], 10000, join(dir, 'spindump.error.txt'));
  }
  captureTail('/tmp/id-agents-manager.log', join(dir, 'id-agents-manager.log.tail.txt'));
  captureTail('/tmp/id-agents-manager.err', join(dir, 'id-agents-manager.err.tail.txt'));
  captureTail('/tmp/deploy-watchdog.log', join(dir, 'deploy-watchdog.log.tail.txt'));
  captureTail(LOG, join(dir, 'manager-http-liveness-watchdog.log.tail.txt'));
  captureCommand(join(dir, 'df.txt'), 'df', ['-h', '/', `${HOME}/Dropbox`], { timeout: 5000 });
  captureCommand(join(dir, 'deploy-repo-shas.txt'), 'sh', ['-c', 'git rev-parse HEAD origin/main'], { cwd: DEPLOY_REPO, timeout: 8000 });
  return dir;
}

function runDiagnosticProcess(cmd, args, timeout, errorPath) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0 || result.stderr) {
    writeFileSync(errorPath, [
      `status=${result.status}`,
      `signal=${result.signal}`,
      `error=${result.error ? messageOf(result.error) : ''}`,
      result.stdout || '',
      result.stderr || '',
    ].join('\n'));
  }
}

function kickstartManager() {
  if (DRY_RUN) {
    log(`[DRY-RUN] would run launchctl kickstart -k gui/${process.getuid()}/${SERVICE}`);
    return;
  }
  execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${SERVICE}`], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForRecovery() {
  const started = Date.now();
  let health = null;
  let dispatchHealth = null;
  let agents = null;
  while (Date.now() - started <= RECOVERY_TIMEOUT_MS) {
    health = await probeJson('/health', HEALTH_TIMEOUT_MS);
    if (health.ok) {
      dispatchHealth = await probeJson('/dispatches/health', DISPATCH_HEALTH_TIMEOUT_MS);
      agents = await probeJson('/agents?limit=1', DISPATCH_HEALTH_TIMEOUT_MS);
      if (dispatchHealth.ok && (agents.ok || agents.status === 401 || agents.status === 403)) {
        return {
          ok: true,
          recoverySeconds: Math.round((Date.now() - started) / 1000),
          health,
          dispatchHealth,
          agents,
        };
      }
    }
    await sleep(RECOVERY_POLL_MS);
  }
  return {
    ok: false,
    recoverySeconds: Math.round((Date.now() - started) / 1000),
    health,
    dispatchHealth,
    agents,
  };
}

function writeIncidentArtifact({ kind, decision, state, diagnosticsDir, oldPid, newPid, recovery, health }) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const build = health?.body?.build ?? {};
  const path = join(ARTIFACT_DIR, `manager-http-liveness-watchdog-${timestampSlug()}.md`);
  const body = [
    `# Manager HTTP liveness watchdog - ${kind}`,
    '',
    `Time: ${new Date().toISOString()}`,
    `Decision: ${decision.action} / ${decision.class}`,
    `Reason: ${decision.reason}`,
    `Dry run: ${DRY_RUN ? 'yes' : 'no'}`,
    '',
    '## Restart Outcome',
    '',
    `- old_pid: ${oldPid ?? 'unknown'}`,
    `- new_pid: ${newPid ?? 'unknown'}`,
    `- recovered: ${recovery?.ok ?? false}`,
    `- recovery_seconds: ${recovery?.recoverySeconds ?? 'n/a'}`,
    `- build_sha: ${build.build_sha ?? 'unknown'}`,
    `- origin_main_sha: ${build.origin_main_sha ?? 'unknown'}`,
    `- behind_origin: ${build.behind_origin ?? 'unknown'}`,
    '',
    '## Diagnostics',
    '',
    `- raw_dir: ${diagnosticsDir ?? 'n/a'}`,
    `- log: ${LOG}`,
    `- state_file: ${STATE_FILE}`,
    '',
    '## Prior State',
    '',
    '```json',
    JSON.stringify(state ?? {}, null, 2),
    '```',
  ].join('\n');
  writeFileSync(path, body);
  log(`artifact written: ${path}`);
  return path;
}

function pruneAttempts(attempts, nowMs) {
  return (Array.isArray(attempts) ? attempts : []).filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= ESCALATION_WINDOW_MS;
  });
}

async function main() {
  try { mkdirSync(dirname(LOG), { recursive: true }); } catch { /* ignore */ }
  const lockFd = acquireLock();
  if (lockFd === null) return;

  try {
    const state = readState();
    const nowMs = Date.now();
    const health = await probeJson('/health', HEALTH_TIMEOUT_MS);
    const shouldProbeDispatch = health.ok || health.latencyMs !== null;
    const dispatchHealth = shouldProbeDispatch
      ? await probeJson('/dispatches/health', DISPATCH_HEALTH_TIMEOUT_MS)
      : { ok: false, timedOut: false, latencyMs: null, status: null, body: null, error: 'skipped because /health timed out' };
    const launchd = launchdStatus();
    const pid = listenerPid();
    const decision = decideManagerLivenessWatchdog({
      healthOk: health.ok,
      healthTimedOut: health.timedOut,
      healthLatencyMs: health.latencyMs,
      dispatchHealthOk: dispatchHealth.ok,
      dispatchHealthTimedOut: dispatchHealth.timedOut,
      dispatchHealthLatencyMs: dispatchHealth.latencyMs,
      listenerPid: pid,
      launchdPid: launchd.pid,
      priorConsecutiveFailures: Number(state.consecutiveFailures || 0),
      priorRestartAt: state.lastRestartAt ?? null,
      priorRestartAttempts: pruneAttempts(state.restartAttempts, nowMs),
      pauseFileExists: existsSync(PAUSE_FILE),
      nowMs,
    });

    log(`class=${decision.class} action=${decision.action} health_latency_ms=${health.latencyMs ?? 'null'} dispatch_health_latency_ms=${dispatchHealth.latencyMs ?? 'null'} listener_pid=${pid ?? 'null'} launchd_pid=${launchd.pid ?? 'null'} reason=${decision.reason}`);

    const nextState = {
      ...state,
      consecutiveFailures: decision.nextConsecutiveFailures,
      lastAction: decision.action,
      lastClass: decision.class,
      lastReason: decision.reason,
      lastAt: new Date(nowMs).toISOString(),
      restartAttempts: pruneAttempts(state.restartAttempts, nowMs),
      lastUnhealthyAt: state.lastUnhealthyAt ?? null,
      lastUnhealthyClass: state.lastUnhealthyClass ?? null,
      lastUnhealthyReason: state.lastUnhealthyReason ?? null,
    };

    if (decision.class !== 'healthy') {
      nextState.lastUnhealthyAt = nextState.lastAt;
      nextState.lastUnhealthyClass = decision.class;
      nextState.lastUnhealthyReason = decision.reason;
    }

    if (decision.action === 'diagnose_restart') {
      const diagnosticsDir = captureDiagnostics({ decision, state, launchd, oldPid: pid });
      const restartAt = new Date().toISOString();
      nextState.lastRestartAt = restartAt;
      nextState.restartAttempts = pruneAttempts([...(nextState.restartAttempts || []), restartAt], Date.parse(restartAt));
      writeState(nextState);
      kickstartManager();
      const recovery = DRY_RUN
        ? { ok: true, recoverySeconds: 0, health, dispatchHealth, agents: null }
        : await waitForRecovery();
      const newPid = listenerPid();
      writeIncidentArtifact({
        kind: recovery.ok ? 'restart' : 'restart-failed',
        decision,
        state,
        diagnosticsDir,
        oldPid: pid,
        newPid,
        recovery,
        health: recovery.health ?? health,
      });
      process.exitCode = recovery.ok ? 0 : 1;
      return;
    }

    if (decision.action === 'escalate') {
      const diagnosticsDir = captureDiagnostics({ decision, state, launchd, oldPid: pid });
      writeIncidentArtifact({
        kind: 'escalation',
        decision,
        state,
        diagnosticsDir,
        oldPid: pid,
        newPid: pid,
        recovery: { ok: false, recoverySeconds: null },
        health,
      });
      writeState(nextState);
      process.exitCode = 1;
      return;
    }

    if (decision.class === 'healthy') {
      nextState.lastRestartAt = null;
    }
    writeState(nextState);
    process.exitCode = 0;
  } finally {
    releaseLock(lockFd);
  }
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function quoteSh(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

main().catch((err) => {
  log(`FATAL ${messageOf(err)}`);
  process.exitCode = 1;
});
