// MOOT reconciliation pass: reclassify failed_needs_operator rows that died on
// INFRASTRUCTURE (scheduler wedge / transport-exhaustion incl. the pre-66f4abe
// rate-limit mislabel / closeout-expiry stale-claim) — or were superseded — to
// recovery_status='moot' so they surface as moot_or_superseded, OUT of NEEDS-YOU.
// A genuine "agent reported failure" is never mooted. Dry-run by default.
//
//   node scripts/reconcile-moot.mjs           # dry-run
//   node scripts/reconcile-moot.mjs --apply   # write
//
// Shares the pure resolveMoot/resolveSupersession from dist/.

import os from "node:os";
import Database from "better-sqlite3";
import { resolveMoot, resolveSupersession } from "../dist/dispatch-recovery/derived-evidence.js";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.ID_AGENTS_DB || `${os.homedir()}/.id-agents/id-agents.db`;
// 66f4abe fix(scheduler): label transport-exhaustion honestly — 2026-06-17T19:40:45Z.
const TRANSPORT_FIX_CUTOFF_MS = Date.parse("2026-06-17T19:40:45.000Z");

const db = new Database(DB_PATH, { readonly: !APPLY });
const supersession = {
  laterSuccessForTag: (agent, tag, afterMs) => {
    const cand = db
      .prepare(
        `SELECT dispatch_phid, subject FROM dispatch_scheduler_queue
          WHERE to_agent=? AND status='done' AND (updated_at>? OR completed_at>?)
          ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(agent, new Date(afterMs).toISOString(), new Date(afterMs).toISOString());
    const hit = cand.find((c) => (c.subject || "").includes(tag));
    return hit ? hit.dispatch_phid : null;
  },
};

const rows = db
  .prepare(
    `SELECT dispatch_phid, to_agent, subject, body_markdown, started_at, not_before_at,
            failure_kind, failure_detail, updated_at
       FROM dispatch_scheduler_queue
      WHERE status='failed' AND (recovery_status IS NULL OR recovery_status='none')`,
  )
  .all();

let moot = 0;
const byReason = {};
let genuine = 0;
const genuineRows = [];

for (const r of rows) {
  const m = resolveMoot(
    { failure_kind: r.failure_kind, failure_detail: r.failure_detail, updated_at: r.updated_at },
    { transportFixCutoffMs: TRANSPORT_FIX_CUTOFF_MS },
  );
  let reason = m.moot ? m.reason : null;
  if (!reason) {
    const sup = resolveSupersession(
      { dispatch_phid: r.dispatch_phid, to_agent: r.to_agent, subject: r.subject, body_markdown: r.body_markdown, window_start: r.started_at || r.not_before_at || null },
      supersession,
    );
    if (sup.superseded) reason = sup.detail;
  }

  if (reason) {
    moot += 1;
    byReason[shortReason(reason)] = (byReason[shortReason(reason)] || 0) + 1;
    if (APPLY) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE dispatch_scheduler_queue
           SET recovery_status='moot', recovery_reason=COALESCE(recovery_reason, ?), updated_at=?
         WHERE dispatch_phid=? AND status='failed'`,
      ).run(`moot reconcile: ${reason}`, now, r.dispatch_phid);
    }
  } else {
    genuine += 1;
    genuineRows.push(`[${r.to_agent}] ${r.failure_kind} — ${(r.failure_detail || "").slice(0, 50)}`);
  }
}

function shortReason(reason) {
  if (/scheduler wedge/.test(reason)) return "scheduler_wedge";
  if (/transport exhaustion|MISLABELED/.test(reason)) return "transport_exhaustion";
  if (/closeout-expiry/.test(reason)) return "closeout_expiry";
  if (/superseded/.test(reason)) return "superseded";
  return "other";
}

console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — MOOT reconciliation`);
console.log(`failed_needs_operator scanned: ${rows.length}`);
console.log(`MOOT (-> moot_or_superseded, out of NEEDS-YOU): ${moot}`);
console.log(`  by reason: ${JSON.stringify(byReason)}`);
console.log(`GENUINE (still needs Chris): ${genuine}`);
for (const g of genuineRows) console.log(`  ${g}`);
db.close();
