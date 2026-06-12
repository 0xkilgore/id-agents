# Dispatch-canonical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manager-side `Dispatch` document the canonical work record; turn every other surface (scheduler queue, manager query rows, Cane `pending-agent-replies.md`, delivery log, laptop polling, dashboards) into a projection of dispatch state — without a big-bang rewrite.

**Architecture:** Add the missing canonical operations on `SqliteDispatchReactor` (`acceptDispatchStart`) + a route pair (`POST /dispatches/:id/accept`, `POST /dispatches/:id/in-flight`). Persist scheduler `dispatch_id` / `manager_query_id` into the agent-local query row (new column + new fields in `GET /query/:id`). Cut the Cane routing path from legacy numeric `POST /dispatches` to canonical `/dispatch/enqueue` + `/dispatches/:id/accept`. Roll out in **shadow → cutover** phases gated by an env flag (`DISPATCH_CANONICAL_MODE = shadow | enforce`) so every step is reversible.

**Tech Stack:** TypeScript (`src/dispatch-scheduler/*`, `src/agent-manager-db.ts`, `src/claude-agent-server.ts`), vitest + `better-sqlite3`, Python (`taskview/cane_routing.py`, `agent_done_server.py`), pytest.

**Source spec (read first):** `cto/output/2026-06-03-dispatch-closeout-gap-spec.md` (validated 2026-06-05). The sibling worktree at `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout` carries a working `acceptDispatchStart` + route pair already — port the contract semantics, not the code verbatim (it was written against an older surface).

**codex_skip:** true (per dispatch direction — Chris prefers Claude on this planning phase).

---

## Open questions for Chris / CTO

**RESOLVED 2026-06-09 — Chris approved all of Roger's recommendations:** Q1 → (a) increment on direct accept. Q2 → (a) separate `resumeDispatch`; keep `acceptDispatchStart` strict (queued→in_flight only). Q3 → (b) bounce/retry for transient-offline, (a) hard-fail on a 4xx. Q4 → (a) new `manager_query_id` column. Q5 → (a) keep legacy compat forever. Q6 → no other consumer calls a numeric route (and it's good that they can't) — no work. Q7 → (a) strict 409 on `/agent-done` mismatch ("that's how we get the nice tracking later"). Build to these.

Flag these BEFORE Slice B starts so the build doesn't have to guess.

1. **Attempt-count accounting for direct accept.** When a Cane-routed `/talk` succeeds and we call `acceptDispatchStart`, should `attempt_count` increment? Three options:
   - **(a) Increment on direct accept** — symmetric with scheduler `claim()`. Simplest; double-counts if scheduler also claims the row before Cane's accept (impossible by lifecycle but worth confirming).
   - **(b) Never increment on direct accept** — direct delivery is "out of band" from the scheduler's POV. Risk: an agent that always accepts via direct path looks like it has 0 attempts forever, masking flaky behavior.
   - **(c) Record a separate `accept_via_direct` count** — new column. Most accurate but the most invasive.

   **Recommendation: (a)** for parity with scheduler; the double-count corner is structurally impossible because `acceptDispatchStart` rejects `in_flight → in_flight` with a different `agent_query_id`. Confirm.

2. **`needs_clarification` accept semantics.** Spec §1 says `needs_clarification` "does not accept normal starts." Does it accept a `resume`-driven start (the `agent-resume` path sends a follow-up `/talk` with a NEW `agent_query_id`)? Two options:
   - **(a) Resume path goes through a separate `resumeDispatch(...)` operation** that flips `needs_clarification → in_flight` and stamps the new `agent_query_id`. Cleanest.
   - **(b) `acceptDispatchStart` accepts `needs_clarification` when the doc has a populated `resume_delivery_status: pending`.** Reuses the accept op; introduces a second valid transition source.

   **Recommendation: (a)** — keep `acceptDispatchStart` strict (queued → in_flight only) so the audit trail is unambiguous. Confirm.

3. **Cane "delivery failed" terminal-state choice.** When Cane mints a `dispatch_phid` but `/talk` fails (no agent response, agent offline), the dispatch is currently left at `queued` with a stub pending row. Should it be:
   - **(a) `markFailed(..., failure_kind: 'delivery_failed')`** — terminal. Operator must explicitly re-enqueue.
   - **(b) `markBounced(..., next_attempt_at: now + N)`** — scheduler picks it up later via the existing bounce sweep.
   - **(c) Leave at `queued` with a delivery-failed annotation** — current behavior.

   **Recommendation: (b)** for offline-agent (transient); **(a)** for hard 4xx from the agent. Confirm or override.

4. **`manager_query_id` storage location in `queries`.** The agent-local row has `query_id` (its own local id). The spec calls for persisting the upstream manager id as `manager_query_id`. Two options:
   - **(a) New column `manager_query_id TEXT NULL`** on `queries` — straightforward; one ALTER TABLE; readable by every consumer; index-able.
   - **(b) Pack into a `metadata_json` blob** — less invasive on the schema, more brittle for downstream queries (Reactor reads, projections).

   **Recommendation: (a)** — Roger's recent B1 added `last_output_at` the same way; pattern is established. Confirm.

5. **Backwards compat sunset window for legacy pending rows.** Cane's `agent_done_server.py` already accepts both legacy 5-column and v2 tail-key formats. How long do we keep the legacy path?
   - **(a) Forever** — never sunset; pending row writers always emit v2, parser accepts both.
   - **(b) 60 days post-cutover** — Sunset after the laptop + M4 fleet have all rotated through.

   **Recommendation: (a)** — the cost of forever-compat in the parser is ~10 lines; not worth a coordinated sunset.

6. **Legacy numeric `POST /dispatches` removal.** The current target repo doesn't have this route at all (already removed). The spec mentions it as a Cane-side legacy path — but Cane is already off it (uses `/dispatch/enqueue` per the live `_register_dispatch`). So: **no work needed on the manager side**. Confirm no other consumer (laptop, dashboards) still calls a numeric route.

