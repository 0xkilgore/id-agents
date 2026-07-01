# T-PERSONAL — Gideon Sports Agent: Scope + First Build Slice

**Track:** T-PERSONAL · **Owner agent:** `gideon` (Personal project) · **Status:** first slice shipped
**Origin:** Chris (canonical roadmap-reset comment, 2026-06-30 manager handover):
> "Add a sports agent for Gideon that manages fantasy sports, gives sports info, and can pull sports data. Model it off personal agent fantasy baseball/basketball workflows."

The prior CTO scope artifact (`gideon:sports-agent-scope-refire`) rendered with no body; this document is the readable replacement plus the first concrete, tested build slice.

---

## 1 — What it is

A **personal sports agent for Gideon** that:

1. **Manages fantasy sports** — fantasy baseball (MLB) and fantasy basketball (NBA): matchup/injury/roster pulls → lineup-change and waiver-target recommendations.
2. **Gives sports info** — scores, standings, and headlines for Gideon's teams.
3. **Pulls sports data** — the external-data collectors that feed 1 & 2.

It is modeled directly on the **existing personal `fantasy-baseball` Loop** already in the seed catalog (`src/loops/registry.ts`), which is the "personal agent fantasy baseball workflow" Chris referenced.

## 2 — Why Loops (not a new subsystem)

The runtime already has a first-class **Loops** primitive: durable, repeatable operator processes (deterministic collectors + LLM reasoning) that produce a deliverable each run, surfaced by the `/ops/loops` read-model (`registry.ts` → `listLoops` / `getLoop` / `loopsSummary`). A personal sports agent *is* a set of Loops. Registering the agent's workflows in the seed catalog is the smallest change that produces real, visible, testable value and composes with the substrate (`loop_runs`) when it lands — no parallel plumbing.

## 3 — First build slice (this PR)

Registers the Gideon sports agent as **three Personal-project Loops owned by `gideon`**:

| slug | name | kind | schedule | phase |
|---|---|---|---|---|
| `fantasy-baseball` | Fantasy Baseball | `external_data` | Daily in season (manual override) | reassigned `unassigned`→`gideon` |
| `fantasy-basketball` | Fantasy Basketball | `external_data` | Daily in season (manual override) | **new** |
| `gideon-sports-brief` | Gideon Sports Brief | `digest` | Daily 08:00 local (in season) | **new** |

- `fantasy-basketball` is the NBA counterpart to the existing `fantasy-baseball`, same shape.
- `gideon-sports-brief` is the "gives sports info" digest: scores/standings/headlines for his teams + fantasy roster status and start/sit flags across MLB and NBA.
- All three are **Phase-2** (`enabled: false`, `allow_manual_run: true`, `allow_scheduled_run: true`) — registered and manually runnable now; the auto-cadence flips on once the external sports-data integration exists. This mirrors how `fantasy-baseball` was already staged.
- Reassigning `fantasy-baseball` from `unassigned` to `gideon` groups all three into one coherent, filterable agent surface (`GET /ops/loops?owner_agent=gideon` and `?project_phid=phid:proj:personal`).

Fully covered by `tests/unit/loops-registry.test.ts` (owner grouping, per-loop shape, facet counts, project filter) with count-dependent sibling assertions updated.

## 4 — Next slices (not in this PR)

1. **External sports-data collectors** (the "pull sports data" substrate): a provider adapter (e.g. balldontlie / MLB Stats API / ESPN endpoints) behind a deterministic collector interface, feeding all three loops. License-tag + provenance per standing OSS-lift posture.
2. **Fantasy-platform connectors** (ESPN / Yahoo / Sleeper) for real roster state — the input to lineup/waiver recommendations.
3. **Loop execution wiring** — flip the three loops to `enabled` and bind the `loop_runs` substrate so the brief and recommendations actually generate on cadence.
4. **De-Chris / per-user** — `team_id` threading so the agent runs on Gideon's data, not a hard-coded personal project (composes with T-DECHRIS).

## 5 — OSS to lift (next slice, per standing posture)

| Component | License | Plan |
|---|---|---|
| MLB Stats API / balldontlie (NBA) | public / MIT-ish | DIRECT read via collector; attribute in commit + PR body |
| Sleeper API (fantasy) | public | DIRECT read; provenance line |
| ESPN/Yahoo fantasy | proprietary | pattern-reference / auth-gated connector only |

Provenance shape (`OSS lift: <component> (<license>) — <url>` + adapt notes) applied when those collectors land.
