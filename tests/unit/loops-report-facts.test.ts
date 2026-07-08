import { describe, expect, it } from "vitest";
import {
  previousDueAt,
  projectReportRunFact,
  reportDefinitionFacts,
} from "../../src/loops/report-facts.js";
import { SEED_LOOPS, type ReportDefinition } from "../../src/loops/registry.js";
import type { ActorRef, LoopRunRecord, LoopRunStatus } from "../../src/loops/types.js";

const NOW = "2026-07-07T21:00:00.000Z";
const ACTOR: ActorRef = { kind: "agent", id: "sentinel" };
const SENTINEL = SEED_LOOPS.find((l) => l.slug === "sentinel-verification-2h")!;
const SENTINEL_2H = SENTINEL.report_definitions.find((d) => d.report_key === "kapelle:sentinel-verification-2h")!;
const WEEKLY = SEED_LOOPS.find((l) => l.slug === "maestra-product-log")!.report_definitions[0]!;
const DISABLED_WEEKLY = SEED_LOOPS.find((l) => l.slug === "weekly-project-report-blowout")!;

function run(over: {
  status?: LoopRunStatus;
  loop_run_phid?: string;
  scheduled_for?: string;
  fired_at?: string;
  finished_at?: string | null;
  output_path?: string | null;
  dispatch_phids?: string[];
  failure_detail?: string | null;
  with_step_evidence?: boolean;
}): LoopRunRecord {
  const fired = over.fired_at ?? over.scheduled_for ?? NOW;
  const key = `scheduled:${over.scheduled_for ?? fired}`;
  return {
    loop_run_phid: over.loop_run_phid ?? "phid:looprun:test",
    loop_phid: SENTINEL.loop_phid,
    trigger: {
      kind: "scheduled",
      recurrence_phid: "phid:recurrence:test",
      recurrence_instance_phid: null,
      scheduled_for: over.scheduled_for ?? fired,
      dedup_key: key,
    },
    status: over.status ?? "succeeded",
    failure_reason: over.status === "failed" ? "collector_failed" : null,
    failure_detail: over.failure_detail ?? null,
    step_log: [
      {
        step_id: "collector",
        phase: "collector",
        name: "collect",
        status: over.status === "failed" ? "failed" : "succeeded",
        started_at: fired,
        finished_at: over.finished_at ?? fired,
        failure_reason: null,
        detail: null,
        evidence_refs: over.with_step_evidence ? [{ kind: "query", ref: "dispatch-ledger" }] : [],
      },
    ],
    output_refs: over.output_path === undefined
      ? []
      : [{
          kind: "markdown_report",
          artifact_phid: "phid:artifact:sentinel",
          path: over.output_path,
          href: null,
          dispatch_phids: over.dispatch_phids ?? [],
          delivery_status: "not_applicable",
          required: true,
        }],
    spawned_dispatch_phids: over.dispatch_phids ?? [],
    idempotency_key: key,
    retry_of_phid: null,
    fired_at: fired,
    queued_at: fired,
    admitted_at: fired,
    started_at: fired,
    finished_at: over.finished_at !== undefined ? over.finished_at : fired,
    created_by: ACTOR,
    updated_at: fired,
  };
}

describe("loop report facts", () => {
  it("registers the Kapelle scheduler report definitions", () => {
    const defs = reportDefinitionFacts();
    expect(defs.map((d) => d.report_key)).toEqual(expect.arrayContaining([
      "kapelle:weekly-project-report",
      "kapelle:biweekly-project-report",
      "kapelle:product-overview-weekly",
      "kapelle:sentinel-verification-2h",
      "kapelle:sentinel-weekly",
      "kapelle:sentinel-biweekly",
      "kapelle:ux-research-weekly",
      "kapelle:library-research-biweekly",
      "kapelle:surface-feeder-6h",
      "kapelle:task-reconciliation-6h",
    ]));
  });

  it("computes previous weekly and interval due instants", () => {
    expect(previousDueAt(WEEKLY, NOW)).toBe("2026-07-05T16:00:00.000Z");
    expect(previousDueAt(SENTINEL_2H, NOW)).toBe("2026-07-07T20:00:00.000Z");
  });

  it("aligns biweekly due instants to the declared UTC time", () => {
    const biweekly: ReportDefinition = {
      report_key: "kapelle:test-biweekly",
      label: "Test Biweekly",
      cadence: {
        kind: "biweekly",
        anchor_due_at: "2026-07-01T00:00:00.000Z",
        hour_utc: 14,
        minute_utc: 30,
      },
      enabled: true,
      grace_minutes: 60,
      stale_after_minutes: 24 * 60,
      artifact_required: true,
    };

    expect(previousDueAt(biweekly, "2026-07-07T21:00:00.000Z")).toBe("2026-07-01T14:30:00.000Z");
    expect(previousDueAt(biweekly, "2026-07-15T15:00:00.000Z")).toBe("2026-07-15T14:30:00.000Z");
  });

  it("marks a proof-backed scheduled run as done", () => {
    const expectedFor = previousDueAt(SENTINEL_2H, NOW);
    const fact = projectReportRunFact(SENTINEL, SENTINEL_2H, [
      run({ scheduled_for: expectedFor, output_path: "/output/sentinel.md", dispatch_phids: ["phid:disp-1"] }),
    ], NOW);

    expect(fact.status).toBe("done");
    expect(fact.owner_agent).toBe("sentinel");
    expect(fact.cadence).toMatchObject({ kind: "interval_hours", every_hours: 2 });
    expect(fact.freshness).toBe("fresh");
    expect(fact.reason).toBe("artifact_or_ref_proof_present");
    expect(fact.artifact_link).toBe("/output/sentinel.md");
    expect(fact.closeout_required).toBe(true);
    expect(fact.closeout_requirement).toBe("artifact_or_ref_proof");
    expect(fact.artifact_refs.map((r) => r.ref)).toContain("/output/sentinel.md");
    expect(fact.ref_proof.map((r) => r.ref)).toContain("phid:disp-1");
  });

  it("marks a completed run without artifact/ref proof as failed", () => {
    const expectedFor = previousDueAt(SENTINEL_2H, NOW);
    const fact = projectReportRunFact(SENTINEL, SENTINEL_2H, [
      run({ scheduled_for: expectedFor }),
    ], NOW);

    expect(fact.status).toBe("failed");
    expect(fact.reason).toBe("artifact_or_ref_proof_missing");
  });

  it("marks missing overdue work as late and owed now", () => {
    const fact = projectReportRunFact(SENTINEL, SENTINEL_2H, [], NOW);
    expect(fact.status).toBe("late");
    expect(fact.freshness).toBe("due");
    expect(fact.artifact_link).toBeNull();
    expect(fact.reason).toBe("no_run_recorded_past_grace_window");
  });

  it("marks a report still inside its grace window as expected", () => {
    const fact = projectReportRunFact(SENTINEL, SENTINEL_2H, [], "2026-07-07T20:10:00.000Z");
    expect(fact.status).toBe("expected");
    expect(fact.freshness).toBe("due");
    expect(fact.reason).toBe("due_window_open");
    expect(fact.owner_agent).toBe("sentinel");
    expect(fact.closeout_required).toBe(true);
  });

  it("marks disabled report definitions as skipped with a reason", () => {
    const fact = projectReportRunFact(DISABLED_WEEKLY, DISABLED_WEEKLY.report_definitions[0]!, [], NOW);
    expect(fact.status).toBe("skipped");
    expect(fact.reason).toBe("loop_disabled");
  });
});
