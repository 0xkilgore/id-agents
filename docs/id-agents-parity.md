# id-agents ↔ Kapelle parity ledger

**Track:** T-DEPLOY.6 (consolidated from T-OSS.5) — id-agents ↔ Kapelle continuous-sync hygiene.
**Status:** STANDING. This is a permanent hygiene lane, not a one-time migration.
**Owners:** CTO (ledger spec) · Maestra (weekly sync lane) · Roger/Hopper (compat tests).

## Why this exists

`id-agents` (the MIT manager/runtime) and the Kapelle product (`kapelle-site`)
evolve in **separate repos** but share one load-bearing seam: the **manager HTTP
read-model contract** the Kapelle ops console consumes. When a manager change
silently renames or drops a field the console reads, `/ops` breaks at deploy —
the exact "merged != running" / version-skew class T-DEPLOY exists to kill.

This ledger is the canonical list of the shared contract surfaces. The
**`id-agents-compat` test suite** (`tests/unit/id-agents-compat.test.ts`) pins
the load-bearing parts so drift fails the **id-agents build** instead of the
Kapelle deploy.

## The shared contract surfaces

| Surface (manager route) | Kapelle consumer | Pinned by compat suite |
|---|---|---|
| `GET /dispatches` rows (`DispatchReadRow`) | `app/ops/_lib/dispatchStatus.ts`, dispatches page | ✅ field set + nested blocks |
| `effective_state` taxonomy (T13.2) | `DispatchEffectiveState`, saved views, sort | ✅ contracted 7-value union |
| `needs_operator` flag (T13.2) | needs-you view + counts | ✅ present on every row |
| `sort_group` band (T13.3) | dispatch queue ordering | ✅ integer 0..5 |
| `GET /agents/status` | dashboard agents panel, desktop tray | ⏳ (add when shape changes) |
| `GET /agents/:name/detail` (`agents.detail.v1`) | agent dossier page | ⏳ |
| `GET /artifacts` / `GET /outputs/inbox` | artifacts surfaces | ⏳ |
| `GET /dispatches/health` | queue-depth panel | ⏳ |

### `DispatchReadRow` — the canonical contract (load-bearing)

Top-level fields Kapelle reads off every `/dispatches` row (any drop/rename is
breaking):

`id`, `dispatch_id`, `dispatch_phid`, `query_id`, `status`, `effective_state`,
`needs_operator`, `sort_group`, `target_agent`, `agent_id`, `title`, `subject`,
`queued_at`, `in_flight_at`, `completed_at`, `updated_at`, `failure_kind`,
`failure_detail`, `supersede_link`.

Nested blocks: `recovery`, `evidence`, `recovery_classification`,
`source_metadata` (with `source` + `from_actor`).

`effective_state` contracted union (Kapelle's UI branches exhaustively):
`failed_work_landed_recoverable`, `moot_or_superseded`, `failed_needs_operator`,
`queued`, `in_flight`, `done`, `done_recovered`.

`sort_group`: integer `0..5` (the §"Default Sort Policy" groupRank).

## PR / release checklist — manager/runtime deltas

Before merging a change to the manager read-model (`src/dispatch-scheduler/read-model.ts`,
`src/outputs/*`, the agent/dispatch read routes), confirm:

- [ ] **Compat suite green** — `npm test -- tests/unit/id-agents-compat.test.ts`.
- [ ] If a contracted field/state was **added**: it is additive (Kapelle ignores
  unknown fields) OR a paired `kapelle-site` PR consumes it. Record the addition
  in the surface table above.
- [ ] If a contracted field/state was **renamed/removed**: a paired `kapelle-site`
  PR lands in the **same deploy window** (coupled redeploy — T-DEPLOY.3). Never
  ship a breaking read-model change alone.
- [ ] `schema_version` bumped on the affected envelope when the shape changes.
- [ ] This ledger updated (surface table + field list).

## Weekly sync lane (Maestra)

Loop kind candidate: **`id-agents-parity-weekly`** (~30 min/week). Each run:
1. Diff the manager read-model surfaces vs. this ledger; flag undocumented fields.
2. Confirm the compat suite still covers the surface table's ✅ rows; file a
   build dispatch to extend coverage for any ⏳ row whose shape changed.
3. Note any divergence between the id-agents MIT upstream and the Kapelle
   distribution in the weekly product log.

## Provenance

OSS lift: none (internal contract). Pattern reference: the inbox DM1 parity model
(`src/inbox/*` `checkParity` → `parity_status: ok|fallback|drift`) and the
finance-port "dual-write → backfill → parity → flag" spine — this ledger is the
*cross-repo* analogue (manager↔product), not a markdown↔substrate projection.
