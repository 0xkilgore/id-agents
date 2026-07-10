#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// T-DEPLOY.5 — deploy-freshness watchdog. A launchd job OUTSIDE the fleet (fleet
// agents structurally cannot restart their own manager — Gotcha 0). Every 15 min:
//   1. GET /health and inspect launchd/deploy-checkout hygiene.
//   2. If stale evidence persists (2 consecutive checks, >15 min), or the
//      deploy checkout / manager plist is structurally wrong, redeploy the
//      manager per agent-platform/manager-redeploy-gotchas-20260702.md.
// Decision logic lives in ./lib/deploy-watchdog-decision.mjs (pure + unit-tested).
// Kill switch: touch /tmp/deploy-watchdog.pause. Dry-run: --dry-run or
// DEPLOY_WATCHDOG_DRY_RUN=1. Logs every run to /tmp/deploy-watchdog.log; writes an
// artifact ONLY when it acts (redeploy or failure), never on quiet passes.

import { execSync, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { decideWatchdogAction } from './lib/deploy-watchdog-decision.mjs';
import {
  DEFAULT_REDEPLOY_COMMAND,
  classifyCloseout,
  formatCloseoutMarkdown,
} from './lib/deploy-watchdog-closeout.mjs';

const HOME = process.env.HOME || '/Users/kilgore';
const MANAGER_URL = process.env.DEPLOY_WATCHDOG_MANAGER_URL || 'http://localhost:4100';
const PRIMARY_CANE = process.env.DEPLOY_WATCHDOG_PRIMARY_REPO || `${HOME}/Dropbox/Code/cane/id-agents`;
const CANE = process.env.DEPLOY_WATCHDOG_REPO || `${HOME}/Dropbox/Code/cane/id-agents-deploy-main`;
const PLIST = `${HOME}/Library/LaunchAgents/com.kilgore.id-agents-manager.plist`;
const SVC = 'com.kilgore.id-agents-manager';
const LOG = '/tmp/deploy-watchdog.log';
const STATE_FILE = '/tmp/deploy-watchdog.state';
const PAUSE_FILE = '/tmp/deploy-watchdog.pause';
const LOCK_FILE = '/tmp/deploy-watchdog.lock';
const ARTIFACT_DIR = `${HOME}/Dropbox/Code/agent-platform/output`;
const DRY_RUN = process.env.DEPLOY_WATCHDOG_DRY_RUN === '1' || process.argv.includes('--dry-run');
const BOOTSTRAP_BACKOFF_MS = [15000, 30000, 60000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString()}  [watchdog${DRY_RUN ? ':dry-run' : ''}] ${msg}`;
  try { appendFileSync(LOG, line + '\n'); } catch { /* best-effort */ }
  console.log(line);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { consecutiveStale: 0 }; }
}
function writeState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log(`WARN could not persist state: ${e.message}`); }
}

async function getHealth() {
  try {
    const r = await fetch(`${MANAGER_URL}/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return {
      ok: true,
      freshnessState: j?.freshness?.state ?? null,
      buildSha: j?.build?.build_sha ?? null,
      originMainSha: j?.build?.origin_main_sha ?? null,
    };
  } catch {
    return { ok: false };
  }
}

