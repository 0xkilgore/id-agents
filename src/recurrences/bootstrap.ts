// Manager-side bootstrap for the RecurrenceTemplate materialization
// service.
//
// Run on:
//   - manager startup/recovery (`runMaterializationTickOnce`)
//   - periodic tick (`startMaterializationTicker`, default 15 min per CTO scope)
//   - operator create/update (caller hooks into the typed-op handler)
//   - explicit "materialize early" command (call `runMaterializationTickOnce`)
//
// The bootstrap loads the in-memory state from sqlite, plans the
// next-horizon materializations via the pure planner, applies each
// op through the reducer, and persists the resulting rows. Errors
// inside a single template are isolated so a misconfigured template
// can't wedge the whole tick.

import type { DbAdapter } from "../db/db-adapter.js";
import { applyOp } from "./reducer.js";
import { planMaterializations } from "./materialization.js";
import {
  listInstancesForTemplate,
  listTemplates,
  upsertInstance,
} from "./storage.js";
import {
  ALWAYS_ALLOW_GATING,
  emptyState,
  type GatingProbe,
  type RecurrenceState,
} from "./types.js";

export interface MaterializationTickArgs {
  adapter: DbAdapter;
  now?: string;
  gating?: GatingProbe;
}

export interface MaterializationTickResult {
  templates_considered: number;
  instances_created: number;
  instances_planned_gated: number;
  errors: Array<{ recurrence_phid: string; error: string }>;
}

/**
 * Single tick: load active state, plan, apply, persist.
 * Returns a summary the caller can log / surface in `/ops`.
 */
export async function runMaterializationTickOnce(
  args: MaterializationTickArgs,
): Promise<MaterializationTickResult> {
  const now = args.now ?? new Date().toISOString();
  const gating = args.gating ?? ALWAYS_ALLOW_GATING;
  const errors: MaterializationTickResult["errors"] = [];

  const state = await loadActiveState(args.adapter);
  let ops;
  try {
    ops = await planMaterializations({ state, now, gating });
  } catch (err) {
    return {
      templates_considered: state.templates.size,
      instances_created: 0,
      instances_planned_gated: 0,
      errors: [{ recurrence_phid: "(planner)", error: String(err) }],
    };
  }

  let materialized = 0;
  let planned = 0;
  let cursor = state;
  for (const op of ops) {
    try {
      const result = applyOp(cursor, op);
      cursor = result.state;
      for (const inst of result.changedInstances) {
        await upsertInstance(args.adapter, inst);
        if (inst.status === "planned") planned += 1;
        else if (inst.status === "materialized") materialized += 1;
      }
    } catch (err) {
      if (op.type === "MATERIALIZE_INSTANCE") {
        errors.push({
          recurrence_phid: op.recurrence_phid,
          error: String(err),
        });
      }
    }
  }
  return {
    templates_considered: state.templates.size,
    instances_created: materialized,
    instances_planned_gated: planned,
    errors,
  };
}

/**
 * Periodic ticker — runs `runMaterializationTickOnce` every
 * `intervalMs` (default 15 min). Returns a stop handle.
 */
export function startMaterializationTicker(
  args: MaterializationTickArgs & { intervalMs?: number },
): () => void {
  const intervalMs = args.intervalMs ?? 15 * 60 * 1000;
  const id = setInterval(() => {
    void runMaterializationTickOnce(args).catch(() => {});
  }, intervalMs);
  // Fire one immediately so startup recovery + initial materializations
  // don't have to wait a full tick.
  void runMaterializationTickOnce(args).catch(() => {});
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------------
// State loader
// ---------------------------------------------------------------------------

async function loadActiveState(adapter: DbAdapter): Promise<RecurrenceState> {
  const templates = await listTemplates(adapter, { status: "active" });
  const state = emptyState();
  for (const t of templates) {
    state.templates.set(t.recurrence_phid, t);
    const insts = await listInstancesForTemplate(adapter, t.recurrence_phid, 200);
    state.instancesByTemplate.set(t.recurrence_phid, insts);
  }
  return state;
}