7. **`/agent-done` mismatch policy.** Spec §3 says mismatched `dispatch_id`/`query_id` pairs return 409. Current code accepts whichever id resolves first and ignores the other. Two options:
   - **(a) Strict** — both must match the same doc; mismatch → 409.
   - **(b) Resolve-by-strongest** — `dispatch_id` wins, others are advisory; mismatch logs a warning.

   **Recommendation: (a)** strict — the 409 path is what the closeout depends on; (b) is what we already have and it produced the partial-truth problems.

---

## File structure (where the work lands)

```
src/dispatch-scheduler/
  sqlite-dispatch-reactor.ts                    MODIFY  acceptDispatchStart() method
  fake-reactor.ts                               MODIFY  parity acceptDispatchStart()
  dispatch-doc-client.ts                        MODIFY  wrap acceptDispatchStart() with Result
  manager-integration.ts                        MODIFY  SchedulerHandle.acceptDispatchStart() + handleAgentDone() strict-match
  read-model.ts                                 MODIFY  +closeout_path, +source field on DispatchReadRow
src/agent-manager-db.ts                         MODIFY  +POST /dispatches/:id/accept + alias /in-flight
                                                        +persist manager_dispatch_id/manager_query_id when /talk lands
                                                        +/query/:id includes dispatch fields
                                                        +/agent-done strict id matching (open Q #7)
src/claude-agent-server.ts                      MODIFY  /talk: extract dispatch_id + upstream query_id from body OR
                                                        parse `[dispatch_id: ...]` header; persist into queries row
src/db/types.ts                                 MODIFY  QueryRow + manager_dispatch_id, manager_query_id
src/db/migrations/sqlite.ts                     MODIFY  idempotent ALTER TABLE queries ADD COLUMN ...
src/db/migrations/postgres.ts                   MODIFY  same
src/db/repos/sqlite/queries-repo.ts             MODIFY  upsert + recordOutput + getByQueryIdForTeam carry new cols
src/db/repos/postgres/queries-repo.ts           MODIFY  same
src/db/db-service.ts                            MODIFY  QueriesRepository.upsert signature accepts manager_*

tests/unit/
  dispatch-scheduler-accept.test.ts             NEW     acceptDispatchStart cases (12+)
  dispatch-scheduler-handle.test.ts             MODIFY  SchedulerHandle accept + handleAgentDone strict
  queries-repo-manager-ids.test.ts              NEW     upsert + read manager_dispatch_id, manager_query_id

tests/integration/
  dispatch-canonical-lifecycle.test.ts          NEW     end-to-end queued→accept→done; queued out-of-band still works
  query-dispatch-projection.test.ts             NEW     /query/:id projects dispatch fields
  agent-done-strict-match.test.ts               NEW     mismatched dispatch_id/query_id → 409

# Cane side
taskview/cane_routing.py                        MODIFY  optional — handle failed-delivery branch per open Q #3
agent_done_server.py                            MODIFY  optional — already v2-ready; verify match order
taskview/tests/test_pending_dispatch_v2.py      NEW     parser/writer for v2 rows + matching order

# Docs
docs/superpowers/plans/2026-06-10-dispatch-canonical.md   THIS FILE
```

**Phasing flag.** Add `DISPATCH_CANONICAL_MODE` env: `shadow` (default for one week, dual-write but legacy paths still work) → `enforce` (legacy direct-claim paths refused; `acceptDispatchStart` is the only `queued → in_flight` route). Both modes leave `markQueuedDoneWithResult` available as the documented repair path.

---

## Phasing — shadow → cutover, reversible

| Phase | Code state | What runs in prod | Rollback |
|---|---|---|---|
| **0. baseline** | main | scheduler `claim()` + `recordAgentStart()` + `markQueuedDoneWithResult` (today) | n/a |
| **A. metadata persistence** | adds new columns + parsing, no behavior change | `/query/:id` starts returning `manager_dispatch_id`; nothing else flips | revert column ALTER (additive); no flag needed |
| **B. accept op + route, shadow** | `acceptDispatchStart` + `/dispatches/:id/accept` mounted; Cane routing calls it; `DISPATCH_CANONICAL_MODE=shadow` | scheduler `claim()` still works; direct accept also works; new lifecycle metric `closeout_path` written | unset accept route mount; Cane reverts to today's `/talk`-only path |
| **C. enforce** | set `DISPATCH_CANONICAL_MODE=enforce` | scheduler `claim()` continues; direct `/talk` flows without `acceptDispatchStart` are now logged as `lifecycle_skipped_accept` warning (not refused) | flip env back to `shadow` |
| **D. strict /agent-done mismatch** | mismatched `dispatch_id`/`query_id` pairs → 409 | one ENV `DISPATCH_AGENT_DONE_STRICT=1` | unset env |
| **E. reconciliation view** | new `GET /dispatches/reconcile` read-only surface | dashboard/inbox can show drift counts | revert route mount |

No phase requires a code freeze in another repo. Cane's existing routing already calls `/dispatches/:dispatch_id/accept` — once Slice B ships, Cane "just starts working" without a Cane-side code change.

---

## Tasks

### Task 1: Add `acceptDispatchStart` to `FakeReactor` (port from sibling)

**Files:**
- Modify: `src/dispatch-scheduler/fake-reactor.ts`
- Test: `tests/unit/dispatch-scheduler-accept.test.ts`

