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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { decideWatchdogAction } from './lib/deploy-watchdog-decision.mjs';
import { retryLaunchdBootstrap } from './lib/deploy-watchdog-bootstrap.mjs';
import { acquireWatchdogLock, DEFAULT_LOCK_STALE_MS } from './lib/deploy-watchdog-lock.mjs';
import {
  assertCleanDeployCheckout,
  formatChangedFiles,
  getWorktreeHygiene,
  gitOutput,
} from './lib/deploy-watchdog-worktree-hygiene.mjs';
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
const LOG = process.env.DEPLOY_WATCHDOG_LOG || '/tmp/deploy-watchdog.log';
const STATE_FILE = process.env.DEPLOY_WATCHDOG_STATE_FILE || '/tmp/deploy-watchdog.state';
const PAUSE_FILE = process.env.DEPLOY_WATCHDOG_PAUSE_FILE || '/tmp/deploy-watchdog.pause';
const LOCK_FILE = process.env.DEPLOY_WATCHDOG_LOCK_FILE || '/tmp/deploy-watchdog.lock';
const LOCK_STALE_MS = Number(process.env.DEPLOY_WATCHDOG_LOCK_STALE_MS || DEFAULT_LOCK_STALE_MS);
const ARTIFACT_DIR = process.env.DEPLOY_WATCHDOG_ARTIFACT_DIR || `${HOME}/Dropbox/Code/agent-platform/output`;
const DRY_RUN = process.env.DEPLOY_WATCHDOG_DRY_RUN === '1' || process.argv.includes('--dry-run');
const ALLOW_DIRTY_CHECKOUT = process.env.DEPLOY_WATCHDOG_ALLOW_DIRTY_CHECKOUT === '1';
const ENV_FILES = process.env.DEPLOY_WATCHDOG_ENV_FILE
  ? [process.env.DEPLOY_WATCHDOG_ENV_FILE]
  : [`${HOME}/Dropbox/Code/cane/taskview/.env`, `${HOME}/Dropbox/Code/cane/taskview/.env.cane`];
const TELEGRAM_API_BASE = process.env.DEPLOY_WATCHDOG_TELEGRAM_API_BASE || 'https://api.telegram.org';

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

function acquireLock() {
  const result = acquireWatchdogLock({
    lockFile: LOCK_FILE,
    staleMs: LOCK_STALE_MS,
    log,
  });
  if (!result.acquired) process.exitCode = 0;
  return result.fd;
}

function releaseLock(fd) {
  if (fd === null || fd === undefined) return;
  try { closeSync(fd); } catch { /* best-effort */ }
  try { unlinkSync(LOCK_FILE); } catch { /* best-effort */ }
}

function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  try {
    const body = readFileSync(path, 'utf8');
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return true;
  } catch (e) {
    log(`WARN could not load env file ${path}: ${e.message}`);
    return false;
  }
}

for (const envFile of ENV_FILES) loadEnvFile(envFile);
if (!process.env.TELEGRAM_BOT_TOKEN && process.env.CANE_TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = process.env.CANE_TELEGRAM_BOT_TOKEN;
}
if (!process.env.TELEGRAM_CHAT_ID && process.env.CANE_TELEGRAM_CHAT_ID) {
  process.env.TELEGRAM_CHAT_ID = process.env.CANE_TELEGRAM_CHAT_ID;
}

function alertText({ title, reason, lines = [] }) {
  return [
    `DEPLOY WATCHDOG PAGE: ${title}`,
    `Time: ${new Date().toISOString()}`,
    `Manager: ${MANAGER_URL}`,
    `Reason: ${reason}`,
    ...lines.filter(Boolean),
    `Log: ${LOG}`,
  ].join('\n');
}

async function sendTelegramPage({ title, reason, lines = [] }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log('WARN Telegram not configured; alert dropped');
    return false;
  }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: alertText({ title, reason, lines }) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`Telegram alert sent: ${title}`);
    return true;
  } catch (e) {
    log(`WARN Telegram alert failed: ${e.message}`);
    return false;
  }
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

function deployCheckoutExists() {
  return existsSync(`${CANE}/.git`) && existsSync(`${CANE}/scripts/start-id-agents-manager.sh`);
}

