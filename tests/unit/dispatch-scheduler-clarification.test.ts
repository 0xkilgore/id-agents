// Spec 054 v2 - SqliteDispatchReactor clarification lifecycle tests.
// Covers:
//   - markNeedsClarification releases the active slot (concurrency snapshot drops)
//   - idempotency within a 5 minute window (same agent + same question)
//   - different question appends a new event and replaces the active blocker
//   - resumeAfterClarification moves dispatch back to queued + preserves history
//   - markResumeDelivered + markResumeDeliveryFailed branches
//   - markClarificationStale appends event without changing status
//   - listOpenClarifications filters by stale_at when staleOnly=true
//   - terminal dispatches reject markNeedsClarification / resumeAfterClarification

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteDispatchReactor } from "../../src/dispatch-scheduler/sqlite-dispatch-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const base: EnqueueInput = {
  query_id: "q-clar-1",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "promote doc-history",
  body_markdown: "do the thing",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "clar-test-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team-c', 'test')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function harness(now = "2026-05-21T10:00:00.000Z") {
  const reactor = new SqliteDispatchReactor({
    adapter,
    teamId: "team-c",
    now: () => now,
  });
  return reactor;
}

async function enqueueAndStart(reactor: SqliteDispatchReactor, input = base) {
  const doc = await reactor.enqueue(input);
  const { claimed } = await reactor.claim({ max_in_flight: 10 });
  expect(claimed.length).toBe(1);
  return doc;
}

describe("markNeedsClarification", () => {
  it("pauses an in_flight dispatch and persists the active blocker", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);

    const { doc: paused, clarification_id, idempotent } = await reactor.markNeedsClarification(
      enq.dispatch_phid,
      {
        agent_id: "roger",
        question: "Should I squash the 26 commits?",
        context: { ahead: 26 },
        urgency: "normal",
      },
    );

    expect(idempotent).toBe(false);
    expect(clarification_id).toMatch(/^clar_/);
    expect(paused.status).toBe("needs_clarification");
    expect(paused.active_clarification).not.toBeNull();
    expect(paused.active_clarification?.question).toBe("Should I squash the 26 commits?");
    expect(paused.active_clarification?.agent_id).toBe("roger");
    expect(paused.active_clarification?.stale_at).toBeTruthy();
    expect(paused.clarification_history).toHaveLength(1);
    expect(paused.clarification_history[0].type).toBe("NEEDS_CLARIFICATION");
  });

  it("releases the active scheduler slot (concurrencySnapshot in_flight drops)", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);

    const before = await reactor.snapshot({ max_safe: 3 });
    expect(before.in_flight).toBe(1);

    await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });

    const after = await reactor.snapshot({ max_safe: 3 });
    expect(after.in_flight).toBe(0);
  });

  it("is idempotent for same agent + same question within 5 min window", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const first = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "same?",
    });
    const second = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "same?",
    });
    expect(second.idempotent).toBe(true);
    expect(second.clarification_id).toBe(first.clarification_id);
    expect(second.doc.clarification_history).toHaveLength(1);
  });

  it("different question replaces the active blocker and appends a new event", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const first = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "first?",
    });
    const second = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "second?",
    });
    expect(second.idempotent).toBe(false);
    expect(second.clarification_id).not.toBe(first.clarification_id);
    expect(second.doc.active_clarification?.question).toBe("second?");
    expect(second.doc.clarification_history).toHaveLength(2);
  });

  it("rejects markNeedsClarification on terminal dispatch", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    await reactor.markDone(enq.dispatch_phid);
    await expect(
      reactor.markNeedsClarification(enq.dispatch_phid, {
        agent_id: "roger",
        question: "?",
      }),
    ).rejects.toThrow(/terminal done/i);
  });
});

describe("resumeAfterClarification", () => {
  it("requeues a paused dispatch, closes the active blocker, appends RESUME", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const paused = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });

    const resumed = await reactor.resumeAfterClarification(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      actor: "manager",
      answer: "Squash autocommit-heavy branches",
      instructions: ["one repo at a time"],
    });

    expect(resumed.status).toBe("queued");
    expect(resumed.active_clarification).toBeNull();
    expect(resumed.clarification_id).toBeNull();
    expect(resumed.resume_delivery_status).toBe("pending");
    expect(resumed.clarification_history).toHaveLength(2);
    expect(resumed.clarification_history[1].type).toBe("RESUME");
    expect(resumed.clarification_history[1].answer).toBe("Squash autocommit-heavy branches");
  });

  it("rejects resume when dispatch is not in needs_clarification", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    await expect(
      reactor.resumeAfterClarification(enq.dispatch_phid, {
        answer: "n/a",
      }),
    ).rejects.toThrow(/requires needs_clarification/);
  });

  it("rejects mismatched clarification_id", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });
    await expect(
      reactor.resumeAfterClarification(enq.dispatch_phid, {
        clarification_id: "clar_wrong",
        answer: "n/a",
      }),
    ).rejects.toThrow(/mismatch/);
  });
});

describe("markResumeDelivered / markResumeDeliveryFailed", () => {
  it("delivered path sets status=delivered + records new agent_query_id", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const paused = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });
    await reactor.resumeAfterClarification(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      answer: "go",
    });
    const after = await reactor.markResumeDelivered(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      transport: "talk_followup",
      agent_query_id: "q-resume-1",
    });
    expect(after.resume_delivery_status).toBe("delivered");
    expect(after.agent_query_id).toBe("q-resume-1");
    expect(after.clarification_history.some((e) => e.type === "RESUME_DELIVERED")).toBe(true);
  });

  it("failed path moves status=resume_delivery_failed and is non-claimable", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const paused = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });
    await reactor.resumeAfterClarification(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      answer: "go",
    });
    const after = await reactor.markResumeDeliveryFailed(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      failure_detail: "agent process not running",
    });
    expect(after.status).toBe("resume_delivery_failed");
    expect(after.resume_delivery_status).toBe("failed");
    expect(after.failure_detail).toBe("agent process not running");

    const claim = await reactor.claim({ max_in_flight: 10 });
    expect(claim.claimed.find((d) => d.dispatch_phid === enq.dispatch_phid)).toBeUndefined();
  });
});

describe("markClarificationStale + listOpenClarifications", () => {
  it("appends STALE without changing status", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    const paused = await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });
    const after = await reactor.markClarificationStale(enq.dispatch_phid, {
      clarification_id: paused.clarification_id,
      age_seconds: 7200,
    });
    expect(after.status).toBe("needs_clarification"); // unchanged
    expect(after.clarification_history.some((e) => e.type === "CLARIFICATION_STALE")).toBe(true);
  });

  it("listOpenClarifications returns paused docs", async () => {
    const reactor = harness();
    const enq = await enqueueAndStart(reactor);
    await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });
    const open = await reactor.listOpenClarifications();
    expect(open.length).toBe(1);
    expect(open[0].dispatch_phid).toBe(enq.dispatch_phid);
  });

  it("listOpenClarifications staleOnly=true filters to past-deadline blockers", async () => {
    const reactor = harness("2026-05-21T10:00:00.000Z");
    const enq = await enqueueAndStart(reactor);
    // Default stale window is 2h. At t=10:00 the stale_at will be 12:00.
    await reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "roger",
      question: "?",
    });

    // Fresh: nothing stale.
    expect(await reactor.listOpenClarifications({ staleOnly: true })).toHaveLength(0);

    // Time-travel past stale_at:
    expect(
      await reactor.listOpenClarifications({
        staleOnly: true,
        now: "2026-05-21T13:00:00.000Z",
      }),
    ).toHaveLength(1);
  });
});
