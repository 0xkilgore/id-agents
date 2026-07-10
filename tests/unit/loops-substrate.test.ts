// B1 (2026-06-22) — loops-scheduler substrate: storage (seed, recurrence link,
// LoopRun idempotency, active-run cap, evidence transitions) + manual-trigger
// admission (reject gates, idempotency-key synthesis, run envelope build).

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  migrateLoopsTables,
  seedLoopsFromRegistry,
  getLoop,
  bindLoopRecurrence,
  createLoopRun,
  getLoopRun,
  listLoopRuns,
  countActiveRuns,
  transitionLoopRun,
  loopRunPhid,
} from "../../src/loops/storage.js";
import {
  buildManualRun,
  evaluateManualTrigger,
  isMalformedLoopRef,
  manualRejectHttpStatus,
  normalizeActor,
  synthesizeIdempotencyKey,
} from "../../src/loops/manual-trigger.js";
import {
  buildPromotionHygieneRun,
  classifyPromotionHygieneFailure,
  classifyStaleBaseAdmission,
  hygieneDedupeKey,
  hygieneTaskName,
  shouldEmitNeedsOperatorInput,
} from "../../src/loops/worktree-hygiene.js";
import type { LoopRecord } from "../../src/loops/types.js";

let adapter: SqliteAdapter;
const NOW = "2026-06-22T18:30:00.000Z";

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateLoopsTables(adapter);
  await seedLoopsFromRegistry(adapter, NOW);
});

async function projectLoad(): Promise<LoopRecord> {
  const loop = await getLoop(adapter, "project-load");
  if (!loop) throw new Error("seed missing project-load");
  return loop;
}

describe("loops storage — seed + resolve", () => {
  it("seeds the 8 registry loops; resolves by slug and phid", async () => {
    const bySlug = await getLoop(adapter, "morning-digest");
    const byPhid = await getLoop(adapter, "phid:loop:morning-digest");
    expect(bySlug?.loop_phid).toBe("phid:loop:morning-digest");
    expect(byPhid?.slug).toBe("morning-digest");
    expect(await getLoop(adapter, "not-a-loop")).toBeNull();
  });

  it("re-seed is idempotent and preserves a recurrence binding", async () => {
    await bindLoopRecurrence(adapter, "phid:loop:project-load", "phid:recurrence-abc", NOW);
    await seedLoopsFromRegistry(adapter, "2026-06-23T00:00:00.000Z"); // re-seed
    const loop = await projectLoad();
    expect(loop.schedule.recurrence_phid).toBe("phid:recurrence-abc"); // binding survived
  });
});

describe("recurrence link", () => {
  it("binds and unbinds a loop to a recurrence template", async () => {
    const bound = await bindLoopRecurrence(adapter, "phid:loop:project-load", "phid:recurrence-xyz", NOW, {
      timezone: "America/New_York",
    });
    expect(bound?.schedule.recurrence_phid).toBe("phid:recurrence-xyz");
    expect(bound?.schedule.enabled).toBe(true);

    const unbound = await bindLoopRecurrence(adapter, "phid:loop:project-load", null, NOW);
    expect(unbound?.schedule.recurrence_phid).toBeNull();
    expect(unbound?.schedule.enabled).toBe(false);

    expect(await bindLoopRecurrence(adapter, "phid:loop:nope", "phid:recurrence-1", NOW)).toBeNull();
  });
});

