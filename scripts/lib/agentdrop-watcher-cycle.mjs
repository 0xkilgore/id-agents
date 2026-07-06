// SPDX-License-Identifier: MIT
//
// Fleet file-drop receiver — one full scan cycle over the staging directory
// `tailscale file get --wait --loop` continuously drains into. Ties together
// the pure manifest/decision logic with the I/O helpers.
//
// v1 scope (documented, not a hidden gap): the staging directory is FLAT —
// Taildrop has no per-batch subdirectory concept, so this supports one
// in-flight batch at a time cleanly. Two genuinely simultaneous drops with
// colliding filenames is an accepted, unlikely-for-this-use-case edge case
// (single user, own tailnet, occasional monthly batches per the spec) rather
// than something this v1 tries to fully disambiguate.
//
// Every batch is processed in its own try/catch — one malformed/broken batch
// must never stop the loop from draining a subsequent, valid one (plan
// Slice B acceptance: "the loop must keep draining subsequent batches even
// after a malformed one"). Nothing here is stateful across calls beyond
// what's on disk, which is what makes a watcher restart mid-batch safe:
// every call re-derives its decision fresh from the filesystem + manifest
// age, never from in-memory state a restart would lose.

import path from 'node:path';
import {
  MANIFEST_FILENAME,
  checkBatchComplete,
  validateManifestShape,
  buildDropTaskName,
  buildDropTaskTitle,
} from './agentdrop-manifest.mjs';
import { decideBatchOutcome, INCOMPLETE_GRACE_MS } from './agentdrop-watcher-decision.mjs';
import {
  fileAgeMs,
  listFlatFiles,
  moveBatchFiles,
  postDropTask,
  quarantineBatchFiles,
  readJsonIfExists,
  resolveAgent,
  sendTelegramAlert,
} from './agentdrop-fs.mjs';

const MANIFEST_NAME_RE = /^_dropmeta(?: \(\d+\))?\.json$/;

