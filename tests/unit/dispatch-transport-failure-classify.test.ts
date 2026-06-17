// Transport-exhaustion classification: a manager↔agent "fetch failed" must NOT
// be mislabeled provider_rate_limit_exhausted (the Sentinel mislabel that made a
// localhost connectivity failure look like an Anthropic 429 → "session bloat").

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import { exhaustedFailureKind, type EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "sentinel",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

function harness(now = "2026-06-17T20:00:00.000Z") {
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

describe("exhaustedFailureKind", () => {
  it("labels a transport bounce as agent-unreachable, not a rate limit", () => {
    expect(exhaustedFailureKind("transport")).toBe("agent_unreachable_exhausted");
  });
  it("keeps the rate-limit bucket for provider throttle and unknowns", () => {
    expect(exhaustedFailureKind("provider_rate_limit")).toBe("provider_rate_limit_exhausted");
    expect(exhaustedFailureKind("provider_throttle")).toBe("provider_rate_limit_exhausted");
    expect(exhaustedFailureKind(null)).toBe("provider_rate_limit_exhausted");
    expect(exhaustedFailureKind(undefined)).toBe("provider_rate_limit_exhausted");
  });
});

describe("markRetryExhausted honours the last bounce kind", () => {
  async function exhaustWithBounceKind(kind: string): Promise<string | null> {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error("enqueue failed");
    const phid = enq.value.dispatch_phid;
    await client.markBounced(phid, { kind, message: "x", next_attempt_at: "2026-06-17T20:04:00.000Z" });
    const ex = await client.markRetryExhausted(phid, `${kind} after 5 attempts`);
    if (!ex.ok) throw new Error("markRetryExhausted failed");
    return ex.value.failure_kind;
  }

  it("transport exhaustion → agent_unreachable_exhausted (NOT provider_rate_limit_exhausted)", async () => {
    expect(await exhaustWithBounceKind("transport")).toBe("agent_unreachable_exhausted");
  });

  it("provider-throttle exhaustion → provider_rate_limit_exhausted (unchanged)", async () => {
    expect(await exhaustWithBounceKind("provider_rate_limit")).toBe("provider_rate_limit_exhausted");
  });
});
