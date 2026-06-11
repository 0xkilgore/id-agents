# RecurrenceTemplate substrate

Built per CTO scope `cto/output/2026-06-10-recurrence-template-architecture-scope.md` and the dispatch brief at `agent-platform/output/2026-06-11-recurrence-template-build-dispatch-brief.md`.

Module layout:

```
recurrences/
├── types.ts          // RecurrenceTemplate, RecurrenceInstance, RecurrenceOp, status enums, DTO shapes
├── rrule.ts          // parseRrule + bounded expandRrule + defaultHorizonForRrule
├── reducer.ts        // pure applyOp for the 5 typed operations
├── materialization.ts// pure planMaterializations + computeIdempotencyKey
├── storage.ts        // sqlite schema + CRUD (templates, instances, exceptions)
├── read-api.ts       // OP-1-shaped DTO builders (list active / list instances / fetch template)
├── bootstrap.ts      // manager-side runMaterializationTickOnce + startMaterializationTicker
└── examples/         // shadow-mode JSON for the first 2 consumers
    ├── sunday-weekly-product-log.json    // CTO migration path #1
    └── daily-stagione-stub.json          // CTO migration path #2
```

## How to land a new recurrence (shadow → live)

1. Write the template JSON (use `examples/` as a template).
2. POST to the manager: `POST /recurrences/templates` with the JSON.
3. Run `runMaterializationTickOnce` (manually, via `id-agents recurrences tick`, or wait for the next 15-min tick).
4. `GET /recurrences/templates/<phid>` to confirm the template + its next-3 fires.
5. Compare to the bespoke schedule. If matched: disable the bespoke trigger.
6. If not matched: `POST /recurrences/templates/<phid>/cancel` (or `UPDATE` with the corrected RRULE) and re-shadow.

## OP-7 gating

The materialization planner calls `GatingProbe.check(template)` BEFORE each dispatch-producing materialization. V0 uses `ALWAYS_ALLOW_GATING` because OP-7 substrate isn't shipped yet; when it lands, swap the constant for the real probe in `bootstrap.ts` — no other code paths change.

Gated instances are written as `planned` with a typed `failure_reason` (`dispatch_blocked:usage_budget_exceeded` or `queued_for_capacity`) and are NEVER marked delivered. This satisfies CTO scope §"Failure Mode": "do not fake success".

## RD-001 compliance

`recurrence_phid` and `instance_phid` are the stable operation targets. `display_id` is read-model only. Every typed op (CREATE / UPDATE / CANCEL / MATERIALIZE_INSTANCE / RECORD_EXCEPTION) takes the stable PHID as its target — display IDs are NEVER operation targets.