/**
 * Run one scan cycle over `stagingDir`. Returns an array of per-batch
 * outcome records: `{ manifestFile, outcome: {action, reason, ...}, error? }`.
 * Never throws — a per-batch failure is captured in that batch's record
 * (`error`) and quarantined, rather than aborting the cycle.
 *
 * @param {string} stagingDir
 * @param {object} opts
 * @param {string} opts.managerUrl
 * @param {number} [opts.graceMs]
 * @param {number} [opts.now] - injectable clock (ms), for deterministic tests
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export async function runOneScanCycle(stagingDir, opts) {
  const { managerUrl, graceMs = INCOMPLETE_GRACE_MS, now = Date.now(), fetchImpl = fetch, env = process.env } = opts;
  const results = [];

  const entries = listFlatFiles(stagingDir);
  const manifestFilenames = entries.filter((f) => MANIFEST_NAME_RE.test(f));
  const nonManifestFilenames = entries.filter((f) => !MANIFEST_NAME_RE.test(f));

  for (const manifestFilename of manifestFilenames) {
    const manifestPath = path.join(stagingDir, manifestFilename);
    try {
      const { parsed, parseError } = readJsonIfExists(manifestPath);
      const manifestResult = parseError
        ? { ok: false, errors: [`manifest is not valid JSON: ${parseError}`] }
        : validateManifestShape(parsed);

      if (!manifestResult.ok) {
        const q = quarantineBatchFiles(
          stagingDir,
          [manifestFilename, ...nonManifestFilenames],
          `invalid manifest: ${manifestResult.errors.join('; ')}`,
          new Date(now),
        );
        await sendTelegramAlert(
          `⛔ agentdrop-watcher: quarantined a batch with an invalid manifest (${manifestResult.errors.join('; ')}). Moved to ${q.destDir}.`,
          env,
          fetchImpl,
        );
        results.push({ manifestFile: manifestFilename, outcome: { action: 'quarantine', reason: manifestResult.errors.join('; ') } });
        continue;
      }

      const manifest = manifestResult.manifest;
      const batchComplete = checkBatchComplete(manifest, nonManifestFilenames);
      const manifestAgeMs = fileAgeMs(manifestPath, now);
      const agentResolution = await resolveAgent(managerUrl, manifest.agent, fetchImpl);

      const outcome = decideBatchOutcome({ manifestResult, batchComplete, manifestAgeMs, agentResolution, graceMs });
      results.push({ manifestFile: manifestFilename, outcome });

      if (outcome.action === 'wait') continue;

      if (outcome.action === 'quarantine') {
        const filesToMove = [manifestFilename, ...manifest.files.filter((f) => nonManifestFilenames.includes(f))];
        const q = quarantineBatchFiles(stagingDir, filesToMove, outcome.reason, new Date(now));
        await sendTelegramAlert(
          `⛔ agentdrop-watcher: quarantined batch ${manifest.batch_id} for "${manifest.agent}" — ${outcome.reason}. Moved to ${q.destDir}.`,
          env,
          fetchImpl,
        );
        continue;
      }

      // 'deliver'
      const destDir = path.join(agentResolution.agent.workingDirectory, outcome.targetDirSuffix);
      moveBatchFiles(stagingDir, [manifestFilename, ...manifest.files], destDir);
      const taskName = buildDropTaskName(manifest);
      const taskTitle = buildDropTaskTitle(manifest);
      const taskResult = await postDropTask(managerUrl, { title: taskTitle, name: taskName, from: 'agentdrop-watcher' }, fetchImpl);
      const totalBytes = manifest.files.length; // byte count computed by the caller if needed; count is the honest signal available post-move without re-statting every file here
      await sendTelegramAlert(
        `✅ agentdrop: delivered ${manifest.files.length} file(s) for "${manifest.agent}" (batch ${manifest.batch_id}) to ${destDir}. Task: ${taskName}${taskResult.ok ? '' : ` (task POST failed: HTTP ${taskResult.status})`}.`,
        env,
        fetchImpl,
      );
      results[results.length - 1] = {
        manifestFile: manifestFilename,
        outcome,
        delivered: { destDir, taskName, taskTitle, taskPosted: taskResult.ok, filesMoved: manifest.files.length + 1 },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const q = quarantineBatchFiles(stagingDir, [manifestFilename, ...nonManifestFilenames], `unexpected error: ${message}`, new Date(now));
        await sendTelegramAlert(`⛔ agentdrop-watcher: unexpected error processing a batch (${message}). Moved to ${q.destDir}.`, env, fetchImpl);
      } catch { /* quarantine itself failed — still record the error, keep the cycle alive for other batches */ }
      results.push({ manifestFile: manifestFilename, outcome: { action: 'quarantine', reason: message }, error: message });
    }
  }

  // Stray files with no manifest at all — quarantine only once they've had a
  // fair chance to be followed by a manifest (a manifest and its files can
  // land in either order as tailscale drains them).
  if (manifestFilenames.length === 0 && nonManifestFilenames.length > 0) {
    const oldestAgeMs = Math.max(...nonManifestFilenames.map((f) => fileAgeMs(path.join(stagingDir, f), now)));
    if (oldestAgeMs >= graceMs) {
      const q = quarantineBatchFiles(
        stagingDir,
        nonManifestFilenames,
        `stray file(s) with no ${MANIFEST_FILENAME} after grace period (age ${oldestAgeMs}ms >= ${graceMs}ms)`,
        new Date(now),
      );
      await sendTelegramAlert(
        `⛔ agentdrop-watcher: quarantined ${nonManifestFilenames.length} stray file(s) with no manifest (${nonManifestFilenames.join(', ')}). Moved to ${q.destDir}.`,
        env,
        fetchImpl,
      );
      results.push({ manifestFile: null, outcome: { action: 'quarantine', reason: 'stray files, no manifest' } });
    } else {
      results.push({ manifestFile: null, outcome: { action: 'wait', reason: 'files present, no manifest yet, within grace' } });
    }
  }

  return results;
}
