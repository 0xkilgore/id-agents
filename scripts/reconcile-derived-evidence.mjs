// One-time + repeatable reconciliation pass: clear FALSE failed_needs_operator
// rows whose work demonstrably LANDED, by deriving the expected deliverable from
// the dispatch (named artifact path / track-tag commit) and verifying it against
// disk/git. Dry-run by default; pass --apply to write.
//
//   node scripts/reconcile-derived-evidence.mjs            # dry-run, prints plan
//   node scripts/reconcile-derived-evidence.mjs --apply    # reclassify landed rows
//
// Uses the compiled pure resolver (dist/) so the pass and the live reconciler
// share one decision function. Conservative: only positive evidence reclassifies.

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { resolveDerivedLanded, resolveSupersession } from "../dist/dispatch-recovery/derived-evidence.js";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.ID_AGENTS_DB || `${os.homedir()}/.id-agents/id-agents.db`;

const AGENT_REPOS = {
  roger: { path: `${os.homedir()}/Dropbox/Code/cane/id-agents`, base: "main" },
  regina: { path: `${os.homedir()}/Dropbox/Code/kapelle-site`, base: "main" },
};

const probes = {
  fileMtimeMs: (p) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
  commitInWindow: (repo, sinceMs, untilMs) => {
    try {
      const out = execFileSync(
        "git",
        [
          "-C", repo.path, "log", `origin/${repo.base}`,
          "--since", new Date(sinceMs).toISOString(),
          "--until", new Date(untilMs).toISOString(),
          "--format=%h", "-n", "1",
        ],
        { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  },
};

const db = new Database(DB_PATH, { readonly: !APPLY });
const rows = db
  .prepare(
    `SELECT dispatch_phid, to_agent, subject, body_markdown, started_at, not_before_at, failure_kind, failure_detail
       FROM dispatch_scheduler_queue
      WHERE status='failed' AND (recovery_status IS NULL OR recovery_status='none')`,
  )
  .all();

// A later same-agent same-tag dispatch that reached a terminal success.
const supersession = {
  laterSuccessForTag: (agent, tag, afterMs) => {
    const cand = db
      .prepare(
        `SELECT dispatch_phid, subject FROM dispatch_scheduler_queue
          WHERE to_agent=? AND status='done'
            AND (updated_at > ? OR completed_at > ?)
          ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(agent, new Date(afterMs).toISOString(), new Date(afterMs).toISOString());
    const hit = cand.find((c) => (c.subject || "").includes(tag));
    return hit ? hit.dispatch_phid : null;
  },
};

let landed = 0;
const byKind = { artifact_present: 0, commit_on_base: 0, superseded: 0 };
const reclassified = [];

for (const r of rows) {
  const drow = {
    dispatch_phid: r.dispatch_phid,
    to_agent: r.to_agent,
    subject: r.subject,
    body_markdown: r.body_markdown,
    window_start: r.started_at || r.not_before_at || null,
  };
  let kind = null;
  let detail = null;
  let recoveryStatus = null;

  const ev = resolveDerivedLanded(drow, probes, AGENT_REPOS);
  if (ev.landed) {
    kind = ev.kind;
    detail = ev.detail;
    recoveryStatus = ev.kind === "commit_on_base" ? "verified_done" : "landed_reconciled";
  } else {
    const sup = resolveSupersession(drow, supersession);
    if (sup.superseded) {
      kind = "superseded";
      detail = sup.detail;
      recoveryStatus = "landed_reconciled";
    }
  }

  if (kind) {
    landed += 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    reclassified.push({ phid: r.dispatch_phid, agent: r.to_agent, kind, detail });
    if (APPLY) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE dispatch_scheduler_queue
           SET status='done', recovery_status=?, recovery_reason=COALESCE(recovery_reason, ?),
               completed_at=COALESCE(completed_at, ?), updated_at=?
         WHERE dispatch_phid=? AND status='failed'`,
      ).run(recoveryStatus, `derived-evidence reconcile: ${detail}`, now, now, r.dispatch_phid);
    }
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — derived-evidence reconciliation`);
console.log(`failed rows scanned: ${rows.length}`);
console.log(
  `LANDED (reclassify -> done_recovered): ${landed}  (artifact=${byKind.artifact_present}, commit=${byKind.commit_on_base}, superseded=${byKind.superseded})`,
);
console.log(`REMAIN failed_needs_operator (genuinely need Chris): ${rows.length - landed}`);
console.log("\nReclassified rows:");
for (const x of reclassified) console.log(`  [${x.agent}] ${x.kind} — ${x.detail}`);
db.close();
