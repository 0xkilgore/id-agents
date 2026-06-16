// D1 / BUG-003 regression: a provider_rate_limit_exhausted failure must back off
// on the SAME provider — never an immediate (< 30s) retry that cascades against
// the already-throttled provider. This drives the real SchedulerService.tick()
// through the wired retry-policy and asserts the backoff window grows 30s → 60s.

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import { loadSchedulerPolicy } from "../../src/dispatch-scheduler/policy.js";
import { SchedulerService } from "../../src/dispatch-scheduler/scheduler-service.js";
import type {
  AgentTransport,
  AgentTransportResult,
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

class RateLimitTransport implements AgentTransport {
  calls = 0;
  async sendTalk(_doc: DispatchDoc): Promise<AgentTransportResult> {
    this.calls += 1;
    return { ok: false, status: 429, body: "rate_limit_exceeded" };
  }
}

function harness(startIso: string) {
  const reactor = new FakeReactor({ now: () => reactor.now() });
  const client = new DispatchDocClient({ reactor, now: () => reactor.now() });
  const transport = new RateLimitTransport();
  const scheduler = new SchedulerService({
    client,
    transport,
    policy: loadSchedulerPolicy({}, {}),
    now: () => reactor.now(),
    rng: () => 0.5,
  });
  reactor.setNow(startIso);
  return { reactor, client, transport, scheduler };
}

const SECS = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;

describe("BUG-003 regression: provider rate-limit retry backs off (never < 30s)", () => {
  it("first rate-limit failure bounces with a >= 30s window (exactly 30s)", async () => {
    const t0 = "2026-06-16T20:00:00.000Z";
    const { reactor, client, scheduler } = harness(t0);
    await client.enqueueDispatch(base);

    const report = await scheduler.tick();
    expect(report.bounced).toBe(1);
    expect(report.started).toBe(0);

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
    expect(doc.value.last_bounce?.kind).toBe("provider_throttle");
    // The core BUG-003 invariant: the next attempt is at least 30s out.
    expect(SECS(reactor.now(), doc.value.not_before_at)).toBeGreaterThanOrEqual(30);
    expect(SECS(reactor.now(), doc.value.not_before_at)).toBe(30);
  });

  it("does NOT retry within the < 30s window", async () => {
    const t0 = "2026-06-16T20:00:00.000Z";
    const { reactor, client, transport, scheduler } = harness(t0);
    await client.enqueueDispatch(base);
    await scheduler.tick(); // bounced, not_before_at = t0 + 30s
    expect(transport.calls).toBe(1);

    // Advance only 29s — still inside the backoff window.
    reactor.setNow("2026-06-16T20:00:29.000Z");
    const report = await scheduler.tick();
    expect(report.requeued).toBe(0); // no re-fire
    expect(transport.calls).toBe(1); // provider was NOT hit again
    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
  });

  it("second rate-limit failure doubles the window to 60s", async () => {
    const t0 = "2026-06-16T20:00:00.000Z";
    const { reactor, client, scheduler } = harness(t0);
    await client.enqueueDispatch(base);

    // First failure → 30s window.
    await scheduler.tick();
    const first = await client.getByQueryId("q");
    if (!first.ok) throw new Error();
    expect(SECS(t0, first.value.not_before_at)).toBe(30);

    // Step past the 30s window; the requeue re-fires, hits 429 again →
    // second bounce with a 60s window measured from the new now.
    const t1 = "2026-06-16T20:00:31.000Z";
    reactor.setNow(t1);
    const report = await scheduler.tick();
    expect(report.requeued).toBe(1);

    const second = await client.getByQueryId("q");
    if (!second.ok) throw new Error();
    expect(second.value.status).toBe("bounced");
    expect(second.value.attempt_count).toBe(2);
    expect(SECS(t1, second.value.not_before_at)).toBe(60); // doubled
    expect(SECS(t1, second.value.not_before_at)).toBeGreaterThanOrEqual(30);
  });
});