function getRemoteMainSha() {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
      cwd: CANE,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const sha = out.split(/\s+/)[0] || null;
    if (sha) return { sha, source: 'git ls-remote origin refs/heads/main' };
  } catch (e) {
    log(`WARN could not read remote main tip via ls-remote: ${e.message}`);
  }
  try {
    const sha = sh('git rev-parse origin/main', { stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { sha, source: 'git rev-parse origin/main' };
  } catch (e) {
    log(`WARN could not read origin/main: ${e.message}`);
    return { sha: null, source: 'unavailable' };
  }
}

async function getCloseoutEvidence() {
  const [health, remote] = await Promise.all([getHealth(), Promise.resolve(getRemoteMainSha())]);
  return {
    healthOk: health.ok,
    freshnessState: health.freshnessState ?? null,
    buildSha: health.buildSha ?? null,
    originMainSha: health.originMainSha ?? null,
    remoteMainSha: remote.sha,
    remoteMainSource: remote.source,
    redeployCommand: DEFAULT_REDEPLOY_COMMAND,
  };
}

function sh(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, { cwd: CANE, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

function gitOutput(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repoBranch(repo) {
  try { return gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown'; } catch { return 'unknown'; }
}

function repoDirtyCount(repo) {
  try {
    const out = gitOutput(repo, ['status', '--porcelain']);
    return out ? out.split('\n').length : 0;
  } catch {
    return -1;
  }
}

function deployCheckoutExists() {
  return existsSync(`${CANE}/.git`) && existsSync(`${CANE}/scripts/start-id-agents-manager.sh`);
}

function plistValue(keyPath) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${keyPath}`, PLIST], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function managerPlistPointsAtDeployCheckout() {
  return plistValue(':WorkingDirectory') === CANE
    && plistValue(':ProgramArguments:1') === `${CANE}/scripts/start-id-agents-manager.sh`;
}

function captureManagerPlist() {
  return {
    workingDirectory: plistValue(':WorkingDirectory'),
    program: plistValue(':ProgramArguments:1'),
  };
}

function restoreManagerPlist(plist) {
  if (!plist?.workingDirectory || !plist?.program) {
    throw new Error('previous manager plist values unavailable; cannot rollback');
  }
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :WorkingDirectory ${plist.workingDirectory}`, PLIST], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ProgramArguments:1 ${plist.program}`, PLIST], { stdio: ['ignore', 'pipe', 'pipe'] });
  log(`manager plist restored to previous build repo=${plist.workingDirectory}`);
}

function logPrimaryHygiene() {
  const branch = repoBranch(PRIMARY_CANE);
  const dirtyCount = repoDirtyCount(PRIMARY_CANE);
  if (branch !== 'main' || dirtyCount !== 0) {
    log(`HYGIENE-BLOCKED repo=${PRIMARY_CANE} branch=${branch} dirty_count=${dirtyCount} next_action=preserve primary work; rebuild from clean deploy checkout ${CANE}`);
  } else {
    log(`primary hygiene ok repo=${PRIMARY_CANE} branch=${branch} dirty_count=${dirtyCount}`);
  }
}

function ensureDeployCheckout() {
  if (!existsSync(`${PRIMARY_CANE}/.git`)) {
    throw new Error(`primary id-agents checkout missing: ${PRIMARY_CANE}`);
  }
  if (!existsSync(`${CANE}/.git`)) {
    const remoteUrl = gitOutput(PRIMARY_CANE, ['remote', 'get-url', 'origin']);
    log(`creating clean deploy checkout: git clone ${remoteUrl} ${CANE}`);
    execFileSync('git', ['clone', remoteUrl, CANE], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  sh('git fetch --quiet origin');
  sh('git checkout -q -B main origin/main');
  sh('git reset --hard -q origin/main');
  sh("git clean -ffd -e node_modules -e 'node_modules/**' -q");
  const branch = repoBranch(CANE);
  const dirtyCount = repoDirtyCount(CANE);
  if (branch !== 'main' || dirtyCount !== 0) {
    throw new Error(`deploy checkout not clean main: repo=${CANE} branch=${branch} dirty_count=${dirtyCount}`);
  }
}

function ensureManagerPlistUsesDeployCheckout() {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :WorkingDirectory ${CANE}`, PLIST], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ProgramArguments:1 ${CANE}/scripts/start-id-agents-manager.sh`, PLIST], { stdio: ['ignore', 'pipe', 'pipe'] });
  log(`manager plist points at deploy checkout repo=${CANE}`);
}

function acquireRedeployLock() {
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    log(`redeploy lock acquired: ${LOCK_FILE}`);
    return () => {
      try { closeSync(fd); } catch { /* best-effort */ }
      try { unlinkSync(LOCK_FILE); } catch { /* best-effort */ }
      log(`redeploy lock released: ${LOCK_FILE}`);
    };
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    throw new Error(`redeploy already running or lock unavailable: ${LOCK_FILE} (${e.message})`);
  }
}

async function withRedeployLock(fn) {
  const release = acquireRedeployLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

function installDependencies() {
  try {
    sh('npm ci');
    return;
  } catch (e) {
    log(`WARN npm ci failed; attempting ignored node_modules symlink fallback from primary checkout: ${e.message}`);
  }
  if (!existsSync(`${PRIMARY_CANE}/node_modules`)) {
    throw new Error(`npm ci failed and primary node_modules is unavailable; repo=${PRIMARY_CANE}`);
  }
  sh('rm -rf node_modules');
  execFileSync('ln', ['-s', `${PRIMARY_CANE}/node_modules`, `${CANE}/node_modules`], { stdio: ['ignore', 'pipe', 'pipe'] });
  log(`node_modules fallback linked: ${CANE}/node_modules -> ${PRIMARY_CANE}/node_modules`);
}

export async function retryBootoutBootstrap({
  restart,
  backoffs = BOOTSTRAP_BACKOFF_MS,
  sleepFn = sleep,
  logFn = () => {},
} = {}) {
  if (typeof restart !== 'function') throw new Error('restart function is required');
  const attempts = backoffs.length;
  let lastError = null;
  for (let index = 0; index < attempts; index++) {
    const attempt = index + 1;
    try {
      await restart(attempt);
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      logFn(`bootstrap attempt ${attempt}/${attempts} failed: ${msg}`);
      const delay = backoffs[index];
      if (attempt < attempts && delay > 0) {
        logFn(`waiting ${Math.round(delay / 1000)}s before bootstrap retry`);
        await sleepFn(delay);
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`bootstrap failed after ${attempts} attempts: ${msg}`);
}

export async function bootstrapWithRollback({
  forward,
  rollback,
  backoffs = BOOTSTRAP_BACKOFF_MS,
  sleepFn = sleep,
  logFn = () => {},
} = {}) {
  try {
    const result = await retryBootoutBootstrap({ restart: forward, backoffs, sleepFn, logFn });
    return { status: 'forward_started', attempts: result.attempts, rollbackAttempted: false };
  } catch (forwardError) {
    const forwardMsg = forwardError instanceof Error ? forwardError.message : String(forwardError);
    logFn(`forward bootstrap exhausted; attempting rollback: ${forwardMsg}`);
    try {
      await rollback();
      return { status: 'rolled_back', attempts: backoffs.length, rollbackAttempted: true, forwardError: forwardMsg };
    } catch (rollbackError) {
      const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const err = new Error(`forward bootstrap failed and rollback bootstrap failed: forward=${forwardMsg}; rollback=${rollbackMsg}`);
      err.forwardError = forwardError;
      err.rollbackError = rollbackError;
      err.rollbackFailed = true;
      throw err;
    }
  }
}

/** Read NODE_BIN from the manager plist (Gotcha 6 — do NOT hardcode; it moved once). */
function readNodeBin() {
  try {
    const out = execSync(`plutil -p ${PLIST}`, { encoding: 'utf8' });
    const m = out.match(/"NODE_BIN"\s*=>\s*"([^"]+)"/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return '/opt/homebrew/bin/node';
}

/** The full gotchas redeploy sequence. Throws on any failure (caller alerts). */
async function runRedeploy() {
  const previousPlist = captureManagerPlist();
  const previousHealth = await getHealth();
  const previousRepo = previousPlist.workingDirectory;
  const previousRepoSha = previousRepo && existsSync(`${previousRepo}/.git`)
    ? (() => { try { return gitOutput(previousRepo, ['rev-parse', 'HEAD']); } catch { return null; } })()
    : null;

  logPrimaryHygiene();
  ensureDeployCheckout();

  // Gotcha 5 — new code / old node_modules → missing deps crash on boot.
  installDependencies();

  // Gotcha 6 — rebuild the native module against the plist NODE_BIN (two-node ABI split).
  const nodeBin = readNodeBin();
  const nodeDir = dirname(nodeBin);
  log(`Gotcha-6: NODE_BIN=${nodeBin}`);
  sh(`PATH="${nodeDir}:$PATH" npm rebuild better-sqlite3`);
  execFileSync(nodeBin, ['-e', "require('better-sqlite3'); console.log('native OK', process.version)"], { cwd: CANE, stdio: 'inherit' });

  // Gotcha 4 — run the three build sub-steps directly (chained npm run build dies opaquely).
  sh('npx tsc');
  sh('npx tsc -p src/tui/tsconfig.json');
  sh('node scripts/write-build-info.mjs'); // writes dist/build-info.json — the freshness truth
  ensureManagerPlistUsesDeployCheckout();

  // Restart via launchd (hermetic env — no CLAUDECODE / parent-shell leak).
  const restartResult = await bootstrapWithRollback({
    logFn: log,
    sleepFn: sleep,
    forward: async () => {
      sh(`launchctl bootout gui/$(id -u)/${SVC} || true`);
      sh(`launchctl bootstrap gui/$(id -u) ${PLIST}`);
    },
    rollback: async () => {
      if (previousRepo && previousRepoSha && existsSync(`${previousRepo}/.git`)) {
        execFileSync('git', ['reset', '--hard', '-q', previousRepoSha], { cwd: previousRepo, stdio: ['ignore', 'pipe', 'pipe'] });
        log(`rollback repo reset to previous known-good sha=${previousRepoSha.slice(0, 12)} repo=${previousRepo}`);
      }
      restoreManagerPlist(previousPlist);
      sh(`launchctl bootout gui/$(id -u)/${SVC} || true`);
      sh(`launchctl bootstrap gui/$(id -u) ${PLIST}`);
      await sleep(20000);
      const h = await getHealth();
      if (!h.ok) throw new Error('rollback manager health unreadable after bootstrap');
      if (previousHealth.buildSha && h.buildSha && h.buildSha !== previousHealth.buildSha) {
        throw new Error(`rollback health build_sha=${h.buildSha} did not return to previous build_sha=${previousHealth.buildSha}`);
      }
    },
  });
  if (restartResult.status === 'rolled_back') {
    const err = new Error(`forward bootstrap failed after ${restartResult.attempts} attempts; rollback restored previous manager build`);
    err.rolledBack = true;
    err.forwardError = restartResult.forwardError;
    throw err;
  }

  // Gotcha 8.1 — build_sha == origin_main_sha + freshness fresh.
  await sleep(20000);
  const h = await getHealth();
  const remote = getRemoteMainSha();
  const closeout = classifyCloseout({
    healthOk: h.ok,
    freshnessState: h.freshnessState ?? null,
    buildSha: h.buildSha ?? null,
    originMainSha: h.originMainSha ?? null,
    remoteMainSha: remote.sha,
    remoteMainSource: remote.source,
    redeployCommand: DEFAULT_REDEPLOY_COMMAND,
  });
  if (!closeout.ok) throw new Error(closeout.summary);

  // Gotcha 8.2 — prove fleet auth survived the restart (post-restart 401s are silent:
  // /health passes while every dispatch fails). An authenticated fleet-API call
  // that 401s here is the documented failure mode.
  const authRes = await fetch(`${MANAGER_URL}/agents`, {
    headers: { 'x-id-admin': '1' },
    signal: AbortSignal.timeout(8000),
  });
  if (authRes.status === 401 || authRes.status === 403) {
    throw new Error(`post-restart fleet auth broke: GET /agents → ${authRes.status} (health passes but dispatches would fail)`);
  }
  if (!authRes.ok) throw new Error(`post-restart /agents → HTTP ${authRes.status}`);

  return { promotedSha: h.buildSha, closeoutEvidence: { ...h, remoteMainSha: remote.sha, remoteMainSource: remote.source } };
}

function writeArtifact(kind, body) {
  const date = new Date().toISOString().slice(0, 10);
  const path = `${ARTIFACT_DIR}/${date}-deploy-watchdog-${kind}.md`;
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    appendFileSync(path, body + '\n\n');
    log(`artifact written: ${path}`);
  } catch (e) {
    log(`WARN could not write artifact: ${e.message}`);
  }
  return path;
}

/** Best-effort time-sensitive note to the manager inbox so it surfaces to Chris.
 *  The manager may be down (that's why we also always write the artifact). */
async function postNote(message, urgency = 'time_sensitive') {
  try {
    await fetch(`${MANAGER_URL}/news`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', from: 'deploy-watchdog', message, urgency }),
      signal: AbortSignal.timeout(8000),
    });
    log('time-sensitive note posted to manager /news');
  } catch (e) {
    log(`WARN could not post note (manager may be down): ${e.message}`);
  }
}

async function main() {
  try { mkdirSync(dirname(LOG), { recursive: true }); } catch { /* /tmp exists */ }

  const pauseFileExists = existsSync(PAUSE_FILE);
  const health = await getHealth();
  const state = readState();
  const prior = Number(state.consecutiveStale || 0);
  const decision = decideWatchdogAction({
    freshnessState: health.freshnessState ?? null,
    priorConsecutiveStale: prior,
    pauseFileExists,
    healthOk: health.ok,
    deployCheckoutOk: deployCheckoutExists(),
    managerPlistOk: managerPlistPointsAtDeployCheckout(),
    priorLastAction: state.lastAction ?? null,
    originMainSha: health.originMainSha ?? null,
    priorTargetSha: state.targetSha ?? null,
    priorConsecutiveTarget: Number(state.consecutiveTarget || 0),
  });
  writeState({
    consecutiveStale: decision.nextConsecutiveStale,
    targetSha: decision.nextTargetSha,
    consecutiveTarget: decision.nextConsecutiveTarget,
    lastAction: decision.action,
    lastAt: new Date().toISOString(),
  });
  log(`decision=${decision.action} (${decision.reason}) health_ok=${health.ok} freshness=${health.freshnessState ?? 'n/a'} build_sha=${(health.buildSha || '').slice(0, 7)}`);

  if (decision.action !== 'act') {
    // Quiet pass — log only, no artifact.
    process.exitCode = 0;
    return;
  }

  if (DRY_RUN) {
    const note = `[DRY-RUN] deploy-watchdog WOULD redeploy: ${decision.reason}. build_sha=${health.buildSha} origin_main_sha=${health.originMainSha}. (No action taken.)`;
    log(note);
    writeArtifact('dryrun', `# Deploy watchdog — DRY-RUN act simulation ${new Date().toISOString()}\n\n${note}`);
    process.exitCode = 0;
    return;
  }

  // Real redeploy.
  log(`ACT: ${decision.reason} — running gotchas redeploy sequence.`);
  try {
    const { promotedSha } = await withRedeployLock(() => runRedeploy());
    const closeoutEvidence = await getCloseoutEvidence();
    const closeout = classifyCloseout(closeoutEvidence);
    if (!closeout.ok) throw new Error(closeout.summary);
    const ok = `# Deploy watchdog — REDEPLOY OK ${new Date().toISOString()}\n\nWatchdog reason: ${decision.reason}. Redeployed to ${promotedSha} (build_sha==origin_main_sha, origin_main_sha==remote tip, freshness fresh, fleet auth OK).\n\n${formatCloseoutMarkdown(closeoutEvidence)}`;
    writeArtifact('redeploy', ok);
    await postNote(`✅ deploy-watchdog auto-redeployed the manager to ${promotedSha}. Reason: ${decision.reason}.`, 'normal');
    process.exitCode = 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err?.rolledBack) {
      const body = `# Deploy watchdog — FORWARD BOOTSTRAP ROLLED BACK ${new Date().toISOString()}\n\nThe forward redeploy bootstrap failed, and the watchdog re-bootstrapped the previous known-good manager plist/build.\n\n**Forward error:** ${msg}\n\nWatchdog log: ${LOG}.`;
      writeArtifact('rollback', body);
      log(`REDEPLOY ROLLED BACK: ${msg}`);
      process.exitCode = 1;
    } else {
      const closeoutEvidence = await getCloseoutEvidence();
      const closeout = classifyCloseout(closeoutEvidence);
      const escalation = closeout.escalation || `Manager state unknown after watchdog remediation. Run exactly: ${DEFAULT_REDEPLOY_COMMAND}`;
      const loud = `# ⛔ Deploy watchdog — REDEPLOY FAILED ${new Date().toISOString()}\n\nThe automated redeploy FAILED and the manager may be down or stale.\n\n**Error:** ${msg}\n\n${formatCloseoutMarkdown(closeoutEvidence)}\n\n**Escalation command:**\n\n\`\`\`bash\n${DEFAULT_REDEPLOY_COMMAND}\n\`\`\`\n\nWatchdog log: ${LOG}. launchd state: \`launchctl print gui/$(id -u)/${SVC}\`.`;
      writeArtifact('FAILURE', loud);
      log(`REDEPLOY FAILED: ${msg}`);
      await postNote(`⛔ deploy-watchdog closeout failed: ${msg}. ${escalation}`, 'time_sensitive');
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
