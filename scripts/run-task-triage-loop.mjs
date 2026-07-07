#!/usr/bin/env node
// SPDX-License-Identifier: MIT

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (has("--help") || has("-h")) {
  console.log(`Usage:
  node scripts/run-task-triage-loop.mjs [--manager http://127.0.0.1:4100] [--team default] [--daily|--on-demand] [--dry-run]

Runs POST /tasks/triage/run and writes output/YYYY-MM-DD-task-triage-review.md.
Use --daily from cron/launchd/manager schedule; use --on-demand for operator runs.
`);
  process.exit(0);
}

const manager = valueOf("--manager", process.env.MANAGER_URL || "http://127.0.0.1:4100").replace(/\/$/, "");
const team = valueOf("--team", process.env.ID_TEAM || "default");
const dryRun = has("--dry-run");
const mode = has("--daily") ? "daily" : has("--on-demand") ? "on_demand" : "on_demand";
const today = new Date().toISOString().slice(0, 10);
const idempotencyKey = valueOf("--idempotency-key", `task-triage:${team}:${today}:${mode}`);

const response = await fetch(`${manager}/tasks/triage/run`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-id-team": team,
  },
  body: JSON.stringify({
    auto_route: !dryRun,
    mode,
    idempotency_key: idempotencyKey,
  }),
});

const body = await response.json().catch(() => ({}));
if (!response.ok || !body.ok) {
  console.error(JSON.stringify({ ok: false, status: response.status, body }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  mode,
  team,
  artifact_path: body.artifact_path,
  idempotency_key: body.run?.idempotency_key ?? idempotencyKey,
  routed: body.routed?.length ?? 0,
  auto_route_candidates: body.review?.summary?.auto_route_candidates ?? 0,
  approval_review_items: body.review?.summary?.console_lane_items ?? 0,
}, null, 2));