describe("LoopRun evidence contract — idempotency, cap, transitions", () => {
  it("createLoopRun is idempotent on (loop_phid, idempotency_key)", async () => {
    const loop = await projectLoad();
    const { run } = buildManualRun(loop, { idempotency_key: "k1" }, NOW);

    const first = await createLoopRun(adapter, run);
    expect(first.created).toBe(true);

    const second = await createLoopRun(adapter, run);
    expect(second.created).toBe(false);
    expect(second.run.loop_run_phid).toBe(first.run.loop_run_phid); // same envelope

    const all = await listLoopRuns(adapter, loop.loop_phid, {});
    expect(all).toHaveLength(1);
  });

  it("records the admission evidence step on the run", async () => {
    const loop = await projectLoad();
    const { run } = buildManualRun(loop, { idempotency_key: "k2", actor: { type: "human", id: "chris" } }, NOW);
    await createLoopRun(adapter, run);
    const stored = await getLoopRun(adapter, run.loop_run_phid);
    expect(stored?.status).toBe("queued");
    expect(stored?.step_log).toHaveLength(1);
    expect(stored?.step_log[0].phase).toBe("admission");
    expect(stored?.step_log[0].evidence_refs[0].kind).toBe("trigger");
    expect(stored?.created_by.id).toBe("chris");
  });

  it("counts active runs and advances state + appends evidence via transition", async () => {
    const loop = await projectLoad();
    const { run } = buildManualRun(loop, { idempotency_key: "k3" }, NOW);
    await createLoopRun(adapter, run);
    expect(await countActiveRuns(adapter, loop.loop_phid)).toBe(1); // queued is active

    const advanced = await transitionLoopRun(
      adapter,
      run.loop_run_phid,
      {
        status: "succeeded",
        admitted_at: NOW,
        finished_at: NOW,
        append_steps: [
          {
            step_id: "rollup", phase: "rollup", name: "done", status: "succeeded",
            started_at: NOW, finished_at: NOW, failure_reason: null, detail: null, evidence_refs: [],
          },
        ],
        append_outputs: [
          { kind: "markdown_report", artifact_phid: null, path: "/out/x.md", href: null, dispatch_phids: [], delivery_status: "not_applicable", required: true },
        ],
      },
      NOW,
    );
    expect(advanced?.status).toBe("succeeded");
    expect(advanced?.step_log).toHaveLength(2);
    expect(advanced?.output_refs).toHaveLength(1);
    expect(await countActiveRuns(adapter, loop.loop_phid)).toBe(0); // succeeded is terminal
  });

  it("records promotion hygiene trigger context and dedupes by repo:branch:incident_code", async () => {
    const loop = await getLoop(adapter, "worktree-hygiene");
    if (!loop) throw new Error("seed missing worktree-hygiene");
    const incident = classifyPromotionHygieneFailure({
      repo: "/repo/app",
      branch: "feature/a",
      dispatch_id: "phid:disp-1",
      text: "branch feature/a has diverged from main (ahead=2, behind=3)",
    });
    expect(incident?.incident_code).toBe("ahead_behind_divergence");

    const run = buildPromotionHygieneRun(loop, incident!, NOW);
    expect(run.trigger).toMatchObject({
      kind: "promotion_hygiene",
      repo: "/repo/app",
      branch: "feature/a",
      incident_code: "ahead_behind_divergence",
      linked_dispatch: "phid:disp-1",
      action: "create_fresh_branch_from_base",
    });
    expect(run.idempotency_key).toBe("promotion-hygiene:/repo/app:feature/a:ahead_behind_divergence");

    const first = await createLoopRun(adapter, run);
    const second = await createLoopRun(adapter, run);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await listLoopRuns(adapter, loop.loop_phid, {})).toHaveLength(1);
  });
});

describe("manual-trigger admission (pure)", () => {
  it("evaluates reject gates", async () => {
    const projectLoadLoop = await projectLoad(); // enabled + allow_manual_run
    expect(evaluateManualTrigger(projectLoadLoop)).toBeNull();

    const disabled = await getLoop(adapter, "fantasy-baseball"); // enabled=false in seed
    expect(evaluateManualTrigger(disabled!)).toBe("loop_disabled");

    const manualOff: LoopRecord = { ...(await projectLoad()), enabled: true, allow_manual_run: false };
    expect(evaluateManualTrigger(manualOff)).toBe("manual_run_not_allowed");

    expect(manualRejectHttpStatus("loop_disabled")).toBe(409);
    expect(manualRejectHttpStatus("manual_run_not_allowed")).toBe(409);
    expect(manualRejectHttpStatus("loop_not_found")).toBe(404);
    expect(manualRejectHttpStatus("invalid_loop_identifier")).toBe(400);
  });

  it("flags malformed refs", () => {
    expect(isMalformedLoopRef("")).toBe(true);
    expect(isMalformedLoopRef("3")).toBe(true);
    expect(isMalformedLoopRef("project-load")).toBe(false);
    expect(isMalformedLoopRef("phid:loop:project-load")).toBe(false);
  });

  it("normalizes actor and synthesizes a minute-floored idempotency key", () => {
    expect(normalizeActor({ type: "human", id: "chris" }).kind).toBe("user");
    expect(normalizeActor({ kind: "agent", id: "maestra" }).kind).toBe("agent");
    expect(normalizeActor(null).id).toBe("operator");
    const key = synthesizeIdempotencyKey("phid:loop:project-load", normalizeActor({ id: "chris" }), "dashboard", NOW);
    expect(key).toBe("manual:phid:loop:project-load:chris:dashboard:2026-06-22T18:30");
  });

  it("buildManualRun derives a deterministic run phid from the idempotency key", async () => {
    const loop = await projectLoad();
    const { run, idempotency_key } = buildManualRun(loop, { idempotency_key: "kX" }, NOW);
    expect(run.loop_run_phid).toBe(loopRunPhid(loop.loop_phid, "kX"));
    expect(idempotency_key).toBe("kX");
    expect(run.status).toBe("queued");
  });
});

