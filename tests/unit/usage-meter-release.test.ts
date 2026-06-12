// OP-7 usage-gating — queue-release decision tests.
//
// CTO-3 scope: cto/output/2026-06-10-op7-usage-gating-architecture-scope.md
//
// evaluateQueueRelease() is the pure heart of the OP-7 queue-release loop.
// Given a dispatch that was previously QUEUED for capacity and the agent's
// CURRENT budget/usage/concurrency/spacing state, it decides whether the
// gate may now RELEASE (capacity is free → dispatch may start), must still
// HOLD (still capacity-limited), or must BLOCK (a budget/pause condition
// emerged while it sat in the queue, so it must not silently release into
// delivery).
//
// Like admitDispatch() it is pure and deterministic (no clock/random) and
// reports the true capacity intent regardless of warn/enforce — the
// loop wiring (deferred) decides whether to act on the decision.

import { describe, expect, it } from "vitest";

import {
  admitDispatch,
  type AdmissionInput,
  type DispatchGate,
} from "../../src/usage-meter/admission.js";
import { evaluateQueueRelease } from "../../src/usage-meter/release.js";

const QUEUED_AT = "2026-06-11T16:59:00.000Z";
const NOW = "2026-06-11T17:00:00.000Z";

function baseInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    dispatch_phid: "phid:disp-abc123",
    agent_id: "vetra",
    provider: "anthropic",
    enforcement: "enforce",
    now_iso: NOW,
    budget: { daily_limit: 1_000_000, weekly_limit: 5_000_000 },
    usage: { daily_used: 0, weekly_used: 0 },
    agent_concurrency: { current: 0 },
    provider_concurrency: { current: 0 },
    spacing: { last_dispatched_at: null },
    ...overrides,
  };
}

/** Build a real queued gate by admitting an over-capacity dispatch, then
 *  back-date its created_at to QUEUED_AT (it sat in the queue a while). */
function queuedGate(overrides: Partial<AdmissionInput> = {}): DispatchGate {
  const r = admitDispatch(
    baseInput({ agent_concurrency: { current: 1, max: 1 }, ...overrides }),
  );
  if (!r.gate || r.gate.gate_state !== "queued") {
    throw new Error("test setup: expected a queued gate");
  }
  return { ...r.gate, created_at: QUEUED_AT };
}

describe("evaluateQueueRelease — release", () => {
  it("capacity now free → action release, gate state released, released_at = now, queue age preserved", () => {
    const gate = queuedGate();
    // Current state: the agent is now idle.
    const d = evaluateQueueRelease(gate, baseInput({ agent_concurrency: { current: 0 } }));
    expect(d.action).toBe("release");
    expect(d.gate.gate_state).toBe("released");
    expect(d.gate.released_at).toBe(NOW);
    // Identity + queue age preserved across the transition.
    expect(d.gate.dispatch_gate_phid).toBe(gate.dispatch_gate_phid);
    expect(d.gate.dispatch_phid).toBe("phid:disp-abc123");
    expect(d.gate.created_at).toBe(QUEUED_AT);
  });

  it("a valid operator override on a queued gate → release", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({
        agent_concurrency: { current: 1, max: 1 },
        override: { force_dispatch: true, reason: "operator pulled it forward", actor: "chris" },
      }),
    );
    expect(d.action).toBe("release");
    expect(d.gate.gate_state).toBe("released");
    expect(d.gate.released_at).toBe(NOW);
  });
});

describe("evaluateQueueRelease — hold", () => {
  it("still at concurrency cap → action hold, stays queued, queue age preserved", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(gate, baseInput({ agent_concurrency: { current: 1, max: 1 } }));
    expect(d.action).toBe("hold");
    expect(d.gate.gate_state).toBe("queued");
    expect(d.gate.gate_reason).toBe("over_concurrency");
    expect(d.gate.released_at).toBeNull();
    // Queue age is preserved (not reset to now) so the loop can age out.
    expect(d.gate.created_at).toBe(QUEUED_AT);
  });

  it("refreshes the reason when the limiting condition changed (agent free but provider full)", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({ agent_concurrency: { current: 0 }, provider_concurrency: { current: 3, max: 3 } }),
    );
    expect(d.action).toBe("hold");
    expect(d.gate.gate_reason).toBe("provider_capacity_full");
  });
});

describe("evaluateQueueRelease — block", () => {
  it("budget exhausted while queued → action block, gate state blocked, NOT released", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({
        agent_concurrency: { current: 0 },
        usage: { daily_used: 1_000_000, weekly_used: 0 },
      }),
    );
    expect(d.action).toBe("block");
    expect(d.gate.gate_state).toBe("blocked");
    expect(d.gate.gate_reason).toBe("budget_exhausted");
    expect(d.gate.released_at).toBeNull();
    expect(d.gate.created_at).toBe(QUEUED_AT);
  });

  it("provider hard-paused while queued → action block, reason provider_paused", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({ agent_concurrency: { current: 0 }, provider_paused: true }),
    );
    expect(d.action).toBe("block");
    expect(d.gate.gate_reason).toBe("provider_paused");
  });
});

describe("evaluateQueueRelease — warn mode reflects true capacity intent", () => {
  it("warn enforcement: still-capped dispatch holds (not spuriously released by warn downgrade)", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({ enforcement: "warn", agent_concurrency: { current: 1, max: 1 } }),
    );
    expect(d.action).toBe("hold");
    expect(d.gate.gate_state).toBe("queued");
  });

  it("warn enforcement: freed dispatch releases", () => {
    const gate = queuedGate();
    const d = evaluateQueueRelease(
      gate,
      baseInput({ enforcement: "warn", agent_concurrency: { current: 0 } }),
    );
    expect(d.action).toBe("release");
  });
});

describe("evaluateQueueRelease — guards", () => {
  it("throws when handed a gate that is not queued", () => {
    const gate = queuedGate();
    const blocked: DispatchGate = { ...gate, gate_state: "blocked" };
    expect(() => evaluateQueueRelease(blocked, baseInput())).toThrow(/not queued/i);
  });
});
