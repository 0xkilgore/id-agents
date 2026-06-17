// One-time (re-runnable, idempotent) reconcile of failed dispatches against
// landed evidence — the fix for the T1.11/T13.2 defect where failed rows whose
// work LANDED were stuck at effective_state=failed_needs_operator.
//
// Usage (run under the MANAGER node so better-sqlite3 loads):
//   /opt/homebrew/bin/node scripts/reconcile-recovery-evidence.mjs           # dry-run
//   /opt/homebrew/bin/node scripts/reconcile-recovery-evidence.mjs --apply   # write
//
// Dry-run prints before/after effective_state counts + the rows it would
// reconcile. --apply flips landed rows to status=done / recovery_status=
// verified_done (→ effective_state=done_recovered). Requires `npm run build`
// first (imports the compiled matcher + read-model).

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { planReconcile } from "../dist/dispatch-recovery/evidence-reconcile.js";
import { deriveEffectiveState } from "../dist/dispatch-scheduler/read-model.js";

const DB_PATH = process.env.IDAGENTS_DB || "/Users/kilgore/.id-agents/id-agents.db";
const APPLY = process.argv.includes("--apply");

const db = new Database(DB_PATH, { readonly: !APPLY });
db.pragma("busy_timeout = 8000"); // the live manager holds the DB (WAL); wait briefly for the write lock

const rows = db
  .prepare("SELECT * FROM dispatch_scheduler_queue WHERE status = 'failed'")
  .all();

function tally(getState) {
  const counts = {};
  for (const r of rows) {
    const es = getState(r);
    counts[es] = (counts[es] ?? 0) + 1;
  }
  return counts;
}

const before = tally((r) => deriveEffectiveState(r));

const reconciled = [];
for (const r of rows) {
  const plan = planReconcile(
    {
      dispatch_phid: r.dispatch_phid,
      status: r.status,
      failure_kind: r.failure_kind,
      recovery_status: r.recovery_status,
      promotion_result_json: r.promotion_result_json,
      artifact_path: r.artifact_path,
    },
    { fileExists: existsSync },
  );
  if (plan.landed && plan.next_recovery_status) {
    reconciled.push({ phid: r.dispatch_phid, kind: plan.kind, detail: plan.detail });
    // Reflect the change locally so the "after" tally is accurate in dry-run too.
    r.status = "done";
    r.recovery_status = plan.next_recovery_status;
  }
}

if (APPLY && reconciled.length > 0) {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE dispatch_scheduler_queue
       SET status = 'done', recovery_status = ?, recovery_reason = ?,
           completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE dispatch_phid = ? AND status = 'failed'`,
  );
  const tx = db.transaction((items) => {
    for (const it of items) {
      stmt.run("verified_done", `evidence-reconcile: ${it.detail}`, now, now, it.phid);
    }
  });
  tx(reconciled);
}

const after = tally((r) => deriveEffectiveState(r));

const fmt = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `    ${k}: ${v}`)
    .join("\n");

console.log(`\n=== evidence-reconcile (${APPLY ? "APPLY" : "DRY-RUN"}) over ${rows.length} failed rows ===`);
console.log(`reconciled (landed evidence found): ${reconciled.length}`);
for (const r of reconciled.slice(0, 60)) {
  console.log(`  ${r.phid}  [${r.kind}]  ${r.detail}`);
}
console.log(`\neffective_state BEFORE:\n${fmt(before)}`);
console.log(`\neffective_state AFTER:\n${fmt(after)}`);
if (!APPLY) console.log(`\n(dry-run — re-run with --apply to write)`);
db.close();
