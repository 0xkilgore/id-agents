// OP-7 usage-gating — queue-release decision (pure).
//
// CTO-3 scope: cto/output/2026-06-10-op7-usage-gating-architecture-scope.md
//
// admitDispatch() (admission.ts) decides whether a dispatch may START and,
// when capacity is short, emits a QUEUED gate. evaluateQueueRelease() is the
// other half: it re-evaluates a previously-queued gate against the agent's
// CURRENT state and decides what the queue-release loop should do with it:
//
//   - "release" — capacity is now free (or an operator override applies) so
//     the dispatch may start. The gate transitions queued → released with
//     released_at stamped. Its identity (gate PHID, dispatch PHID) and queue
//     age (created_at) are preserved across the transition.
//   - "hold"    — still capacity-limited. The gate stays queued, with its
//     reason/metadata refreshed to the current limiting condition, but its
//     created_at is preserved so the loop can age it out.
//   - "block"   — a budget exhaustion or hard pause emerged WHILE the
//     dispatch sat in the queue. It must not silently release into delivery;
//     the gate transitions queued → blocked.
//
// The decision reflects the TRUE capacity intent regardless of warn/enforce.
// In warn mode admitDispatch downgrades a would-be block/queue to delivering
// with a shadow gate; evaluateQueueRelease inspects that shadow gate's state
// (not the downgraded status) so a still-capped dispatch is not spuriously
// "released" by the warn-mode downgrade. Acting on the decision (and whether
// warn mode actually starts a released dispatch) is the loop's job, deferred.
//
// Pure and deterministic: no clock, no random. The release timestamp is
// taken from input.now_iso.

import { admitDispatch, type AdmissionInput, type AdmissionResult, type DispatchGate } from "./admission.js";

export type ReleaseAction = "release" | "hold" | "block";

export interface ReleaseDecision {
  action: ReleaseAction;
  /** The gate after the transition (released / refreshed-queued / blocked). */
  gate: DispatchGate;
  /** The admission result that drove the decision (for telemetry). */
  admission: AdmissionResult;
}

/**
 * Re-evaluate a previously-queued dispatch gate against current state.
 *
 * @param queuedGate a gate currently in gate_state "queued"
 * @param input the agent's CURRENT admission inputs (now_iso = evaluation time)
 * @throws if `queuedGate` is not in gate_state "queued"
 */
export function evaluateQueueRelease(
  queuedGate: DispatchGate,
  input: AdmissionInput,
): ReleaseDecision {
  if (queuedGate.gate_state !== "queued") {
    throw new Error(
      `evaluateQueueRelease: gate is not queued (state=${queuedGate.gate_state})`,
    );
  }

  const admission = admitDispatch(input);
  const g = admission.gate;

  // Clean admit (no gate) or a valid override → release. The released gate
  // is the SAME gate transitioning state, so we preserve its identity and
  // queue age and stamp released_at rather than minting a fresh gate.
  if (g === null || g.gate_state === "overridden") {
    return {
      action: "release",
      admission,
      gate: {
        ...queuedGate,
        gate_state: "released",
        released_at: input.now_iso,
        gate_metadata: {
          ...queuedGate.gate_metadata,
          release_reason: g?.gate_state === "overridden" ? "overridden" : "now_admissible",
        },
      },
    };
  }

  // Still capacity-limited → hold. Refresh reason/metadata to the current
  // limiting condition but preserve the original queue age (created_at) so
  // the loop ages the gate from when it FIRST queued, not from now.
  if (g.gate_state === "queued") {
    return {
      action: "hold",
      admission,
      gate: { ...g, created_at: queuedGate.created_at },
    };
  }

  // Budget exhaustion or a hard pause emerged while queued → block. Preserve
  // the original queue age for the same reason.
  return {
    action: "block",
    admission,
    gate: { ...g, created_at: queuedGate.created_at },
  };
}
