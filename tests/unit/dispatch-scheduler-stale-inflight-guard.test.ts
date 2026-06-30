import { describe, expect, it } from "vitest";
import {
  classifyInFlightStaleness,
  isBuildPromotionInFlight,
} from "../../src/dispatch-scheduler/stale-inflight-guard.js";
import type { DispatchDoc, Runtime, SchedulerStatus } from "../../src/dispatch-scheduler/types.js";

function doc(overrides: {
  status?: SchedulerStatus;
  started_at?: string | null;
  updated_at?: string;
  agent_query_id?: string | null;
  runtime?: Runtime;
  promote?: boolean;
  promotion_input?: DispatchDoc["promotion_input"];
} = {}): Pick<
  DispatchDoc,
  "status" | "started_at" | "updated_at" | "agent_query_id" | "runtime" | "promote" | "promotion_input"
> {
  return {
    status: overrides.status ?? "in_flight",
    started_at: overrides.started_at ?? "2026-06-29T01:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-06-29T01:00:00.000Z",
    agent_query_id: overrides.agent_query_id ?? "agent-q-stale-guard",
    runtime: overrides.runtime ?? "codex",
    promote: overrides.promote ?? true,
    promotion_input: Object.hasOwn(overrides, "promotion_input")
      ? overrides.promotion_input!
      : {
          repo: "/repo",
          branch: "overnight-guard",
          base: "main",
          remote: "origin",
        },
  };
}

describe("classifyInFlightStaleness", () => {
  const ttlMs = 30 * 60_000;
  const nowMs = Date.parse("2026-06-29T01:35:00.000Z");

  it("classifies an in-flight build/promotion row with no progress evidence as stale", () => {
    const candidate = doc();
    const before = JSON.stringify(candidate);

    const decision = classifyInFlightStaleness({
      doc: candidate,
      evidence: { status: "processing", last_output_at: null },
      now_ms: nowMs,
      ttl_ms: ttlMs,
    });

    expect(decision).toMatchObject({
      kind: "stale",
      inactivity_ms: 35 * 60_000,
      ttl_ms: ttlMs,
      reason: "no_progress_evidence",
    });
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it("classifies recent output as active even when the claim is old", () => {
    const decision = classifyInFlightStaleness({
      doc: doc(),
      evidence: {
        status: "processing",
        last_output_at: Date.parse("2026-06-29T01:34:00.000Z"),
      },
      now_ms: nowMs,
      ttl_ms: ttlMs,
    });

    expect(decision).toMatchObject({
      kind: "active",
      inactivity_ms: 60_000,
      last_activity_source: "last_output_at",
    });
  });

  it("classifies terminal dispatches as terminal, not stale", () => {
    const decision = classifyInFlightStaleness({
      doc: doc({ status: "done" }),
      evidence: { status: "processing", last_output_at: null },
      now_ms: nowMs,
      ttl_ms: ttlMs,
    });

    expect(decision).toEqual({ kind: "terminal", reason: "dispatch_terminal" });
  });

  it("classifies terminal linked queries as terminal, not stale", () => {
    const decision = classifyInFlightStaleness({
      doc: doc(),
      evidence: { status: "completed", last_output_at: null },
      now_ms: nowMs,
      ttl_ms: ttlMs,
    });

    expect(decision).toEqual({ kind: "terminal", reason: "linked_query_terminal" });
  });
});

describe("isBuildPromotionInFlight", () => {
  it("marks only active build promotion rows", () => {
    expect(isBuildPromotionInFlight(doc())).toBe(true);
    expect(isBuildPromotionInFlight(doc({ status: "done" }))).toBe(false);
    expect(isBuildPromotionInFlight(doc({ promote: false }))).toBe(false);
    expect(isBuildPromotionInFlight(doc({ promotion_input: null }))).toBe(false);
  });
});
