// Phase 4.1 TDD: SqliteDispatchReactor parity with FakeReactor.
//
// The same DispatchDocClient + lifecycle contract that passes against
// FakeReactor must pass against the SQLite-backed canonical store.
// This is the proof that swapping in the production reactor doesn't
// change scheduler behaviour.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "coder-max",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-sqlite-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  // Seed enough schema for our table (the migration creates teams etc.
  // We don't need them for the queue, but the script CREATE-IF-NOT-EXISTS
  // is idempotent and self-contained.)
  await migrateSqlite(adapter);
  // Seed a fake team so FK-less inserts succeed (our table doesn't FK
  // team_id, but inserts still need a value).
  await adapter.query(
    `INSERT INTO teams (id, name) VALUES ('team-test', 'test')`,
  );
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(now = "2026-05-19T20:00:00.000Z") {
  const reactor = new SqliteDispatchReactor({
    adapter,
    teamId: "team-test",
    now: () => now,
  });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

describe("SqliteDispatchReactor — round-trip parity with FakeReactor", () => {
  it("enqueue → claim → done", async () => {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    expect(enq.value.status).toBe("queued");
    expect(enq.value.dispatch_phid).toMatch(/^phid:/);

    const claim = await client.claimForStart({ limit: 1 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.value).toHaveLength(1);
    expect(claim.value[0].status).toBe("in_flight");
    expect(claim.value[0].attempt_count).toBe(1);

    const done = await client.markDone(claim.value[0].dispatch_phid);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.status).toBe("done");
  });

  it("queued → in_flight → bounced → queued → in_flight → done preserves single canonical doc", async () => {
    const { client, reactor } = harness("2026-05-19T20:00:00.000Z");
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const phid = enq.value.dispatch_phid;

    const claim1 = await client.claimForStart({ limit: 1 });
    if (!claim1.ok) throw new Error();
    await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:05:00.000Z",
    });
    const bounced = await client.getByQueryId("q");
    if (!bounced.ok) throw new Error();
    expect(bounced.value.status).toBe("bounced");

    reactor.setNow("2026-05-19T20:06:00.000Z");
    const requeued = await client.requeueAfterBounce(phid);
    if (!requeued.ok) throw new Error();
    expect(requeued.value.status).toBe("queued");

    const claim2 = await client.claimForStart({
      limit: 1,
      now: "2026-05-19T20:06:00.000Z",
    });
    if (!claim2.ok) throw new Error();
    expect(claim2.value[0].dispatch_phid).toBe(phid);
    expect(claim2.value[0].attempt_count).toBe(2);

    const done = await client.markDone(phid);
    if (!done.ok) throw new Error();
    expect(done.value.status).toBe("done");
  });

  it("priority order: high first", async () => {
    const { client } = harness();
    await client.enqueueDispatch({ ...base, query_id: "low", priority: 1 });
    await client.enqueueDispatch({ ...base, query_id: "high", priority: 9 });
    await client.enqueueDispatch({ ...base, query_id: "mid", priority: 5 });
    const claim = await client.claimForStart({ limit: 3 });
    if (!claim.ok) throw new Error();
    expect(claim.value.map((d) => d.query_id)).toEqual(["high", "mid", "low"]);
  });

  it("not_before_at gates claim eligibility", async () => {
    const { client, reactor } = harness("2026-05-19T20:00:00.000Z");
    await client.enqueueDispatch({
      ...base,
      query_id: "later",
      not_before_at: "2026-05-19T20:10:00.000Z",
    });
    await client.enqueueDispatch({ ...base, query_id: "now" });
    const claim1 = await client.claimForStart({ limit: 2 });
    if (!claim1.ok) throw new Error();
    expect(claim1.value.map((d) => d.query_id)).toEqual(["now"]);

    reactor.setNow("2026-05-19T20:15:00.000Z");
    const claim2 = await client.claimForStart({
      limit: 2,
      now: "2026-05-19T20:15:00.000Z",
    });
    if (!claim2.ok) throw new Error();
    expect(claim2.value.map((d) => d.query_id)).toEqual(["later"]);
  });

  it("max_in_flight enforces atomic cap across calls", async () => {
    const { client } = harness();
    for (let i = 0; i < 5; i++) {
      await client.enqueueDispatch({ ...base, query_id: `q-${i}` });
    }
    const claim1 = await client.claimForStart({ limit: 5, max_in_flight: 3 });
    if (!claim1.ok) throw new Error();
    expect(claim1.value).toHaveLength(3);
    // Already at cap; a second claim should yield zero.
    const claim2 = await client.claimForStart({ limit: 5, max_in_flight: 3 });
    if (!claim2.ok) throw new Error();
    expect(claim2.value).toHaveLength(0);
  });

  it("cancel terminates from queued, in_flight, and bounced", async () => {
    const { client } = harness();
    const a = await client.enqueueDispatch({ ...base, query_id: "a" });
    if (!a.ok) throw new Error();
    const cancelA = await client.cancel(a.value.dispatch_phid, "no longer needed");
    if (!cancelA.ok) throw new Error();
    expect(cancelA.value.status).toBe("cancelled");

    const b = await client.enqueueDispatch({ ...base, query_id: "b" });
    if (!b.ok) throw new Error();
    const claimedB = await client.claimForStart({ limit: 1 });
    if (!claimedB.ok) throw new Error();
    const cancelB = await client.cancel(claimedB.value[0].dispatch_phid, "kill");
    if (!cancelB.ok) throw new Error();
    expect(cancelB.value.status).toBe("cancelled");

    const c = await client.enqueueDispatch({ ...base, query_id: "c" });
    if (!c.ok) throw new Error();
    const claimedC = await client.claimForStart({ limit: 1 });
    if (!claimedC.ok) throw new Error();
    await client.markBounced(claimedC.value[0].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T21:00:00.000Z",
    });
    const cancelC = await client.cancel(claimedC.value[0].dispatch_phid, "abort");
    if (!cancelC.ok) throw new Error();
    expect(cancelC.value.status).toBe("cancelled");
  });

  it("concurrencySnapshot counts only slot-occupying docs as in_flight", async () => {
    const { client } = harness();
    await client.enqueueDispatch({ ...base, query_id: "a" });
    await client.enqueueDispatch({ ...base, query_id: "b" });
    const c = await client.enqueueDispatch({ ...base, query_id: "c" });
    if (!c.ok) throw new Error();
    const d = await client.enqueueDispatch({ ...base, query_id: "d" });
    if (!d.ok) throw new Error();
    const claimed = await client.claimForStart({ limit: 4 });
    if (!claimed.ok) throw new Error();
    await client.markDone(claimed.value[2].dispatch_phid);
    await client.markBounced(claimed.value[3].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T21:00:00.000Z",
    });
    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.in_flight).toBe(2);
    expect(snap.value.available_slots).toBe(1);
  });

  it("persists across reactor instances (restart-safety check)", async () => {
    const { client } = harness();
    await client.enqueueDispatch({ ...base, query_id: "persisted" });

    // Spin up a fresh reactor against the same adapter (simulates restart).
    const reactor2 = new SqliteDispatchReactor({
      adapter,
      teamId: "team-test",
      now: () => "2026-05-19T20:00:00.000Z",
    });
    const client2 = new DispatchDocClient({
      reactor: reactor2,
      now: () => "2026-05-19T20:00:00.000Z",
    });
    const fetched = await client2.getByQueryId("persisted");
    if (!fetched.ok) throw new Error();
    expect(fetched.value.status).toBe("queued");
    expect(fetched.value.query_id).toBe("persisted");
  });

  it("getByAgentQueryId resolves the canonical doc for /agent-done routing", async () => {
    const { client, reactor } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const phid = enq.value.dispatch_phid;
    await client.claimForStart({ limit: 1 });
    await client.recordAgentStart(phid, "agent-q-xyz");
    const found = await reactor.getByAgentQueryId("agent-q-xyz");
    expect(found?.dispatch_phid).toBe(phid);
  });

  it("acceptDispatchStart moves queued dispatch to in_flight with agent_query_id", async () => {
    const { client, reactor } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();

    const accepted = await reactor.acceptDispatchStart(enq.value.dispatch_phid, {
      agent_query_id: "agent-q-direct",
    });

    expect(accepted?.status).toBe("in_flight");
    expect(accepted?.agent_query_id).toBe("agent-q-direct");
    expect(accepted?.attempt_count).toBe(1);
    expect(accepted?.started_at).not.toBeNull();
  });

  it("acceptDispatchStart is idempotent for the same agent_query_id and conflicts on a different one", async () => {
    const { client, reactor } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();

    await reactor.acceptDispatchStart(enq.value.dispatch_phid, {
      agent_query_id: "agent-q-direct",
    });
    const second = await reactor.acceptDispatchStart(enq.value.dispatch_phid, {
      agent_query_id: "agent-q-direct",
    });
    expect(second?.status).toBe("in_flight");

    await expect(
      reactor.acceptDispatchStart(enq.value.dispatch_phid, {
        agent_query_id: "agent-q-other",
      }),
    ).rejects.toThrow(/conflict|agent_query_id/i);
  });

  it("markDoneWithResult stashes the agent reply payload for /talk-to waiters", async () => {
    const { client, reactor } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const phid = enq.value.dispatch_phid;
    await client.claimForStart({ limit: 1 });
    await client.recordAgentStart(phid, "agent-q-1");
    await reactor.markDoneWithResult(phid, { reply: "all done", tokens: 42 });
    const result = await reactor.getResult(phid);
    expect(result).toEqual({ reply: "all done", tokens: 42 });
  });

  it("two-team isolation: same query_id in different teams does not collide", async () => {
    const { client } = harness();
    await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-other', 'other')`);
    const reactor2 = new SqliteDispatchReactor({
      adapter,
      teamId: "team-other",
      now: () => "2026-05-19T20:00:00.000Z",
    });
    const client2 = new DispatchDocClient({
      reactor: reactor2,
      now: () => "2026-05-19T20:00:00.000Z",
    });
    await client.enqueueDispatch({ ...base, query_id: "same" });
    await client2.enqueueDispatch({ ...base, query_id: "same" });

    const a = await client.getByQueryId("same");
    const b = await client2.getByQueryId("same");
    if (!a.ok || !b.ok) throw new Error();
    expect(a.value.dispatch_phid).not.toBe(b.value.dispatch_phid);
  });

  it("graph-blocked dispatch is skipped by claim selection (N1.2)", async () => {
    const { client } = harness();

    // Enqueue two dispatches.
    const freeEnq = await client.enqueueDispatch({ ...base, query_id: "free" });
    const blockedEnq = await client.enqueueDispatch({ ...base, query_id: "blocked" });
    if (!freeEnq.ok || !blockedEnq.ok) throw new Error();

    // Insert a graph node marking the blocked dispatch as pending_dependencies.
    // The graph tables are created by migrateSqlite; insert directly.
    const graphId = "graph-test-block";
    await adapter.query(
      `INSERT INTO dispatch_graph (graph_id, title, status, version, created_by_actor_json, created_at)
       VALUES (?, 'block-test', 'active', 1, '{}', '2026-05-29T00:00:00Z')`,
      [graphId],
    );
    await adapter.query(
      `INSERT INTO dispatch_graph_node (node_id, graph_id, title, kind, dispatch_id, state)
       VALUES (?, ?, 'Blocked Node', 'dispatch', ?, 'pending_dependencies')`,
      ["node-blocked", graphId, blockedEnq.value.dispatch_phid],
    );

    // Claim: only the free dispatch should be claimed; the graph-blocked one is skipped.
    const claim = await client.claimForStart({ limit: 10 });
    if (!claim.ok) throw new Error();
    expect(claim.value).toHaveLength(1);
    expect(claim.value[0].dispatch_phid).toBe(freeEnq.value.dispatch_phid);

    // After removing the graph block (transition to queued), the dispatch becomes claimable.
    await adapter.query(
      `UPDATE dispatch_graph_node SET state = 'queued' WHERE node_id = ?`,
      ["node-blocked"],
    );
    const claim2 = await client.claimForStart({ limit: 10 });
    if (!claim2.ok) throw new Error();
    expect(claim2.value).toHaveLength(1);
    expect(claim2.value[0].dispatch_phid).toBe(blockedEnq.value.dispatch_phid);
  });
});
