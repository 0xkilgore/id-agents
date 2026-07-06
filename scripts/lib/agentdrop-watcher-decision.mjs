// SPDX-License-Identifier: MIT
//
// Fleet file-drop receiver (agentdrop-watcher) — the PURE decision logic for
// one drained batch. Mirrors the shape of deploy-watchdog-decision.mjs: the
// imperative watcher script and the unit tests both import this single
// source of truth, so "what should happen to this batch" never depends on
// anything the tests can't construct directly.
//
// This exists specifically to close the Dropbox-Smart-Sync silent-failure
// gap (agent-platform/cto/output/fleet-file-drop-spec.md §1) — so it must
// fail LOUDLY and CORRECTLY: a batch that can't be delivered is quarantined
// with a reason, never silently dropped or guessed at.
//
// Plan: docs/superpowers/plans/2026-07-04-fleet-file-drop.md, Slice B.

/** How long an incomplete batch is given to finish arriving before it's
 *  treated as genuinely stuck (vs. `tailscale file cp` still mid-transfer —
 *  it sends files one at a time, so the manifest can legitimately land
 *  before every listed file has finished draining). */
export const INCOMPLETE_GRACE_MS = 30_000;

/**
 * Decide what to do with one drained batch. Pure — every input is data the
 * caller already gathered (manifest validation result, which listed files
 * are actually present, how old the manifest is, and whether the named
 * agent resolves in the live registry). Never touches the filesystem or
 * network itself.
 *
 * @param {object} input
 * @param {{ok: boolean, manifest?: object, errors?: string[]}} input.manifestResult
 *   from validateManifestShape() — or a synthetic {ok:false, errors:[...]}
 *   when _dropmeta.json is missing entirely.
 * @param {{complete: boolean, missing: string[]}} [input.batchComplete]
 *   from checkBatchComplete() — required only when manifestResult.ok.
 * @param {number} [input.manifestAgeMs] - ms since the manifest was first
 *   observed in staging (required only when manifestResult.ok).
 * @param {{found: boolean, agent: {workingDirectory?: string|null}|null}} [input.agentResolution]
 *   from resolving manifest.agent against the live GET /agents registry.
 * @param {number} [input.graceMs]
 * @returns {{action: 'wait'|'quarantine'|'deliver', reason: string, targetDirSuffix?: string, taskTitle?: string, taskName?: string}}
 */
export function decideBatchOutcome({
  manifestResult,
  batchComplete,
  manifestAgeMs = 0,
  agentResolution,
  graceMs = INCOMPLETE_GRACE_MS,
}) {
  if (!manifestResult.ok) {
    return {
      action: 'quarantine',
      reason: `invalid or missing manifest: ${(manifestResult.errors || []).join('; ')}`,
    };
  }
  const manifest = manifestResult.manifest;

  if (!batchComplete.complete) {
    if (manifestAgeMs < graceMs) {
      return {
        action: 'wait',
        reason: `batch still draining (missing ${batchComplete.missing.join(', ')}; age ${manifestAgeMs}ms < grace ${graceMs}ms)`,
      };
    }
    return {
      action: 'quarantine',
      reason: `batch incomplete after grace period: missing ${batchComplete.missing.join(', ')} (age ${manifestAgeMs}ms >= grace ${graceMs}ms)`,
    };
  }

  if (!agentResolution || !agentResolution.found) {
    return {
      action: 'quarantine',
      reason: `unknown agent "${manifest.agent}" (not in live registry) — not guessing at a destination`,
    };
  }
  const workingDirectory = agentResolution.agent?.workingDirectory;
  if (!workingDirectory) {
    return {
      action: 'quarantine',
      reason: `agent "${manifest.agent}" has no workingDirectory in the live registry`,
    };
  }

  return {
    action: 'deliver',
    reason: 'manifest valid, batch complete, agent resolved',
    targetDirSuffix: `inbox/${manifest.batch_id}`,
  };
}
