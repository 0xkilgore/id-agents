// SPDX-License-Identifier: MIT
//
// Fleet file-drop (agentdrop.v1) — the shared manifest contract between the
// sender CLI (scripts/agentdrop) and the receiver watcher
// (scripts/agentdrop-watcher). Pure, no I/O — the manifest shape is the
// single source of truth both sides agree on.
//
// Spec: cto/output/fleet-file-drop-spec.md §4.3
// Plan: docs/superpowers/plans/2026-07-04-fleet-file-drop.md

export const MANIFEST_SCHEMA = 'agentdrop.v1';
export const MANIFEST_FILENAME = '_dropmeta.json';

/** "2026-07-04T22-41-00Z-a1b2c3" — filesystem/task-name safe (no colons). */
export function generateBatchId(now = new Date(), randomHex = randomHexSuffix()) {
  const iso = now.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `${iso}-${randomHex}`;
}

function randomHexSuffix() {
  let hex = '';
  for (let i = 0; i < 6; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

/**
 * Build an agentdrop.v1 manifest object. Pure — no filesystem/network access.
 * @param {{agent: string, sender: string, files: string[], now?: Date, batchId?: string}} input
 */
export function buildManifest({ agent, sender, files, now = new Date(), batchId }) {
  return {
    schema: MANIFEST_SCHEMA,
    batch_id: batchId ?? generateBatchId(now),
    agent,
    sender,
    files: [...files],
    sent_at: now.toISOString(),
  };
}

/**
 * Validate a raw (untrusted, parsed-JSON) manifest against the agentdrop.v1
 * shape. Pure. Returns {ok:true, manifest} or {ok:false, errors: string[]}.
 * A malformed or spoofed manifest must never reach agent/task creation —
 * this is the gate the watcher runs every drained manifest through first.
 */
export function validateManifestShape(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest is not a JSON object'] };
  }
  if (raw.schema !== MANIFEST_SCHEMA) {
    errors.push(`schema must be "${MANIFEST_SCHEMA}", got ${JSON.stringify(raw.schema)}`);
  }
  if (typeof raw.batch_id !== 'string' || raw.batch_id.trim() === '') {
    errors.push('batch_id missing or empty');
  }
  if (typeof raw.agent !== 'string' || raw.agent.trim() === '') {
    errors.push('agent missing or empty');
  }
  if (typeof raw.sender !== 'string' || raw.sender.trim() === '') {
    errors.push('sender missing or empty');
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0 || !raw.files.every((f) => typeof f === 'string' && f.trim() !== '')) {
    errors.push('files must be a non-empty array of non-empty strings');
  }
  if (typeof raw.sent_at !== 'string' || Number.isNaN(Date.parse(raw.sent_at))) {
    errors.push('sent_at missing or not a valid ISO timestamp');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: raw };
}

/**
 * Which of a validated manifest's listed files are actually present in the
 * staging directory right now. Pure — takes the directory listing as input
 * rather than reading the filesystem itself, so it's testable without a
 * real disk.
 * @param {{files: string[]}} manifest
 * @param {string[]} presentFilenames
 */
export function checkBatchComplete(manifest, presentFilenames) {
  const present = new Set(presentFilenames);
  const missing = manifest.files.filter((f) => !present.has(f));
  return { complete: missing.length === 0, missing };
}

/** "drop-finances-2026-07-04t2241-a1b2c3" — matches the spec/plan's own
 *  task-name examples exactly: a compact date+hour+minute (no seconds, no
 *  trailing Z) plus the batch_id's random suffix, kebab-case throughout
 *  per this fleet's task-naming convention. */
export function buildDropTaskName(manifest) {
  // batch_id is "<ISO-with-dashes-for-colons>-<6-hex>", e.g.
  // "2026-07-04T22-41-00Z-a1b2c3" — split off the trailing random suffix,
  // then compact the timestamp portion down to YYYY-MM-DDtHHmm.
  const parts = manifest.batch_id.split('-');
  const randomSuffix = parts[parts.length - 1];
  const timestampPart = parts.slice(0, -1).join('-'); // "2026-07-04T22-41-00Z"
  const m = timestampPart.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}Z$/i);
  const compactTimestamp = m ? `${m[1]}t${m[2]}${m[3]}` : timestampPart.toLowerCase();
  const slug = `${compactTimestamp}-${randomSuffix}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `drop-${manifest.agent}-${slug}`;
}

export function buildDropTaskTitle(manifest) {
  return `Process file drop: ${manifest.agent} (${manifest.batch_id}, ${manifest.files.length} files)`;
}
