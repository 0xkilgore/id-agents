// Dispatch-canonical strict-mode classifier tests.
//
// CTO scope: cto/output/2026-06-10-dispatch-canonical-strict-mode-spec.md
//
// Required fixtures (CTO §"Tests / Fixtures"):
//   - Anthropic-style rate_limit_error structured JSON
//   - plain-text 429 rate limit response
//   - provider overloaded/server error response
//   - provider auth failure
//   - context length failure
//   - tool execution failure body
//   - valid agent answer mentioning "rate limit" in a non-error context
//     (must remain delivered — no false positive)
//   - malformed JSON body
//   - dispatch id mismatch body

import { describe, expect, it } from "vitest";

import { classifyAgentResponse } from "../../src/dispatch-scheduler/strict-mode-classifier.js";

const NOW = "2026-06-11T17:00:00Z";

describe("classifyAgentResponse — structured markers (highest confidence)", () => {
  it("Anthropic-style rate_limit_error → failed, rate_limit_error, structured", () => {
    const body = {
      error: {
        type: "rate_limit_error",
        message: "Number of request tokens has exceeded your per-minute rate limit",
      },
    };
    const c = classifyAgentResponse({
      body,
      transport_status: 429,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
    expect(c.failure_reason).toBe("rate_limit_error");
    expect(c.confidence).toBe("structured");
    expect(c.matched_pattern).toBe("error.type=rate_limit_error");
  });

  it("provider_server_error structured → failed", () => {
    const c = classifyAgentResponse({
      body: { error: { type: "provider_server_error", message: "upstream 502" } },
      transport_status: 502,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_server_error");
    expect(c.confidence).toBe("structured");
  });

  it("authentication_error structured → failed, provider_auth_error", () => {
    const c = classifyAgentResponse({
      body: { error: { type: "authentication_error", message: "Invalid API key" } },
      transport_status: 401,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_auth_error");
  });

  it("invalid_request_error with context-window message → context_length_error", () => {
    const c = classifyAgentResponse({
      body: {
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 250000 tokens > 200000 maximum context",
        },
      },
      transport_status: 400,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("context_length_error");
  });

  it("invalid_request_error WITHOUT context-window keyword stays unknown_error (not a false positive)", () => {
    const c = classifyAgentResponse({
      body: {
        error: { type: "invalid_request_error", message: "Required field missing" },
      },
      transport_status: 400,
      classified_at: NOW,
    });
    // Don't claim it's a context_length error if it's not.
    expect(c.failure_reason).not.toBe("context_length_error");
  });

  it("body with success=false + error_type → failed", () => {
    const c = classifyAgentResponse({
      body: { success: false, error_type: "tool_execution_failed", error: "DB timed out" },
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
  });

  it("manager/tool body with status=failed → failed", () => {
    const c = classifyAgentResponse({
      body: { status: "failed", failure_reason: "provider_timeout" },
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
    expect(c.failure_reason).toBe("provider_timeout");
  });
});

describe("classifyAgentResponse — plain-text patterns (fallback)", () => {
  it("plain-text '429' + 'rate limit' on a non-200 transport → rate_limit_error", () => {
    const c = classifyAgentResponse({
      body: "429 Too Many Requests — rate limit exceeded for this organization",
      transport_status: 429,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("rate_limit_error");
    expect(c.confidence).toBe("pattern");
  });

  it("plain-text 'overloaded' → provider_server_error", () => {
    const c = classifyAgentResponse({
      body: "Upstream is overloaded; please retry in a few seconds.",
      transport_status: 503,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_server_error");
  });

  it("plain-text 'invalid api key' → provider_auth_error", () => {
    const c = classifyAgentResponse({
      body: "Invalid API key provided.",
      transport_status: 401,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_auth_error");
  });

  it("plain-text 'maximum context' → context_length_error", () => {
    const c = classifyAgentResponse({
      body: "prompt is too long: 250000 tokens > 200000 maximum context",
      transport_status: 400,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("context_length_error");
  });

  it("plain-text 'tool execution failed' → tool_error", () => {
    const c = classifyAgentResponse({
      body: "tool execution failed: timed out fetching the manifest",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("tool_error");
  });

  it("CLI-runtime auth body 'Not logged in · Please run /login' on a 200 transport → failed, provider_auth_error (E2E-121237 regression)", () => {
    // The Claude CLI runtime emits this when its session token is gone.
    // It arrives on /agent-done with success:true + transport 200, so the
    // strict-mode classifier is the only thing standing between it and a
    // bogus `delivered`. Must be caught despite the 200 OK.
    const c = classifyAgentResponse({
      body: "Not logged in · Please run /login",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
    expect(c.failure_reason).toBe("provider_auth_error");
    expect(c.confidence).toBe("pattern");
  });

  it("CLI-runtime auth phrase 'not logged in' (lowercase, embedded) → provider_auth_error", () => {
    const c = classifyAgentResponse({
      body: "the agent is not logged in to the provider runtime",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_auth_error");
  });

  it("Claude session-limit text on a 200 closeout → rate_limit_error with reset time", () => {
    const c = classifyAgentResponse({
      body: "You've hit your session limit · resets 1:10pm (America/Chicago)",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
    expect(c.failure_reason).toBe("rate_limit_error");
    expect(c.matched_pattern).toBe("text:claude-session-limit");
    expect(c.provider_reset_label).toBe("1:10pm (America/Chicago)");
    expect(c.provider_reset_at).toBe("2026-06-11T18:10:00.000Z");
  });
});

describe("classifyAgentResponse — false-positive guards (the hard part)", () => {
  it("valid agent answer that NARRATES rate limits stays delivered", () => {
    // Headline false-positive guard: the agent is answering a question
    // ABOUT rate limits. The body contains the phrase but is NOT a
    // provider/runtime error. CTO scope: "Avoid broad words like
    // 'error' alone. False positives should be minimized by requiring
    // either structured fields or specific provider/runtime phrases."
    const c = classifyAgentResponse({
      body:
        "To handle rate limits gracefully, your client should back off " +
        "with exponential jitter when it sees a 429 response. Here's a " +
        "code example you can adapt:\n\nimport time\n...",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("delivered");
    expect(c.failure_reason).toBe(null);
  });

  it("valid agent answer that documents a '/login' route stays delivered (no broad match on the slash command)", () => {
    // The runtime-auth matcher keys on the full phrases "not logged in"
    // and "please run /login" — NOT a bare "/login" — so an agent
    // answering a question about a login endpoint is not a false positive.
    const c = classifyAgentResponse({
      body:
        "Your Express app should mount the auth handler at POST /login " +
        "and redirect there when the session cookie is absent.",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("delivered");
    expect(c.failure_reason).toBe(null);
  });

  it("body containing the substring 'error' alone is delivered (no broad match)", () => {
    const c = classifyAgentResponse({
      body:
        "I noticed an error in your spreadsheet on row 42; the formula " +
        "should reference $B$2, not B2.",
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("delivered");
  });

  it("valid Claude response object (id + content) is delivered", () => {
    const c = classifyAgentResponse({
      body: {
        id: "msg_abc",
        content: [{ type: "text", text: "Done. Here's the summary." }],
        stop_reason: "end_turn",
      },
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.classification).toBe("delivered");
  });
});

describe("classifyAgentResponse — transport + malformed", () => {
  it("transport_status >= 500 with no body marker → provider_server_error (transport confidence)", () => {
    const c = classifyAgentResponse({
      body: "",
      transport_status: 502,
      classified_at: NOW,
    });
    expect(c.classification).toBe("failed");
    expect(c.failure_reason).toBe("provider_server_error");
    expect(c.confidence).toBe("transport");
  });

  it("transport_status 401 + empty body → provider_auth_error (transport)", () => {
    const c = classifyAgentResponse({
      body: "",
      transport_status: 401,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("provider_auth_error");
    expect(c.confidence).toBe("transport");
  });

  it("transport_status 429 + empty body → rate_limit_error (transport)", () => {
    const c = classifyAgentResponse({
      body: "",
      transport_status: 429,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("rate_limit_error");
    expect(c.confidence).toBe("transport");
  });

  it("malformed JSON body (unparseable) → malformed_agent_response", () => {
    const c = classifyAgentResponse({
      body: "{not json at all",
      transport_status: 200,
      classified_at: NOW,
      // The classifier is told the body should have been JSON but isn't.
      expected_json: true,
    });
    expect(c.failure_reason).toBe("malformed_agent_response");
  });

  it("dispatch_id_mismatch body → dispatch_id_mismatch", () => {
    const c = classifyAgentResponse({
      body: {
        error: "dispatch_id_mismatch",
        expected: "phid:disp-aaa",
        got: "phid:disp-bbb",
      },
      transport_status: 409,
      classified_at: NOW,
    });
    expect(c.failure_reason).toBe("dispatch_id_mismatch");
  });
});

describe("classifyAgentResponse — output shape", () => {
  it("includes response_excerpt (redacted, capped)", () => {
    const longBody = "x".repeat(2000);
    const c = classifyAgentResponse({
      body: longBody,
      transport_status: 200,
      classified_at: NOW,
    });
    expect(c.response_excerpt).not.toBeNull();
    expect(c.response_excerpt!.length).toBeLessThanOrEqual(500);
  });

  it("redacts obvious secret-looking substrings from the excerpt", () => {
    const c = classifyAgentResponse({
      body: "rate limit hit; sk-ant-api03-AAAAABBBBB key in error",
      transport_status: 429,
      classified_at: NOW,
    });
    expect(c.response_excerpt).not.toMatch(/sk-ant-api03-[A-Z]+/);
  });

  it("includes classified_at and the matched_pattern key", () => {
    const c = classifyAgentResponse({
      body: { error: { type: "rate_limit_error" } },
      transport_status: 429,
      classified_at: NOW,
    });
    expect(c.classified_at).toBe(NOW);
    expect(c.matched_pattern).not.toBeNull();
  });
});
