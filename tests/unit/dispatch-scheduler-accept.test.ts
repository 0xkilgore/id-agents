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
