// SPDX-License-Identifier: MIT
//
// Fleet file-drop — I/O helpers shared by the sender CLI (scripts/agentdrop)
// and the receiver watcher (scripts/agentdrop-watcher). Kept separate from
// the pure decision/manifest logic (agentdrop-manifest.mjs,
// agentdrop-watcher-decision.mjs) so those stay unit-testable without a
// disk, a manager, or a network.
//
// Design Decision 2 (plan §"Design decisions"): the watcher is a standalone
// launchd process, not a live Claude session, so confirmation goes straight
// to the Telegram HTTP API (matching src/continuous-orchestration/telegram.ts's
// own approach) rather than the PushNotification harness tool, which has no
// surface a launchd script can call.
//
// Design Decision 3: agent -> host/workingDirectory resolution is ALWAYS a
// live GET /agents call, never a static config file, so a moved/renamed
// agent can't silently go stale here the way the Dropbox Smart Sync state
// silently regressed in the incident that started this feature.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Resolve `--for <agent-name>` (or a drained manifest's `agent` field)
 *  against the LIVE manager registry. Matches case-insensitively against
 *  either `alias` (the plain human name, e.g. "finances") or `name` (the
 *  ENS-domain-or-alias display id) — never a static map. */
export async function resolveAgent(managerUrl, agentName, fetchImpl = fetch) {
  const res = await fetchImpl(`${managerUrl}/agents?all=true&limit=500`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET /agents failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const agents = Array.isArray(body?.agents) ? body.agents : [];
  const wanted = agentName.trim().toLowerCase();
  const match = agents.find(
    (a) => String(a.alias ?? '').toLowerCase() === wanted || String(a.name ?? '').toLowerCase() === wanted,
  );
  return match ? { found: true, agent: match } : { found: false, agent: null };
}

export async function postDropTask(managerUrl, { title, name, from }, fetchImpl = fetch) {
  const res = await fetchImpl(`${managerUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, name, from }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Best-effort Telegram alert — never throws (a notification failure must
 *  never crash the drain loop or block a batch from being processed). */
export async function sendTelegramAlert(message, env = process.env, fetchImpl = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn(`[agentdrop-watcher] Telegram not configured; alert dropped: ${message}`);
    return;
  }
  try {
    await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('[agentdrop-watcher] Telegram send failed:', err);
  }
}

/** Files currently sitting in a directory, excluding sub-directories
 *  (`_failed/` quarantine dirs, per-batch delivered dirs elsewhere). */
export function listFlatFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile());
}

export function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return { exists: false, parsed: null, parseError: null };
  try {
    const raw = readFileSync(filePath, 'utf8');
    return { exists: true, parsed: JSON.parse(raw), parseError: null };
  } catch (err) {
    return { exists: true, parsed: null, parseError: err instanceof Error ? err.message : String(err) };
  }
}

export function fileAgeMs(filePath, now = Date.now()) {
  const st = statSync(filePath);
  return Math.max(0, now - st.mtimeMs);
}

/** Move a named batch's files (manifest + listed files, only the ones that
 *  actually exist — a partial move never throws) from `stagingDir` into
 *  `destDir`, creating `destDir` if needed. Returns the filenames moved. */
export function moveBatchFiles(stagingDir, filenames, destDir) {
  mkdirSync(destDir, { recursive: true });
  const moved = [];
  for (const name of filenames) {
    const from = path.join(stagingDir, name);
    if (!existsSync(from)) continue;
    renameSync(from, path.join(destDir, name));
    moved.push(name);
  }
  return moved;
}

/** Quarantine a batch: move whatever of its files are present (manifest
 *  included, if it exists) into `stagingDir/_failed/<ts>-<slug>/`, plus a
 *  `reason.txt` explaining why — so a bad batch is inspectable, not lost. */
export function quarantineBatchFiles(stagingDir, filenames, reason, now = new Date()) {
  const slug = now.toISOString().replace(/[:.]/g, '-');
  const destDir = path.join(stagingDir, '_failed', slug);
  mkdirSync(destDir, { recursive: true });
  const moved = moveBatchFiles(stagingDir, filenames, destDir);
  writeFileSync(path.join(destDir, 'reason.txt'), `${reason}\n`);
  return { destDir, moved };
}