describe("worktree hygiene classification", () => {
  it("classifies dirty primary checkout and chooses inventory preservation", () => {
    const incident = classifyPromotionHygieneFailure({
      repo: "/repo/app",
      branch: "main",
      text: "Promotion failed: dirty primary checkout has uncommitted changes",
    });
    expect(incident).toMatchObject({
      incident_code: "dirty_primary_checkout",
      action: "inventory_and_preserve_dirty_paths",
    });
  });

  it("classifies unlinked branch and derives a stable hygiene task name", () => {
    const incident = classifyPromotionHygieneFailure({
      repo: "/repo/app",
      branch: "feature/no-ticket",
      text: "feature branch with no linked dispatch/RD/task",
    });
    expect(incident).toMatchObject({
      incident_code: "unlinked_branch",
      action: "link_or_retire_branch",
    });
    expect(hygieneDedupeKey(incident!)).toBe("/repo/app:feature/no-ticket:unlinked_branch");
    expect(hygieneTaskName(incident!)).toBe("worktree-hygiene-app-feature-no-ticket-unlinked-branch");
  });

  it("classifies ahead+behind divergence as fresh-branch work", () => {
    const incident = classifyPromotionHygieneFailure({
      repo: "/repo/app",
      branch: "feature/diverged",
      text: "branch feature/diverged has diverged from main (ahead=1, behind=2)",
    });
    expect(incident).toMatchObject({
      incident_code: "ahead_behind_divergence",
      action: "create_fresh_branch_from_base",
    });
  });

  it("flags stale-base admission before agent work with fresh-branch-off-origin-main remediation", () => {
    const incident = classifyStaleBaseAdmission({
      repo: "/repo/id-agents",
      branch: "async-first-dispatch-path",
      base_ref: "origin/main",
      behind: 25,
      threshold: 20,
      linked_dispatch: "phid:disp-stale",
    });

    expect(incident).toMatchObject({
      incident_code: "stale_base",
      action: "create_fresh_branch_from_base",
      linked_dispatch: "phid:disp-stale",
    });
    expect(incident?.detail).toContain("25 commits behind origin/main");
    expect(incident?.detail).toContain("fresh-branch-off-origin-main");
    expect(hygieneDedupeKey(incident!)).toBe("/repo/id-agents:async-first-dispatch-path:stale_base");
  });

  it("does not flag branches at the stale-base threshold", () => {
    expect(classifyStaleBaseAdmission({
      repo: "/repo/id-agents",
      branch: "fresh-enough",
      base_ref: "origin/main",
      behind: 20,
      threshold: 20,
    })).toBeNull();
  });

  it("only emits needs_operator_input for concrete unresolved choices with a recommendation", () => {
    expect(shouldEmitNeedsOperatorInput({
      unresolved_choice: true,
      question: "Preserve or abandon branch?",
      options: ["preserve", "abandon"],
      recommended_option: "preserve",
    })).toMatchObject({ emit: true, recommended_option: "preserve" });

    expect(shouldEmitNeedsOperatorInput({
      unresolved_choice: true,
      question: "Preserve or abandon branch?",
      options: ["preserve", "abandon"],
    }).emit).toBe(false);
  });
});
