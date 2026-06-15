// fix/dispatch-expiry-too-aggressive (2026-06-15): the age-based
// failStaleInFlight sweep was hard-failing dispatches purely on wall-clock age
// since claim, ignoring B1 progress evidence (queries.last_output_at). That
// silently killed legitimate long work (the W2-1 build, the COBRA research)
// while the agent was STILL actively producing output. The fix makes the sweep
// activity-aware: it measures inactivity from the last sign of progress, not
// raw claim age, so an actively-producing dispatch never expires — only true
// inactivity (no progress for the TTL window) does.

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
import type { DispatchDoc, EnqueueInput } from "../../src/dispatch-scheduler/types.js";

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

function harness(start = "2026-06-15T20:00:00.000Z") {
  let now = start;
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  const queryEvidence = new FakeQueryEvidence();
  const scheduler = new SchedulerService({
    client,
    transport: new NoopTransport(),
    policy: loadSchedulerPolicy({}, {}),
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
): Promise<string> {
  await client.enqueueDispatch({ ...base, query_id: queryId });
  const queued = await reactor.listQueued();
  const phid = queued.find((d) => d.query_id === queryId)!.dispatch_phid;
  await reactor.claim(phid);
  await reactor.recordAgentStart(phid, agentQueryId);
  return phid;
}

describe("fix: in-flight stale expiry must not kill ACTIVE long work", () => {
  it("does NOT expire a long-running dispatch that is still actively producing output", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness(
      "2026-06-15T20:00:00.000Z",
    );
    const phid = await claimInFlight(reactor, client, "q-active", "agent-active");

    // 50 minutes since claim — PAST the 45-minute stale_in_flight_ttl_ms — but
    // the agent emitted output 1 minute ago: it is alive, not wedged.
    setNow("2026-06-15T20:50:00.000Z");
    queryEvidence.set("agent-active", {
      status: "processing",
      last_output_at: Date.parse("2026-06-15T20:49:00.000Z"),
    });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.evidence_silence_bounced).toBe(0);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("in_flight");
  });

  it("STILL fails a dispatch that has produced no progress for the whole TTL window", async () => {
    const { reactor, client, scheduler, queryEvidence, setNow } = harness(
      "2026-06-15T20:00:00.000Z",
    );
    const phid = await claimInFlight(reactor, client, "q-wedged", "agent-wedged");

    // Claimed 50 minutes ago (past the TTL) and never produced a last_output_at — the
    // process-died-at-startup case failStaleInFlight is the backstop for.
    setNow("2026-06-15T20:50:00.000Z");
    queryEvidence.set("agent-wedged", {
      status: "processing",
      last_output_at: null,
    });

    const report = await scheduler.tick();

    expect(report.stale_in_flight_failed).toBe(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("failed");
  });
});