The sibling at `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout/src/dispatch-scheduler/fake-reactor.ts:199-237` already has a working impl. Port the semantics, not the line numbers — they will differ.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/dispatch-scheduler-accept.test.ts
import { describe, it, expect } from "vitest";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const NOW = "2026-06-10T12:00:00.000Z";
const base: EnqueueInput = {
  query_id: "q-1",
  to_agent: "coder",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

describe("FakeReactor.acceptDispatchStart", () => {
  it("queued -> in_flight succeeds and stamps agent_query_id + started_at + attempt_count++", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    const accepted = await reactor.acceptDispatchStart(doc.dispatch_phid, {
      agent_query_id: "agent-q-1",
    });
    expect(accepted?.status).toBe("in_flight");
    expect(accepted?.agent_query_id).toBe("agent-q-1");
    expect(accepted?.started_at).toBe(NOW);
    expect(accepted?.attempt_count).toBe(doc.attempt_count + 1);
  });

  it("in_flight with same agent_query_id is idempotent (no second attempt_count++, no started_at reset)", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    const first = await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    const replay = await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    expect(replay?.attempt_count).toBe(first?.attempt_count);
    expect(replay?.started_at).toBe(first?.started_at);
  });

  it("in_flight with different agent_query_id throws conflict", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    await expect(
      reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-2" }),
    ).rejects.toThrow(/conflict/i);
  });

  it("done + same agent_query_id is no-op (idempotent post-terminal replay)", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    await reactor.markDone(doc.dispatch_phid);
    const replay = await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    expect(replay?.status).toBe("done");
  });

  it("done + different agent_query_id throws conflict (cannot reaccept a closed dispatch with a fresh agent_query_id)", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    await reactor.markDone(doc.dispatch_phid);
    await expect(
      reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-2" }),
    ).rejects.toThrow(/terminal/i);
  });

  it("rejects empty agent_query_id", async () => {
    const reactor = new FakeReactor({ now: () => NOW });
    const doc = await reactor.enqueue(base);
    await expect(
      reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd /Users/kilgore/Dropbox/Code/cane/id-agents && npx vitest run tests/unit/dispatch-scheduler-accept.test.ts`
Expected: FAIL — `acceptDispatchStart` is not a function on `FakeReactor`.

- [ ] **Step 3: Add `acceptDispatchStart` to `FakeReactor`**

Port from `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout/src/dispatch-scheduler/fake-reactor.ts:199-237`. Replace the body of `recordAgentStart` to delegate.

```typescript
// src/dispatch-scheduler/fake-reactor.ts (inside FakeReactor)

async recordAgentStart(phid: string, agent_query_id: string): Promise<DispatchDoc | null> {
  this.guard();
  return this.acceptDispatchStart(phid, { agent_query_id });
}

async acceptDispatchStart(
  phid: string,
  input: { agent_query_id: string },
): Promise<DispatchDoc | null> {
  this.guard();
  const doc = this.docs.get(phid);
  if (!doc) return null;
  const agentQueryId = input.agent_query_id.trim();
  if (!agentQueryId) throw conflict("acceptDispatchStart requires non-empty agent_query_id");
  if (doc.status === "queued") {
    const next: DispatchDoc = {
      ...doc,
      status: "in_flight",
      attempt_count: doc.attempt_count + 1,
      started_at: this.nowFn(),
      updated_at: this.nowFn(),
      agent_query_id: agentQueryId,
    };
    this.docs.set(phid, next);
    return clone(next);
  }
  if (doc.status === "in_flight") {
    if (doc.agent_query_id && doc.agent_query_id !== agentQueryId) {
      throw conflict(
        `acceptDispatchStart conflict: in_flight has agent_query_id ${doc.agent_query_id}`,
      );
    }
    const next: DispatchDoc = { ...doc, agent_query_id: agentQueryId, updated_at: this.nowFn() };
    this.docs.set(phid, next);
    return clone(next);
  }
  if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
    if (doc.agent_query_id === agentQueryId) return clone(doc);
    throw conflict(`acceptDispatchStart cannot run from terminal ${doc.status}`);
  }
  throw conflict(`acceptDispatchStart requires queued or in_flight, was ${doc.status}`);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/unit/dispatch-scheduler-accept.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/dispatch-scheduler-accept.test.ts src/dispatch-scheduler/fake-reactor.ts
git commit -m "feat(dispatch): FakeReactor.acceptDispatchStart with conflict semantics"
```

---

### Task 2: Add `acceptDispatchStart` to `SqliteDispatchReactor`

**Files:**
- Modify: `src/dispatch-scheduler/sqlite-dispatch-reactor.ts`
- Test: `tests/unit/dispatch-scheduler-accept.test.ts` (extend with sqlite suite)

- [ ] **Step 1: Add a sqlite-backed describe block to the test file**

```typescript
// Append to tests/unit/dispatch-scheduler-accept.test.ts
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";

describe("SqliteDispatchReactor.acceptDispatchStart", () => {
  async function setup() {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    const reactor = new SqliteDispatchReactor({
      adapter,
      teamId: "team_default",
      now: () => NOW,
    });
    return { adapter, reactor };
  }

  it("queued -> in_flight succeeds via UPDATE WHERE status='queued'", async () => {
    const { reactor } = await setup();
    const doc = await reactor.enqueue(base);
    const accepted = await reactor.acceptDispatchStart(doc.dispatch_phid, {
      agent_query_id: "agent-q-1",
    });
    expect(accepted?.status).toBe("in_flight");
    expect(accepted?.attempt_count).toBe(doc.attempt_count + 1);
    expect(accepted?.agent_query_id).toBe("agent-q-1");
  });

  it("idempotent in_flight + same agent_query_id (no second UPDATE counted)", async () => {
    const { reactor } = await setup();
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    const replay = await reactor.acceptDispatchStart(doc.dispatch_phid, {
      agent_query_id: "agent-q-1",
    });
    expect(replay?.attempt_count).toBe(doc.attempt_count + 1);
  });

  it("conflict on different agent_query_id in in_flight", async () => {
    const { reactor } = await setup();
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    await expect(
      reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-2" }),
    ).rejects.toThrow(/conflict/i);
  });

  it("terminal-state semantics match FakeReactor", async () => {
    const { reactor } = await setup();
    const doc = await reactor.enqueue(base);
    await reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-1" });
    await reactor.markDone(doc.dispatch_phid);
    await expect(
      reactor.acceptDispatchStart(doc.dispatch_phid, { agent_query_id: "agent-q-2" }),
    ).rejects.toThrow(/terminal/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/unit/dispatch-scheduler-accept.test.ts`
Expected: PASS for FakeReactor block (from Task 1), FAIL for SqliteDispatchReactor block.

- [ ] **Step 3: Add `acceptDispatchStart` to `SqliteDispatchReactor`**

Port from `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout/src/dispatch-scheduler/sqlite-dispatch-reactor.ts:321-367`. Replace the body of `recordAgentStart` to delegate.

```typescript
// src/dispatch-scheduler/sqlite-dispatch-reactor.ts (inside SqliteDispatchReactor)

async recordAgentStart(phid: string, agent_query_id: string): Promise<DispatchDoc | null> {
  return this.acceptDispatchStart(phid, { agent_query_id });
}

async acceptDispatchStart(
  phid: string,
  input: { agent_query_id: string },
): Promise<DispatchDoc | null> {
  const doc = await this.getByPhid(phid);
  if (!doc) return null;
  const agentQueryId = input.agent_query_id.trim();
  if (!agentQueryId) throw conflict("acceptDispatchStart requires non-empty agent_query_id");
  const now = this.nowFn();
  if (doc.status === "queued") {
    const { rowCount } = await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'in_flight',
           attempt_count = attempt_count + 1,
           started_at = ?,
           updated_at = ?,
           agent_query_id = ?
       WHERE dispatch_phid = ? AND team_id = ? AND status = 'queued'`,
      [now, now, agentQueryId, phid, this.teamId],
    );
    if (rowCount === 0) throw conflict(`acceptDispatchStart lost queued transition for ${phid}`);
    return this.getByPhid(phid);
  }
  if (doc.status === "in_flight") {
    if (doc.agent_query_id && doc.agent_query_id !== agentQueryId) {
      throw conflict(
        `acceptDispatchStart conflict: in_flight has agent_query_id ${doc.agent_query_id}`,
      );
    }
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET agent_query_id = ?, updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ? AND status = 'in_flight'`,
      [agentQueryId, now, phid, this.teamId],
    );
    return this.getByPhid(phid);
  }
  if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
    if (doc.agent_query_id === agentQueryId) return doc;
    throw conflict(`acceptDispatchStart cannot run from terminal ${doc.status}`);
  }
  throw conflict(`acceptDispatchStart requires queued or in_flight, was ${doc.status}`);
}
```

- [ ] **Step 4: Run all accept tests**

Run: `npx vitest run tests/unit/dispatch-scheduler-accept.test.ts`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch-scheduler/sqlite-dispatch-reactor.ts
git commit -m "feat(dispatch): SqliteDispatchReactor.acceptDispatchStart"
```

---

### Task 3: Expose `acceptDispatchStart` on `DispatchDocClient`

**Files:**
- Modify: `src/dispatch-scheduler/dispatch-doc-client.ts`

- [ ] **Step 1: Add the interface entry + wrapper**

```typescript
// src/dispatch-scheduler/dispatch-doc-client.ts

// In DispatchReactor interface:
acceptDispatchStart: FakeReactor["acceptDispatchStart"];

// In DispatchDocClient class:
async acceptDispatchStart(
  phid: string,
  input: { agent_query_id: string },
): Promise<Result<DispatchDoc>> {
  return this.wrapNullable("acceptDispatchStart", () =>
    this.reactor.acceptDispatchStart(phid, input),
  );
}
```

- [ ] **Step 2: Run existing client tests**

Run: `npx vitest run tests/unit/dispatch-scheduler-doc-client.test.ts`
Expected: PASS (additive change, no existing test breaks).

- [ ] **Step 3: Commit**

```bash
git add src/dispatch-scheduler/dispatch-doc-client.ts
git commit -m "feat(dispatch): DispatchDocClient.acceptDispatchStart pass-through"
```

---

### Task 4: Add `SchedulerHandle.acceptDispatchStart`

**Files:**
- Modify: `src/dispatch-scheduler/manager-integration.ts`
- Test: `tests/unit/dispatch-scheduler-handle.test.ts`

- [ ] **Step 1: Write the handle test**

```typescript
// tests/unit/dispatch-scheduler-handle.test.ts — add a new describe block

describe("SchedulerHandle.acceptDispatchStart", () => {
  it("resolves dispatch_id with phid prefix via getByPhid", async () => {
    const handle = await makeHandle();
    const enq = await handle.enqueue({ from_actor: "cane", to_agent: "coder", message: "hi" });
    const doc = await handle.acceptDispatchStart({
      dispatch_id: enq.dispatch_phid,
      agent_query_id: "agent-q-1",
    });
    expect(doc?.status).toBe("in_flight");
    expect(doc?.agent_query_id).toBe("agent-q-1");
  });

  it("resolves dispatch_id given as a manager query_id via getByQueryId", async () => {
    const handle = await makeHandle();
    const enq = await handle.enqueue({ from_actor: "cane", to_agent: "coder", message: "hi" });
    const doc = await handle.acceptDispatchStart({
      dispatch_id: enq.query_id,         // pass the manager query_id, not phid
      agent_query_id: "agent-q-1",
    });
    expect(doc?.status).toBe("in_flight");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL — `acceptDispatchStart` not on `SchedulerHandle`.

- [ ] **Step 3: Add the handle method**

Port from `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout/src/dispatch-scheduler/manager-integration.ts:432-445`.

```typescript
// src/dispatch-scheduler/manager-integration.ts inside SchedulerHandle

async acceptDispatchStart(args: {
  dispatch_id: string;
  agent_query_id: string;
}): Promise<DispatchDoc | null> {
  const doc = args.dispatch_id.startsWith("phid:")
    ? await this.reactor.getByPhid(args.dispatch_id)
    : await this.reactor.getByQueryId(args.dispatch_id);
  if (!doc) return null;
  const r = await this.client.acceptDispatchStart(doc.dispatch_phid, {
    agent_query_id: args.agent_query_id,
  });
  if (!r.ok) throw new Error(r.detail);
  return r.value;
}
```

- [ ] **Step 4: Run handle tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/dispatch-scheduler-handle.test.ts src/dispatch-scheduler/manager-integration.ts
git commit -m "feat(dispatch): SchedulerHandle.acceptDispatchStart with id resolution"
```

---

### Task 5: Mount `POST /dispatches/:dispatch_id/accept` and `/in-flight` alias

**Files:**
- Modify: `src/agent-manager-db.ts`
- Test: `tests/integration/dispatch-canonical-lifecycle.test.ts` (NEW)

- [ ] **Step 1: Write the route integration test**

```typescript
// tests/integration/dispatch-canonical-lifecycle.test.ts
// (Boot a real AgentManagerDb against in-memory SQLite per the
// pattern in tests/integration/checkin-task-autoclose.test.ts.)

describe("POST /dispatches/:dispatch_id/accept", () => {
  it("flips queued -> in_flight when agent_query_id is supplied", async () => {
    const { baseUrl, db } = ctx;
    const enq = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({ from_actor: "cane", to_agent: "coder", message: "hi" }),
    }).then((r) => r.json());

    const accept = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({ agent_query_id: "agent-q-1" }),
    });
    expect(accept.status).toBe(200);
    const body = await accept.json();
    expect(body.state).toBe("in_flight");
    expect(body.agent_query_id).toBe("agent-q-1");
  });

  it("rejects empty agent_query_id with 400", async () => {
    const { baseUrl } = ctx;
    const res = await fetch(`${baseUrl}/dispatches/phid:disp-fake/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on different agent_query_id replay", async () => {
    const { baseUrl } = ctx;
    const enq = /* enqueue */;
    await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, { /* agent-q-1 */ });
    const conflict = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({ agent_query_id: "agent-q-2" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("/in-flight is a strict alias requiring agent_query_id (cto spec §1)", async () => {
    const { baseUrl } = ctx;
    const enq = /* enqueue */;
    const inFlight = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/in-flight`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({ agent_query_id: "agent-q-1" }),
    });
    expect(inFlight.status).toBe(200);
    expect((await inFlight.json()).state).toBe("in_flight");
  });
});
```

- [ ] **Step 2: Run; confirm 404**

- [ ] **Step 3: Mount the route**

Port from `/Users/kilgore/Dropbox/Code/cane/id-agents-regina-closeout/src/agent-manager-db.ts:2021-2064`. Insert after the existing `/dispatch/enqueue` handler. Use the existing helpers (`normalizeDispatchIdInput`, etc.) that already exist in the target repo.

- [ ] **Step 4: Run the integration tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/dispatch-canonical-lifecycle.test.ts src/agent-manager-db.ts
git commit -m "feat(dispatch): POST /dispatches/:id/accept + /in-flight alias"
```

---

### Task 6: Add `manager_dispatch_id` + `manager_query_id` columns to `queries`

**Files:**
- Modify: `src/db/types.ts`, `src/db/migrations/sqlite.ts`, `src/db/migrations/postgres.ts`
- Modify: `src/db/repos/sqlite/queries-repo.ts`, `src/db/repos/postgres/queries-repo.ts`
- Modify: `src/db/db-service.ts` (QueriesRepository interface)
- Test: `tests/unit/queries-repo-manager-ids.test.ts` (NEW)

- [ ] **Step 1: Write the failing repo test**

```typescript
// tests/unit/queries-repo-manager-ids.test.ts
describe("QueriesRepository — manager_dispatch_id / manager_query_id", () => {
  it("upsert + getByQueryIdForTeam roundtrips manager ids", async () => {
    const { adapter, queries } = await setup();
    await queries.upsert("team_default", "agent_1", {
      query_id: "q-1",
      status: "pending",
      manager_dispatch_id: "phid:disp-abc",
      manager_query_id: "query_upstream_1",
    });
    const row = await queries.getByQueryIdForTeam("team_default", "q-1");
    expect(row?.manager_dispatch_id).toBe("phid:disp-abc");
    expect(row?.manager_query_id).toBe("query_upstream_1");
  });

  it("rows pre-dating the migration return null for both new columns", async () => {
    const { adapter, queries } = await setup();
    // Insert a row via raw SQL without the new columns
    await adapter.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, prompt, created, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["team_default", "agent_1", "q-legacy", "pending", "hi", 0, "agent", "agent_1"],
    );
    const row = await queries.getByQueryIdForTeam("team_default", "q-legacy");
    expect(row?.manager_dispatch_id).toBeNull();
    expect(row?.manager_query_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL — columns don't exist.

- [ ] **Step 3: Add the columns + types + interface field**

```typescript
// src/db/types.ts — extend QueryRow
export interface QueryRow {
  /* …existing… */
  /** Upstream manager dispatch phid for scheduler/cane-routed work. NULL for direct /talk that wasn't dispatch-routed. */
  manager_dispatch_id: string | null;
  /** Upstream manager query_id (the canonical one the scheduler minted at enqueue time). NULL for non-dispatch-routed queries. */
  manager_query_id: string | null;
}
```

```typescript
// src/db/migrations/sqlite.ts — append after the existing `last_output_at` ALTER (search for that pattern)
try {
  adapter.exec(`ALTER TABLE queries ADD COLUMN manager_dispatch_id TEXT`);
} catch { /* already exists */ }
try {
  adapter.exec(`ALTER TABLE queries ADD COLUMN manager_query_id TEXT`);
} catch { /* already exists */ }
```

```typescript
// src/db/migrations/postgres.ts — mirror
await adapter.query(`ALTER TABLE queries ADD COLUMN IF NOT EXISTS manager_dispatch_id TEXT`);
await adapter.query(`ALTER TABLE queries ADD COLUMN IF NOT EXISTS manager_query_id TEXT`);
```

```typescript
// src/db/repos/sqlite/queries-repo.ts
// In every SELECT column list (getById, getByQueryIdForTeam, etc.) add:
//   manager_dispatch_id, manager_query_id
// In the upsert UPDATE/INSERT path, include both columns with COALESCE so partial
// upserts don't null them out.
```

```typescript
// src/db/db-service.ts — QueriesRepository.upsert signature already takes Partial<QueryRow>; no shape change needed.
```

- [ ] **Step 4: Run repo tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/migrations/sqlite.ts src/db/migrations/postgres.ts \
        src/db/repos/sqlite/queries-repo.ts src/db/repos/postgres/queries-repo.ts \
        tests/unit/queries-repo-manager-ids.test.ts
git commit -m "feat(queries): manager_dispatch_id + manager_query_id columns"
```

---

### Task 7: Persist `manager_dispatch_id` + `manager_query_id` in agent `/talk`

**Files:**
- Modify: `src/claude-agent-server.ts`
- Test: `tests/integration/query-dispatch-projection.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/query-dispatch-projection.test.ts
describe("Agent /talk persists manager dispatch metadata", () => {
  it("body { dispatch_id, query_id } populates queries.manager_dispatch_id + manager_query_id", async () => {
    const { agentUrl, agentDb, agentTeamId } = ctx;
    const res = await fetch(`${agentUrl}/talk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "[dispatch_id: phid:disp-abc]\n[query_id: query_upstream_1]\n\nactual prompt",
        from: "scheduler",
        dispatch_id: "phid:disp-abc",
        query_id: "query_upstream_1",
      }),
    });
    expect(res.status).toBe(202);
    const { query_id } = await res.json();
    const row = await agentDb.queries.getByQueryIdForTeam(agentTeamId, query_id);
    expect(row?.manager_dispatch_id).toBe("phid:disp-abc");
    expect(row?.manager_query_id).toBe("query_upstream_1");
  });

  it("falls back to parsing `[dispatch_id: ...]` from message when JSON fields are missing", async () => {
    const { agentUrl, agentDb, agentTeamId } = ctx;
    const res = await fetch(`${agentUrl}/talk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "[dispatch_id: phid:disp-xyz]\n[query_id: query_upstream_2]\n\nbody",
        from: "scheduler",
      }),
    });
    const { query_id } = await res.json();
    const row = await agentDb.queries.getByQueryIdForTeam(agentTeamId, query_id);
    expect(row?.manager_dispatch_id).toBe("phid:disp-xyz");
    expect(row?.manager_query_id).toBe("query_upstream_2");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

- [ ] **Step 3: Update `/talk` handler in `claude-agent-server.ts:727-778`**

```typescript
this.app.post('/talk', async (req, res) => {
  try {
    const { message, session_id, from, schedule } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // Slice A: extract upstream dispatch metadata.
    // JSON body wins over parsed-from-message; fall back to the visible
    // `[dispatch_id: …]` / `[query_id: …]` header so harnesses that only
    // pass through the prompt text don't lose the trail.
    const dispatchIdFromBody = typeof req.body?.dispatch_id === 'string' && req.body.dispatch_id
      ? req.body.dispatch_id
      : null;
    const upstreamQueryIdFromBody = typeof req.body?.query_id === 'string' && req.body.query_id
      ? req.body.query_id
      : null;
    const headerMatch = String(message).match(
      /\[dispatch_id:\s*(phid:disp-[a-z0-9]+)\][\s\S]*?\[query_id:\s*([^\]\s]+)\]/i,
    );
    const managerDispatchId = dispatchIdFromBody ?? headerMatch?.[1] ?? null;
    const managerQueryId = upstreamQueryIdFromBody ?? headerMatch?.[2] ?? null;

    const queryId = `query_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      await this.dbUpsertQuery({
        id: queryId,
        prompt: message,
        status: 'pending',
        created: Date.now(),
        sessionId: session_id,
        managerDispatchId,
        managerQueryId,
      });
    } catch (dbErr) { /* …existing warning… */ }

    /* …rest unchanged… */
  } catch (err) { /* … */ }
});
```

Extend `dbUpsertQuery` (line 336) to forward the new fields:

```typescript
private async dbUpsertQuery(query: ActiveQuery & {
  sessionId?: string;
  managerDispatchId?: string | null;
  managerQueryId?: string | null;
}) {
  if (!this.db || !this.dbTeamId || !this.dbAgentId) return;
  await this.db.queries.upsert(this.dbTeamId, this.dbAgentId, {
    query_id: query.id,
    status: query.status,
    /* …existing… */
    manager_dispatch_id: query.managerDispatchId ?? null,
    manager_query_id: query.managerQueryId ?? null,
  });
}
```

- [ ] **Step 4: Run integration tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/query-dispatch-projection.test.ts src/claude-agent-server.ts
git commit -m "feat(agent): persist manager dispatch metadata into queries row"
```

---

### Task 8: `/query/:id` response includes dispatch fields

**Files:**
- Modify: `src/agent-manager-db.ts` (the GET /query/:id handler — search for `getByQueryIdForTeam` callsites in that file)
- Test: `tests/integration/query-dispatch-projection.test.ts` (extend)

- [ ] **Step 1: Add failing assertion**

```typescript
// In the same describe block as Task 7
it("GET /query/:id returns dispatch_id + dispatch_status + agent_query_id when the query was dispatch-routed", async () => {
  /* setup as in Task 7 */
  const res = await fetch(`${managerBaseUrl}/query/${queryId}`, {
    headers: { 'X-Id-Team': TEAM },
  });
  const body = await res.json();
  expect(body.dispatch_id).toBe("phid:disp-abc");
  expect(body.agent_query_id).toBeTruthy();
  // dispatch_status maps from the dispatch row’s status, not the query row’s
  expect(["queued", "in_flight"]).toContain(body.dispatch_status);
});
```

- [ ] **Step 2: Run to confirm failure**

- [ ] **Step 3: Update the `/query/:id` handler**

Find the handler in `src/agent-manager-db.ts` (it lives near line 399 per the spec's anchor `/query/:id?wait=`). Add a side-lookup against the dispatch reactor when the query row has a `manager_dispatch_id`:

```typescript
// inside GET /query/:id handler
const row = await this.db.queries.getByQueryIdForTeam(teamId, req.params.id);
if (!row) return res.status(404).json({ error: 'not_found' });

let dispatchExt: Record<string, unknown> = {};
if (row.manager_dispatch_id && this.dispatchScheduler) {
  const doc = await this.dispatchScheduler.reactor.getByPhid(row.manager_dispatch_id);
  if (doc) {
    dispatchExt = {
      dispatch_id: doc.dispatch_phid,
      dispatch_status: doc.status,
      agent_query_id: doc.agent_query_id,
      manager_query_id: row.manager_query_id,
    };
  }
}
res.json({ ...mapQueryRow(row), ...dispatchExt });
```

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-manager-db.ts tests/integration/query-dispatch-projection.test.ts
git commit -m "feat(query): /query/:id projects dispatch fields when manager_dispatch_id is set"
```

---

### Task 9: Strict `/agent-done` mismatch handling

**Files:**
- Modify: `src/dispatch-scheduler/manager-integration.ts` (`handleAgentDone`)
- Modify: `src/agent-manager-db.ts` (the `/agent-done` route — search `managementApp.post('/agent-done'`)
- Test: `tests/integration/agent-done-strict-match.test.ts` (NEW)

⚠️ **Gated on open Q #7** — if Chris approves strict matching.

- [ ] **Step 1: Write the failing test**

```typescript
describe("POST /agent-done strict mismatch handling", () => {
  it("returns 409 when supplied dispatch_id and query_id resolve to different docs", async () => {
    const enqA = /* enqueue */;
    const enqB = /* enqueue */;
    const res = await fetch(`${baseUrl}/agent-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Id-Team": TEAM },
      body: JSON.stringify({
        dispatch_id: enqA.dispatch_phid,
        query_id: enqB.query_id,   // mismatched on purpose
        success: true,
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/mismatch/i);
  });

  it("returns 200 when dispatch_id and query_id resolve to the same doc", async () => {
    /* matching case */
  });
});
```

- [ ] **Step 2: Run to confirm failure**

- [ ] **Step 3: Update `handleAgentDone` to require id agreement**

```typescript
// src/dispatch-scheduler/manager-integration.ts inside handleAgentDone
let doc: DispatchDoc | null = null;
if (args.dispatch_id) {
  const r = await this.client.getByPhid(args.dispatch_id);
  if (r.ok) doc = r.value;
}
if (args.query_id) {
  const r2 = await this.client.getByQueryId(args.query_id);
  if (r2.ok && doc && r2.value.dispatch_phid !== doc.dispatch_phid) {
    throw new Error("agent_done: dispatch_id and query_id mismatch");
  }
  if (r2.ok && !doc) doc = r2.value;
}
if (!doc && args.agent_query_id) {
  doc = await this.reactor.getByAgentQueryId(args.agent_query_id);
}
if (!doc) return null;
/* …rest unchanged… */
```

Catch the thrown error in the `/agent-done` route and return 409.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(agent-done): strict dispatch_id/query_id mismatch -> 409"
```

---

### Task 10: Shadow mode + canonical mode flag

**Files:**
- Modify: `src/agent-manager-db.ts` (read `process.env.DISPATCH_CANONICAL_MODE`)
- Modify: `src/dispatch-scheduler/scheduler-service.ts` (no behavior change — just log mode on start)

- [ ] **Step 1: Add the env parse helper**

```typescript
// src/dispatch-scheduler/policy.ts or a small new helper file
export type DispatchCanonicalMode = "shadow" | "enforce";
export function parseDispatchCanonicalMode(env: NodeJS.ProcessEnv): DispatchCanonicalMode {
  const raw = (env.DISPATCH_CANONICAL_MODE ?? "shadow").toLowerCase();
  return raw === "enforce" ? "enforce" : "shadow";
}
```

- [ ] **Step 2: Use it in two places**

In `agent-manager-db.ts` startup, log `[Manager] dispatch_canonical_mode=<mode>`. In `/talk-to` direct path (when a Cane-style request hits the manager bypassing `/dispatch/enqueue`), warn `dispatch_canonical_skip_accept` when mode === enforce.

- [ ] **Step 3: Add a startup-log integration test**

```typescript
it("manager logs dispatch_canonical_mode on start", async () => {
  /* capture console.log via spy; boot manager; assert log contains "dispatch_canonical_mode=shadow" */
});
```

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(dispatch): DISPATCH_CANONICAL_MODE env flag + startup log"
```

---

### Task 11: Reconciliation read endpoint `GET /dispatches/reconcile`

**Files:**
- Modify: `src/dispatch-scheduler/read-model.ts` (add a reconciliation query)
- Modify: `src/agent-manager-db.ts` (mount the route)
- Test: `tests/integration/dispatch-reconcile.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```typescript
describe("GET /dispatches/reconcile", () => {
  it("lists dispatches stuck in queued where an agent query exists in processing/completed", async () => {
    /* setup: enqueue, leave queued, write a queries row with manager_dispatch_id and status=completed */
    const res = await fetch(`${baseUrl}/dispatches/reconcile`, { headers: { 'X-Id-Team': TEAM } });
    const body = await res.json();
    expect(body.stuck_queued).toHaveLength(1);
    expect(body.stuck_queued[0].dispatch_id).toBeTruthy();
    expect(body.stuck_queued[0].agent_query_status).toBe("completed");
  });

  it("lists dispatches done with no artifact in delivery log (best-effort detection)", async () => { /* … */ });
});
```

- [ ] **Step 2: Run to confirm failure**

- [ ] **Step 3: Implement the reconcile query**

```typescript
// src/dispatch-scheduler/read-model.ts
export async function readReconciliation(adapter: DbAdapterLike, teamId: string) {
  const { rows: stuckQueued } = await adapter.query(`
    SELECT d.dispatch_phid AS dispatch_id, q.status AS agent_query_status, q.query_id
      FROM dispatch_scheduler_queue d
      JOIN queries q ON q.manager_dispatch_id = d.dispatch_phid
     WHERE d.team_id = ? AND d.status = 'queued'
       AND q.status IN ('processing', 'completed')
  `, [teamId]);
  /* …add other diagnostics… */
  return { stuck_queued: stuckQueued };
}
```

Mount the route in `agent-manager-db.ts`.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(dispatch): GET /dispatches/reconcile diagnostic surface"
```

---

### Task 12: Cane side — handle delivery-failed (open Q #3 resolution)

**Files:**
- Modify: `taskview/cane_routing.py` (only if Chris approves option (a) or (b) in open Q #3)
- Test: `taskview/tests/test_dispatch_routing_failed_delivery.py` (NEW)

⚠️ **Skip if Chris confirms option (c) — leave current behavior.**

The Cane side already calls `/dispatches/:id/accept` on success; this task adds the failed-delivery branch.

- [ ] **Step 1: Add the failing python test**

```python
def test_cane_marks_dispatch_failed_on_offline_agent(monkeypatch):
    """When the agent /talk fails, Cane should mark the manager dispatch as
    delivery_failed (or bounced) per the policy decision, not leave it
    queued forever."""
    /* mock requests.post to raise ConnectionError on /talk */
    /* assert manager was called with markFailed or markBounced */
```

- [ ] **Step 2: Run to confirm failure**

- [ ] **Step 3: Add the failed-delivery POST in `_dispatch_to_agent`**

Per Chris's choice (open Q #3), call either `POST /dispatches/<phid>/markFailed` (if (a)) or `POST /dispatches/<phid>/markBounced` (if (b)). Both endpoints need adding manager-side — flag this as a follow-up task if not already on the manager.

- [ ] **Step 4: Commit**

```bash
git commit -am "fix(cane): mark dispatch failed on /talk delivery failure"
```

---

### Task 13: Final verification + promotion

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx tsc --noEmit
npm run build
npx vitest run
```

Expected: all gates green; 1380 + new test count, 0 failed.

- [ ] **Step 2: Run focused dispatch + lifecycle tests as the promote smoke**

```bash
npx vitest run \
  tests/unit/dispatch-scheduler-accept.test.ts \
  tests/unit/dispatch-scheduler-handle.test.ts \
  tests/integration/dispatch-canonical-lifecycle.test.ts \
  tests/integration/query-dispatch-projection.test.ts \
  tests/integration/agent-done-strict-match.test.ts \
  tests/integration/dispatch-reconcile.test.ts
```

- [ ] **Step 3: Push branch + promote-to-main per Spec 054 v2**

```bash
git push -u origin roger/dispatch-canonical-lifecycle
node dist/interactive-agent-cli.js promote-to-main \
  --repo /Users/kilgore/Dropbox/Code/cane/id-agents \
  --branch roger/dispatch-canonical-lifecycle \
  --base main \
  --remote origin \
  --strategy fast_forward \
  --dispatch-id <dispatch_id from /talk metadata> \
  --smoke "<the smoke command above>" \
  --execute --json
```

- [ ] **Step 4: Report via `/agent-done`** with the promotion block per the standard pattern.

---

## Self-review

**Spec coverage**

| Spec section | Tasks |
|---|---|
| Part 1: Scheduler queued → in_flight transition (acceptDispatchStart + routes) | 1, 2, 3, 4, 5 |
| Part 2: Cane pending v2 (already mostly landed on Cane side per spec validation) | 12 (only delivery-failed branch — current Cane v2 parser + writer + record/update shims already exist) |
| Part 3: Dispatch ID propagation in `/talk` metadata + agent-local persistence | 6, 7, 8 |
| Strict `/agent-done` mismatch | 9 |
| Shadow/enforce flag (reversible rollout) | 10 |
| Reconciliation surface | 11 |

**Coverage gaps & responses**

- Spec §"Closeout Propagation" — current `handleAgentDone` already accepts `dispatch_id`/`query_id`/`agent_query_id`. Task 9 tightens it; no new operations needed.
- Spec §"Manager Dispatch Doc-Model Treatment" — minimum fields list. All listed fields already exist on `DispatchDoc` (verified by reading `src/dispatch-scheduler/types.ts`). `operation_history[]` is the only one not separately stored; it lives implicitly in the `bounce_history` + `clarification_history` fields the spec already has. Tagged for follow-up if Chris wants a unified op-log; not blocking the canonical lifecycle.
- Spec §"Slice D: Reconciliation view" — Task 11 covers the minimum read.

**Placeholder scan** — searched the plan for "TBD", "TODO", "fill in", "implement later", "appropriate error handling" — none present in normative steps. Two open-question conditional tasks (9, 12) are explicitly flagged as gated decisions.

**Type consistency** — `acceptDispatchStart(phid, { agent_query_id })` signature is identical across `FakeReactor`, `SqliteDispatchReactor`, `DispatchDocClient`, and `SchedulerHandle.acceptDispatchStart({ dispatch_id, agent_query_id })` (handle resolves id form before calling client). New `QueryRow` fields `manager_dispatch_id` and `manager_query_id` use snake_case consistently across types, repo SQL, and the agent server upsert path.

---

## Execution handoff

Plan complete and saved to `/Users/kilgore/Dropbox/Code/cane/id-agents/docs/superpowers/plans/2026-06-10-dispatch-canonical.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task; two-stage review between tasks; fastest iteration on a 12+ task plan.
2. **Inline Execution** — executing-plans skill, batched with checkpoints. Better for the planner to keep full context across tasks.

**Recommended:** subagent-driven. Each task is self-contained (one storage layer, one route, one test file) so a fresh subagent doesn't need cross-task context. Phasing flag (Task 10) and reconciliation view (Task 11) can ship after a brief soak in shadow mode.

Per dispatch direction: **do NOT start the build yet** — wait for Chris's review of this plan and the seven open questions above.
