// T1.6 / R.4: the in-flight stale-expiry backstop uses a PER-RUNTIME inactivity
// cap. A claude-code-cli build can go quiet (thinking, long compile) for well
// over an hour and must not be false-expired; codex/cursor runs are shorter and
// a long silence is a more reliable wedge signal, so they get shorter caps.
// These tests drive the real SchedulerService.tick() through failStaleInFlight
// with the same fake reactor/evidence harness the stale-active fix uses.

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import { loadSchedulerPolicy } from "../../src/dispatch-scheduler/policy.js";
import { SchedulerService } from "../../src/dispatch-scheduler/scheduler-service.js";
import type {
  AgentTransport,
  AgentTransportResult,
  QueryEvidence,
  QueryEvidenceClient,
} from "../../src/dispatch-scheduler/scheduler-service.js";
import type {
  DispatchDoc,
  EnqueueInput,
  Provider,
  Runtime,
} from "../../src/dispatch-scheduler/types.js";

function baseFor(runtime: Runtime, provider: Provider): EnqueueInput {
  return {
    query_id: "q",
    to_agent: "coder-max",
    from_actor: "manager",
    channel: "dispatch",
    subject: "subj",
    body_markdown: "body",
    provider,
    runtime,
    priority: 5,
  };
}

class NoopTransport implements AgentTransport {
  async sendTalk(doc: DispatchDoc): Promise<AgentTransportResult> {
    return { ok: true, agent_query_id: `agent-${doc.query_id}` };
  }
}

class FakeQueryEvidence implements QueryEvidenceClient {
  private records = new Map<string, QueryEvidence>();
  set(agentQueryId: string, evidence: QueryEvidence): void {
    this.records.set(agentQueryId, evidence);
  }
  async getEvidence(agentQueryId: string): Promise<QueryEvidence | null> {
    return this.records.get(agentQueryId) ?? null;
  }
}

function harness(env: Record<string, string | undefined> = {}, start = "2026-06-15T20:00:00.000Z") {
  let now = start;
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  const queryEvidence = new FakeQueryEvidence();
  // The provider lanes the scheduler drains — include every lane under test so
  // each runtime's in-flight doc is swept.
  const scheduler = new SchedulerService({
    client,
    transport: new NoopTransport(),
    policy: loadSchedulerPolicy({}, env),
    providers: ["anthropic", "openai", "cursor"],
    now: () => now,
    rng: () => 0.5,
    queryEvidence,
  });
  const setNow = (next: string) => {
    now = next;
  };
  return { reactor, client, scheduler, queryEvidence, setNow };
}

async function claimInFlight(
  reactor: FakeReactor,
  client: DispatchDocClient,
  queryId: string,
  agentQueryId: string,
  runtime: Runtime,
  provider: Provider,
): Promise<string> {
  await client.enqueueDispatch({ ...baseFor(runtime, provider), query_id: queryId });
  const queued = await reactor.listQueued();
  const phid = queued.find((d) => d.query_id === queryId)!.dispatch_phid;
  await reactor.claim(phid);
  await reactor.recordAgentStart(phid, agentQueryId);
  return phid;
}

describe("per-runtime stale-in-flight expiry (T1.6 / R.4)", () => {
  it("does NOT false-expire a claude-code-cli dispatch idle 50 min (under its 90-min cap)", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness();
    const phid = await claimInFlight(
      reactor, client, "q-claude", "agent-claude", "claude-code-cli", "anthropic",
    );
    // 50 min since claim AND no progress for 50 min — past the OLD global 45-min
    // cap, but well under the claude-code-cli 90-min build window.
    setNow("2026-06-15T20:50:00.000Z");
    queryEvidence.set("agent-claude", { status: "processing", last_output_at: null });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(0);
    expect((await reactor.getByPhid(phid))?.status).toBe("in_flight");
  });

  it("DOES expire a codex dispatch idle 35 min (past its 30-min cap)", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness();
    const phid = await claimInFlight(
      reactor, client, "q-codex", "agent-codex", "codex", "openai",
    );
    setNow("2026-06-15T20:35:00.000Z"); // 35 min idle > 30-min codex cap
    queryEvidence.set("agent-codex", { status: "processing", last_output_at: null });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(1);
    expect((await reactor.getByPhid(phid))?.status).toBe("failed");
  });

  it("DOES expire a cursor-cli dispatch idle 30 min (past its 25-min cap)", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness();
    const phid = await claimInFlight(
      reactor, client, "q-cursor", "agent-cursor", "cursor-cli", "cursor",
    );
    setNow("2026-06-15T20:30:00.000Z"); // 30 min idle > 25-min cursor cap
    queryEvidence.set("agent-cursor", { status: "processing", last_output_at: null });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(1);
    expect((await reactor.getByPhid(phid))?.status).toBe("failed");
  });

  it("never expires an actively-producing claude build, even past 90 min", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness();
    const phid = await claimInFlight(
      reactor, client, "q-active", "agent-active", "claude-code-cli", "anthropic",
    );
    setNow("2026-06-15T21:40:00.000Z"); // 100 min since claim
    queryEvidence.set("agent-active", {
      status: "processing",
      last_output_at: Date.parse("2026-06-15T21:39:00.000Z"), // output 1 min ago
    });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(0);
    expect((await reactor.getByPhid(phid))?.status).toBe("in_flight");
  });

  it("a per-runtime env override changes the cap and the scheduler honors it", async () => {
    // Lower the claude-code-cli cap to 20 min via env; a 25-min-idle claude
    // dispatch that would normally survive (90-min default) now expires.
    const env = { DISPATCH_STALE_IN_FLIGHT_TTL_MS_CLAUDE_CODE_CLI: String(20 * 60_000) };
    const { reactor, client, scheduler, queryEvidence, setNow } = harness(env);
    const phid = await claimInFlight(
      reactor, client, "q-claude-env", "agent-claude-env", "claude-code-cli", "anthropic",
    );
    setNow("2026-06-15T20:25:00.000Z"); // 25 min idle > 20-min override
    queryEvidence.set("agent-claude-env", { status: "processing", last_output_at: null });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(1);
    expect((await reactor.getByPhid(phid))?.status).toBe("failed");
  });
});
