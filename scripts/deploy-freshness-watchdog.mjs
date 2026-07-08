#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// T-DEPLOY.5 — deploy-freshness watchdog. A launchd job OUTSIDE the fleet (fleet
// agents structurally cannot restart their own manager — Gotcha 0). Every 15 min:
//   1. GET /health. If freshness != stale_alerted → exit 0 quietly.
//   2. If stale_alerted persists (2 consecutive checks, >15 min) → redeploy the
//      manager per agent-platform/manager-redeploy-gotchas-20260702.md.
// Decision logic lives in ./lib/deploy-watchdog-decision.mjs (pure + unit-tested).
// Kill switch: touch /tmp/deploy-watchdog.pause. Dry-run: --dry-run or
// DEPLOY_WATCHDOG_DRY_RUN=1. Logs every run to /tmp/deploy-watchdog.log; writes an
// artifact ONLY when it acts (redeploy or failure), never on quiet passes.

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
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
const ARTIFACT_DIR = `${HOME}/Dropbox/Code/agent-platform/output`;
const DRY_RUN = process.env.DEPLOY_WATCHDOG_DRY_RUN === '1' || process.argv.includes('--dry-run');

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
  sh(`launchctl bootout gui/$(id -u)/${SVC} || true`);
  sh(`launchctl bootstrap gui/$(id -u) ${PLIST}`);

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
  const prior = Number(readState().consecutiveStale || 0);
  const decision = decideWatchdogAction({
    freshnessState: health.freshnessState ?? null,
    priorConsecutiveStale: prior,
    pauseFileExists,
    healthOk: health.ok,
    deployCheckoutOk: deployCheckoutExists(),
    managerPlistOk: managerPlistPointsAtDeployCheckout(),
  });
  writeState({ consecutiveStale: decision.nextConsecutiveStale, lastAction: decision.action, lastAt: new Date().toISOString() });
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
  log('ACT: persistent stale_alerted confirmed — running gotchas redeploy sequence.');
  try {
    const { promotedSha } = await runRedeploy();
    const closeoutEvidence = await getCloseoutEvidence();
    const closeout = classifyCloseout(closeoutEvidence);
    if (!closeout.ok) throw new Error(closeout.summary);
    const ok = `# Deploy watchdog — REDEPLOY OK ${new Date().toISOString()}\n\nManager was stale_alerted for ${decision.nextConsecutiveStale} consecutive checks; redeployed to ${promotedSha} (build_sha==origin_main_sha, origin_main_sha==remote tip, freshness fresh, fleet auth OK).\n\n${formatCloseoutMarkdown(closeoutEvidence)}`;
    writeArtifact('redeploy', ok);
    await postNote(`✅ deploy-watchdog auto-redeployed the manager to ${promotedSha} (was stale_alerted 30+ min).`, 'normal');
    process.exitCode = 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

main();
