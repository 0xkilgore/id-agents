// SPDX-License-Identifier: MIT
//
// Slice 2 durability regression: synthetic smoke proving the watchdog rolls
// back to the previous manager build instead of leaving the manager down
// when every forward bootstrap attempt fails (2026-07-09 01:50 incident —
// a transient "bootstrap: I/O error" left the manager down for ~13h because
// nothing rolled back). Exercises the real bootstrapForwardWithRollback()
// extracted from runRedeploy(), with retryBootstrap/restorePlist injected so
// no real launchd/git/network I/O runs.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM module (no d.ts); imported for runtime behavior.
import { bootstrapForwardWithRollback } from "../../scripts/deploy-freshness-watchdog.mjs";

describe("bootstrapForwardWithRollback (Slice 2 rollback smoke)", () => {
  it("returns ok without rollback when forward bootstrap succeeds", async () => {
    let restoreCalls = 0;
    const result = await bootstrapForwardWithRollback({
      previousTarget: { workingDirectory: "/prev/repo", programArg1: "/prev/start.sh" },
      previousHealth: { buildSha: "prevsha123" },
      retryBootstrap: async () => ({ ok: true, attempts: 1 }),
      restorePlist: () => { restoreCalls += 1; },
    });

    expect(result).toMatchObject({ ok: true, rolledBack: false });
    expect(restoreCalls).toBe(0);
  });

  it("rolls back to the previous build when forward bootstrap exhausts retries and rollback succeeds", async () => {
    let restoredTarget: unknown = null;
    let bootstrapCall = 0;

    const result = await bootstrapForwardWithRollback({
      previousTarget: { workingDirectory: "/prev/repo", programArg1: "/prev/start.sh" },
      previousHealth: { buildSha: "prevsha123" },
      // 1st call = forward attempt (simulated exhausted retries -> not ok).
      // 2nd call = rollback attempt (simulated success).
      retryBootstrap: async () => {
        bootstrapCall += 1;
        if (bootstrapCall === 1) {
          return { ok: false, attempts: 3, error: new Error("bootstrap: I/O error") };
        }
        return { ok: true, attempts: 1 };
      },
      restorePlist: (target: unknown) => { restoredTarget = target; },
      log: () => {},
    });

    expect(bootstrapCall).toBe(2);
    expect(restoredTarget).toEqual({ workingDirectory: "/prev/repo", programArg1: "/prev/start.sh" });
    expect(result).toMatchObject({
      ok: false,
      rolledBack: true,
      rollbackReason: "bootstrap: I/O error",
      promotedSha: "prevsha123",
    });
    expect(result.closeoutEvidence).toMatchObject({
      buildSha: "prevsha123",
      remoteMainSha: null,
      remoteMainSource: "rollback-after-forward-bootstrap-failure",
    });
  });

  it("reproduces the 2026-07-09 incident: throws (never leaves manager silently down) only when forward AND rollback both exhaust retries", async () => {
    let restoreCalls = 0;

    await expect(
      bootstrapForwardWithRollback({
        previousTarget: { workingDirectory: "/prev/repo", programArg1: "/prev/start.sh" },
        previousHealth: { buildSha: "prevsha123" },
        retryBootstrap: async () => ({ ok: false, attempts: 3, error: new Error("bootstrap: I/O error") }),
        restorePlist: () => { restoreCalls += 1; },
        log: () => {},
      }),
    ).rejects.toThrow(/forward bootstrap failed.*rollback bootstrap also failed/);

    // Rollback was attempted (restorePlist called) even though it ultimately
    // failed too — the caller (runRedeploy) is responsible for the loud
    // escalation artifact/news post on this thrown error.
    expect(restoreCalls).toBe(1);
  });
});