function deployCheckoutReady() {
  if (!deployCheckoutExists()) return false;
  try {
    const hygiene = getWorktreeHygiene(CANE);
    return hygiene.branch === 'main' && !hygiene.dirty;
  } catch {
    return false;
  }
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

function setPlistValue(keyPath, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set ${keyPath} ${value}`, PLIST], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function managerPlistPointsAtDeployCheckout() {
  return plistValue(':WorkingDirectory') === CANE
    && plistValue(':ProgramArguments:1') === `${CANE}/scripts/start-id-agents-manager.sh`;
}

function logPrimaryHygiene() {
  const hygiene = getWorktreeHygiene(PRIMARY_CANE);
  if (hygiene.branch !== 'main' || hygiene.dirty) {
    log(`HYGIENE-BLOCKED repo=${PRIMARY_CANE} branch=${hygiene.branch} dirty_count=${hygiene.dirtyCount} changed_files=${formatChangedFiles(hygiene.changedFiles)} next_action=preserve primary work; rebuild from clean deploy checkout ${CANE}`);
  } else {
    log(`primary hygiene ok repo=${PRIMARY_CANE} branch=${hygiene.branch} dirty_count=${hygiene.dirtyCount}`);
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
  const before = assertCleanDeployCheckout({
    repo: CANE,
    allowDirty: ALLOW_DIRTY_CHECKOUT,
    purpose: 'deploy watchdog before rebuild/restart/promotion',
  });
  if (before.dirty && ALLOW_DIRTY_CHECKOUT) {
    log(`WARN dirty deploy checkout explicitly allowed repo=${CANE} branch=${before.branch} dirty_count=${before.dirtyCount} changed_files=${formatChangedFiles(before.changedFiles)}`);
  }
  sh('git merge --ff-only -q origin/main');
  assertCleanDeployCheckout({
    repo: CANE,
    allowDirty: ALLOW_DIRTY_CHECKOUT,
    purpose: 'deploy watchdog after origin/main fast-forward',
  });
}

function ensureManagerPlistUsesDeployCheckout() {
  setPlistValue(':WorkingDirectory', CANE);
  setPlistValue(':ProgramArguments:1', `${CANE}/scripts/start-id-agents-manager.sh`);
  log(`manager plist points at deploy checkout repo=${CANE}`);
}

function restoreManagerPlist(target) {
  if (target?.workingDirectory) setPlistValue(':WorkingDirectory', target.workingDirectory);
  if (target?.programArg1) setPlistValue(':ProgramArguments:1', target.programArg1);
  log(`manager plist rolled back to previous target repo=${target?.workingDirectory ?? 'unknown'} program=${target?.programArg1 ?? 'unknown'}`);
}

/**
 * Slice 2 durability: forward bootstrap with retry, rolling back to the
 * previous manager plist target if every forward attempt fails. Extracted
 * from runRedeploy() so the rollback branch is unit-testable without real
 * launchd/git/network I/O — inject retryBootstrap/restorePlist for tests.
 * Throws only when BOTH forward and rollback bootstrap exhaust retries
 * (the manager is left down; caller alerts).
 */
export async function bootstrapForwardWithRollback({
  previousTarget,
  previousHealth,
  retryBootstrap,
  restorePlist,
  log: logFn = () => {},
}) {
  const forward = await retryBootstrap();
  if (forward.ok) {
    return { ok: true, rolledBack: false };
  }
  const forwardMessage = forward.error?.message ?? 'bootstrap failed';
  logFn(`forward bootstrap failed after ${forward.attempts} attempts; rolling back to previous manager target sha=${previousHealth?.buildSha ?? 'unknown'}`);
  restorePlist(previousTarget);
  const rollback = await retryBootstrap();
  if (!rollback.ok) {
    throw new Error(`forward bootstrap failed (${forwardMessage}); rollback bootstrap also failed (${rollback.error?.message ?? 'unknown'})`);
  }
  return {
    ok: false,
    rolledBack: true,
    rollbackReason: forwardMessage,
    promotedSha: previousHealth?.buildSha ?? 'rolled-back-previous-build',
    closeoutEvidence: { ...previousHealth, remoteMainSha: null, remoteMainSource: 'rollback-after-forward-bootstrap-failure' },
  };
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
  const previousTarget = {
    workingDirectory: plistValue(':WorkingDirectory'),
    programArg1: plistValue(':ProgramArguments:1'),
  };
  const previousHealth = await getHealth();
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
  sh(`"${nodeBin}" scripts/write-build-info.mjs`); // writes dist/build-info.json — the freshness truth
  ensureManagerPlistUsesDeployCheckout();

  // Restart via launchd (hermetic env — no CLAUDECODE / parent-shell leak).
  const bootstrapResult = await bootstrapForwardWithRollback({
    previousTarget,
    previousHealth,
    retryBootstrap: () => retryLaunchdBootstrap({ service: SVC, plist: PLIST, run: (cmd) => sh(cmd), log }),
    restorePlist: restoreManagerPlist,
    log,
  });
  if (!bootstrapResult.ok) {
    return {
      promotedSha: bootstrapResult.promotedSha,
      rolledBack: true,
      rollbackReason: bootstrapResult.rollbackReason,
      closeoutEvidence: bootstrapResult.closeoutEvidence,
    };
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
  const lockFd = acquireLock();
  if (lockFd === null) return;

  try {
    const pauseFileExists = existsSync(PAUSE_FILE);
    const health = await getHealth();
    const state = readState();
    const prior = Number(state.consecutiveStale || 0);
    const remote = getRemoteMainSha();
    const targetSha = remote.sha ?? health.originMainSha ?? null;
    const decision = decideWatchdogAction({
      freshnessState: health.freshnessState ?? null,
      priorConsecutiveStale: prior,
      pauseFileExists,
      healthOk: health.ok,
      deployCheckoutOk: deployCheckoutReady(),
      managerPlistOk: managerPlistPointsAtDeployCheckout(),
      priorLastAction: state.lastAction ?? null,
      targetSha,
      priorTargetSha: state.targetSha ?? null,
      priorTargetStableCount: Number(state.targetStableCount || 0),
    });
    writeState({
      consecutiveStale: decision.nextConsecutiveStale,
      targetSha: decision.nextTargetSha,
      targetStableCount: decision.nextTargetStableCount,
      lastAction: decision.action,
      lastAt: new Date().toISOString(),
    });
    log(`decision=${decision.action} (${decision.reason}) health_ok=${health.ok} freshness=${health.freshnessState ?? 'n/a'} build_sha=${(health.buildSha || '').slice(0, 7)} target_sha=${(targetSha || '').slice(0, 7)} target_stable=${decision.nextTargetStableCount}`);

    if (!health.ok) {
      await sendTelegramPage({
        title: 'manager health unreachable',
        reason: decision.reason,
        lines: [
          `Action: ${decision.action}`,
          `Prior stale count: ${prior}`,
          `Pause file present: ${pauseFileExists ? 'yes' : 'no'}`,
        ],
      });
    }

    if (decision.action !== 'act') {
      // Quiet pass — log only, no artifact.
      process.exitCode = 0;
      return;
    }

    await sendTelegramPage({
      title: 'manager stale/behind threshold exceeded',
      reason: decision.reason,
      lines: [
        `Freshness: ${health.freshnessState ?? 'n/a'}`,
        `build_sha: ${health.buildSha ?? 'n/a'}`,
        `origin_main_sha: ${health.originMainSha ?? 'n/a'}`,
        `Dry run: ${DRY_RUN ? 'yes' : 'no'}`,
      ],
    });

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
      const result = await runRedeploy();
      if (result.rolledBack) {
        const body = `# Deploy watchdog — ROLLED BACK ${new Date().toISOString()}\n\nWatchdog reason: ${decision.reason}.\n\nForward bootstrap failed after retries: ${result.rollbackReason}. Rollback bootstrap succeeded, so the previous manager build is running instead of leaving the manager down.\n\nPrevious build_sha: ${result.promotedSha}\n\nWatchdog log: ${LOG}.`;
        writeArtifact('rollback', body);
        await postNote(`deploy-watchdog forward redeploy failed but rollback bootstrap succeeded; previous manager build is running. Reason: ${result.rollbackReason}.`, 'normal');
        process.exitCode = 0;
        return;
      }
      const closeoutEvidence = await getCloseoutEvidence();
      const closeout = classifyCloseout(closeoutEvidence);
      if (!closeout.ok) throw new Error(closeout.summary);
      const ok = `# Deploy watchdog — REDEPLOY OK ${new Date().toISOString()}\n\nWatchdog reason: ${decision.reason}. Redeployed to ${result.promotedSha} (build_sha==origin_main_sha, origin_main_sha==remote tip, freshness fresh, fleet auth OK).\n\n${formatCloseoutMarkdown(closeoutEvidence)}`;
      writeArtifact('redeploy', ok);
      await postNote(`✅ deploy-watchdog auto-redeployed the manager to ${result.promotedSha}. Reason: ${decision.reason}.`, 'normal');
      process.exitCode = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const closeoutEvidence = await getCloseoutEvidence();
      const closeout = classifyCloseout(closeoutEvidence);
      const escalation = closeout.escalation || `Manager state unknown after watchdog remediation. Run exactly: ${DEFAULT_REDEPLOY_COMMAND}`;
      const loud = `# ⛔ Deploy watchdog — REDEPLOY FAILED ${new Date().toISOString()}\n\nThe automated redeploy FAILED and the manager may be down or stale.\n\n**Error:** ${msg}\n\n${formatCloseoutMarkdown(closeoutEvidence)}\n\n**Escalation command:**\n\n\`\`\`bash\n${DEFAULT_REDEPLOY_COMMAND}\n\`\`\`\n\nWatchdog log: ${LOG}. launchd state: \`launchctl print gui/$(id -u)/${SVC}\`.`;
      writeArtifact('FAILURE', loud);
      log(`REDEPLOY FAILED: ${msg}`);
      await sendTelegramPage({
        title: 'redeploy attempt FAILED',
        reason: msg,
        lines: [
          `Watchdog reason: ${decision.reason}`,
          `Escalation: ${escalation}`,
          `Artifact: ${ARTIFACT_DIR}`,
        ],
      });
      await postNote(`⛔ deploy-watchdog closeout failed: ${msg}. ${escalation}`, 'time_sensitive');
      process.exitCode = 1;
    }
  } finally {
    releaseLock(lockFd);
  }
}

main();
