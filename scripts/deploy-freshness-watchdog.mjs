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

const HOME = process.env.HOME || '/Users/kilgore';
const MANAGER_URL = process.env.DEPLOY_WATCHDOG_MANAGER_URL || 'http://localhost:4100';
const CANE = process.env.DEPLOY_WATCHDOG_REPO || `${HOME}/Dropbox/Code/cane/id-agents`;
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

function sh(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, { cwd: CANE, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
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
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Gotcha 2 — snapshot a dirty canonical checkout; NEVER clobber, never stash-drop.
  const dirty = sh('git status --porcelain').trim();
  if (dirty) {
    log(`Gotcha-2: canonical checkout dirty (${dirty.split('\n').length} paths) → snapshot to wip/pre-redeploy-snapshot-${date}`);
    sh(`git switch -c wip/pre-redeploy-snapshot-${date} 2>/dev/null || git switch wip/pre-redeploy-snapshot-${date}`);
    // Snapshot tracked+untracked SOURCE/config, but not stray db/lockfiles (Gotcha 2).
    sh(`git add -A -- . ':!manager.db' ':!*.db' ':!pnpm-lock.yaml'`);
    sh(`git commit -m "WIP snapshot before manager redeploy ${new Date().toISOString()}" || true`);
  }

  // Gotcha 3 — build from a dated deploy branch at origin/main (main is worktree-held).
  sh('git fetch origin');
  sh(`git switch -c deploy/manager-${date} origin/main 2>/dev/null || (git switch deploy/manager-${date} && git reset --hard origin/main)`);

  // Gotcha 5 — new code / old node_modules → missing deps crash on boot.
  sh('npm ci');

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

  // Restart via launchd (hermetic env — no CLAUDECODE / parent-shell leak).
  sh(`launchctl kickstart -k gui/$(id -u)/${SVC}`);

  // Gotcha 8.1 — build_sha == origin_main_sha + freshness fresh.
  await sleep(20000);
  const h = await getHealth();
  if (!h.ok) throw new Error('post-restart /health unreadable (Gotcha 7: check /tmp/id-agents-manager.err + launchctl print)');
  if (h.buildSha !== h.originMainSha) throw new Error(`build_sha ${h.buildSha} != origin_main_sha ${h.originMainSha}`);
  if (h.freshnessState !== 'fresh') throw new Error(`freshness=${h.freshnessState} (expected fresh) after restart`);

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

  return { promotedSha: h.buildSha };
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
    const ok = `# Deploy watchdog — REDEPLOY OK ${new Date().toISOString()}\n\nManager was stale_alerted for ${decision.nextConsecutiveStale} consecutive checks; redeployed to ${promotedSha} (build_sha==origin_main_sha, freshness fresh, fleet auth OK).`;
    writeArtifact('redeploy', ok);
    await postNote(`✅ deploy-watchdog auto-redeployed the manager to ${promotedSha} (was stale_alerted 30+ min).`, 'normal');
    process.exitCode = 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const loud = `# ⛔ Deploy watchdog — REDEPLOY FAILED ${new Date().toISOString()}\n\nThe automated redeploy FAILED and the manager may be down or stale.\n\n**Error:** ${msg}\n\n**Do NOT assume the manager is healthy.** Manual redeploy per agent-platform/manager-redeploy-gotchas-20260702.md. Check /tmp/id-agents-manager.err and \`launchctl print gui/$(id -u)/${SVC}\`. Watchdog log: ${LOG}.`;
    writeArtifact('FAILURE', loud);
    log(`REDEPLOY FAILED: ${msg}`);
    await postNote(`⛔ deploy-watchdog FAILED to redeploy the manager: ${msg}. Manual intervention needed — see agent-platform/output/ failure artifact.`, 'time_sensitive');
    process.exitCode = 1;
  }
}

main();
