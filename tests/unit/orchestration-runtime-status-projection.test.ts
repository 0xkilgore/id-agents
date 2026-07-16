import { describe, expect, it } from "vitest";

import {
  buildRuntimeStatusProjection,
  type RuntimeHealthSource,
} from "../../src/continuous-orchestration/routes.js";
import type {
  AutoPromoteHealth,
  ReadyAdmissionExplanation,
} from "../../src/continuous-orchestration/daemon.js";

function autoPromoteHealth(): AutoPromoteHealth {
  return {
    lanes: { capacity_occupied: false },
    summary: "auto-promote healthy",
  } as AutoPromoteHealth;
}

function readyAdmission(overrides: Partial<ReadyAdmissionExplanation> = {}): ReadyAdmissionExplanation {
  return {
    candidates: 3,
    useful_ready: 3,
    admissible_now: 1,
    blocker_counts: [],
    recommended_action: "admit available ready rows",
    disk_headroom: null,
    ...overrides,
  } as ReadyAdmissionExplanation;
}

function runtimeHealth(state: "critical" | "warn" | "ok"): RuntimeHealthSource {
  return { disk: { state } };
}

describe("buildRuntimeStatusProjection disk admission policy", () => {
  it("critical disk clearly pauses ordinary build rows and admits only cleanup/repair", () => {
    const projection = buildRuntimeStatusProjection({
      runtimeHealth: runtimeHealth("critical"),
      autoPromoteHealth: autoPromoteHealth(),
      readyAdmission: readyAdmission({
        admissible_now: 1,
        blocker_counts: [
          { code: "disk_critical_floor", category: "infra_resource", count: 2 },
        ],
      }),
    });

    expect(projection.disk_critical).toBe(true);
    expect(projection.disk_admission).toEqual({
      state: "critical",
      ordinary_builds_paused: true,
      admitted_work: ["disk cleanup", "disk repair"],
      held_ready_rows: 2,
      reason: expect.stringContaining("ordinary build rows are paused"),
    });
    expect(projection.operator_summary).toContain("disk-critical admission guard active");
    expect(projection.operator_summary).toContain("only disk cleanup/repair rows may be admitted");
    expect(projection.recommended_actions[0]).toContain("admit only disk cleanup/repair rows");
  });

  it("warning disk explains cleanup/repair and deploy-safe preference without pausing ordinary builds globally", () => {
    const projection = buildRuntimeStatusProjection({
      runtimeHealth: runtimeHealth("warn"),
      autoPromoteHealth: autoPromoteHealth(),
      readyAdmission: readyAdmission({
        admissible_now: 2,
        blocker_counts: [
          { code: "disk_warning_floor", category: "infra_resource", count: 1 },
        ],
      }),
    });

    expect(projection.disk_critical).toBe(false);
    expect(projection.disk_admission).toEqual({
      state: "warn",
      ordinary_builds_paused: false,
      admitted_work: ["disk cleanup", "disk repair", "deploy-safe"],
      held_ready_rows: 1,
      reason: expect.stringContaining("below the warning floor"),
    });
    expect(projection.recommended_actions[0]).toContain("prefer disk cleanup/repair or deploy-safe rows");
  });

  it("ok disk reports ordinary build admission as available and no disk-held rows", () => {
    const projection = buildRuntimeStatusProjection({
      runtimeHealth: runtimeHealth("ok"),
      autoPromoteHealth: autoPromoteHealth(),
      readyAdmission: readyAdmission(),
    });

    expect(projection.disk_critical).toBe(false);
    expect(projection.disk_admission).toEqual({
      state: "ok",
      ordinary_builds_paused: false,
      admitted_work: ["ordinary build", "disk cleanup", "disk repair", "deploy-safe"],
      held_ready_rows: 0,
      reason: null,
    });
    expect(projection.operator_summary).toContain("ready=3 admissible=1");
    expect(projection.recommended_actions).toEqual(["admit currently admissible ready rows"]);
  });
});
