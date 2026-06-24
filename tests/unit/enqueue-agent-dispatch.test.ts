// AP8 (AGENT-V2) — the agent-detail composer's thin POST client. Verifies it
// targets /dispatch/enqueue with the JSON body and surfaces the manager's typed
// errors (HTTP 4xx/5xx OR { ok:false, error }) as thrown Errors.

import { describe, it, expect, vi, afterEach } from "vitest";
import { enqueueAgentDispatch } from "../../src/tui/api/manager.js";
import type { EnqueueDispatchBody } from "../../src/tui/api/dispatch-compose.js";

const BODY: EnqueueDispatchBody = {
  to_agent: "roger",
  message: "build AP8",
  actor_ref: "user:chris",
};

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enqueueAgentDispatch", () => {
  it("POSTs the JSON body to /dispatch/enqueue and returns the response", async () => {
    const spy = mockFetch(
      () => new Response(JSON.stringify({ ok: true, dispatch_id: "phid:disp-abc123" }), { status: 200 }),
    );
    const res = await enqueueAgentDispatch("http://mgr", BODY);
    expect(res.dispatch_id).toBe("phid:disp-abc123");

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://mgr/dispatch/enqueue");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it("throws the manager's typed error on { ok:false }", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ok: false, error: "unknown actor" }), { status: 200 }),
    );
    await expect(enqueueAgentDispatch("http://mgr", BODY)).rejects.toThrow("unknown actor");
  });

  it("throws on a non-2xx status with the error body", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ok: false, error: "agent not resolvable" }), { status: 404 }),
    );
    await expect(enqueueAgentDispatch("http://mgr", BODY)).rejects.toThrow("agent not resolvable");
  });

  it("falls back to status text when the error body is not JSON", async () => {
    mockFetch(() => new Response("upstream boom", { status: 503, statusText: "Service Unavailable" }));
    await expect(enqueueAgentDispatch("http://mgr", BODY)).rejects.toThrow(/503/);
  });
});
