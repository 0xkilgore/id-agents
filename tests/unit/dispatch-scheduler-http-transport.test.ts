// Phase 4.1b TDD: HttpAgentTransport — the only production /talk caller.
//
// We mock global fetch so we can assert call shape + verify the HTTP
// semantics map cleanly to AgentTransportResult shape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpAgentTransport } from "../../src/dispatch-scheduler/http-agent-transport.js";
import type { DispatchDoc } from "../../src/dispatch-scheduler/types.js";

const doc: DispatchDoc = {
  dispatch_phid: "phid:abc",
  query_id: "q",
  to_agent: "coder-max",
  from_actor: "manager",
  channel: "dispatch",
  subject: "hi",
  body_markdown: "hello there",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
  status: "in_flight",
  not_before_at: "2026-05-19T20:00:00.000Z",
  attempt_count: 1,
  bounce_count: 0,
  last_bounce: null,
  bounce_history: [],
  started_at: "2026-05-19T20:00:00.000Z",
  completed_at: null,
  updated_at: "2026-05-19T20:00:00.000Z",
  agent_query_id: null,
  usage_policy_snapshot: null,
  failure_kind: null,
  failure_detail: null,
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("HttpAgentTransport.sendTalk", () => {
  it("posts message + from to ${target}/talk and returns the agent_query_id", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent_query_id).toBe("agent-q-123");
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:5500/talk");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // Spec 054 v2 review fix: original body content is preserved and
    // prepended with a visible dispatch metadata block so plain-text
    // agent contexts can read dispatch_id from the prompt.
    expect(body.message).toContain("hello there");
    expect(body.message).toMatch(/\[dispatch_id: phid:abc\]/);
    expect(body.message).toMatch(/\[query_id: q\]/);
    expect(body.from).toBe("manager");
  });

  // Spec 054 v2 review fix guard: scheduler-launched /talk MUST carry
  // canonical dispatch metadata so the agent can call /agent-needs-input
  // with a real dispatch_id when blocked. These tests fail the build if
  // either field is dropped from the JSON payload or the visible header.
  it("guard: JSON body always includes dispatch_id and query_id", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    await transport.sendTalk(doc);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.dispatch_id).toBe("phid:abc");
    expect(body.query_id).toBe("q");
  });

  it("guard: metadata block is the first thing in the message body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    await transport.sendTalk(doc);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // metadata header lines come BEFORE the original body_markdown
    expect(body.message.startsWith("[dispatch_id: phid:abc]")).toBe(true);
    // original body_markdown is preserved verbatim after the header
    expect(body.message.endsWith("hello there")).toBe(true);
  });

  it("strips trailing slashes from target URL", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "x" }), { status: 200 }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500///",
    });
    await transport.sendTalk(doc);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:5500/talk");
  });

  it("missing target URL surfaces as cause:http", async () => {
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => null,
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("http");
      expect(r.body).toContain("coder-max");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 429 maps to {ok:false, status:429} with body for classifier", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("rate_limit_exceeded", { status: 429 }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.body).toContain("rate_limit_exceeded");
      expect(r.cause).toBe("http");
    }
  });

  it("HTTP 200 with no query_id is a wedged start (ok:true + empty agent_query_id)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent_query_id).toBe("");
  });

  it("network error maps to cause:transport with retryable semantics", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("transport");
      expect(r.transportError).toContain("ECONNREFUSED");
    }
  });

  it("non-JSON response maps to cause:http (agent_error semantics)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("<html>unexpected</html>", { status: 200 }) as unknown as Response,
    );
    const transport = new HttpAgentTransport({
      resolveTargetUrl: () => "http://localhost:5500",
    });
    const r = await transport.sendTalk(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("http");
      expect(r.body).toContain("non-json");
    }
  });
});
