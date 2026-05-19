// Phase 3.2 TDD: provider throttle classifier.
//
// The classifier inspects an agent-start error (HTTP status, body text)
// and tags it as one of:
//   provider_throttle    — provider returned a transient rate-limit
//   auth_or_plan         — hard stop, do not retry
//   local_pause          — local usage-meter said no, not a provider issue
//   agent_error          — non-throttle agent-side failure
//   transport            — network-level failure
//
// The classifier is the gate between markBounced (retryable, requeue
// with backoff) and markFailed (terminal, no retry).

import { describe, it, expect } from "vitest";
import { classifyAgentStartError } from "../../src/dispatch-scheduler/throttle-classifier.js";

describe("classifyAgentStartError — provider throttle (anthropic)", () => {
  it("classifies the exact Anthropic message", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 529,
      body: "Server is temporarily limiting requests",
    });
    expect(r.kind).toBe("provider_throttle");
    expect(r.retryable).toBe(true);
    expect(r.detail).toContain("temporarily limiting requests");
  });

  it("classifies HTTP 429 with rate_limit body", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 429,
      body: "Too many requests: rate_limit_exceeded",
    });
    expect(r.kind).toBe("provider_throttle");
  });

  it("classifies HTTP 529 (overloaded)", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 529,
      body: "overloaded",
    });
    expect(r.kind).toBe("provider_throttle");
  });

  it("classifies HTTP 503 with capacity language", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 503,
      body: "temporarily unavailable due to capacity",
    });
    expect(r.kind).toBe("provider_throttle");
  });

  it("classifies 'concurrent request limit' wording", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 429,
      body: "concurrent request limit exceeded",
    });
    expect(r.kind).toBe("provider_throttle");
  });
});

describe("classifyAgentStartError — auth/plan hard stops", () => {
  it("HTTP 401 is auth_or_plan (no retry)", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 401,
      body: "invalid api key",
    });
    expect(r.kind).toBe("auth_or_plan");
    expect(r.retryable).toBe(false);
  });

  it("HTTP 403 with plan language is auth_or_plan", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 403,
      body: "your plan does not include this model",
    });
    expect(r.kind).toBe("auth_or_plan");
    expect(r.retryable).toBe(false);
  });

  it("HTTP 402 (payment required) is auth_or_plan", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 402,
      body: "payment required",
    });
    expect(r.kind).toBe("auth_or_plan");
    expect(r.retryable).toBe(false);
  });
});

describe("classifyAgentStartError — local usage pause", () => {
  it("local_pause source is not a provider bounce", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 0,
      body: "",
      cause: "local_usage_pause",
    });
    expect(r.kind).toBe("local_pause");
    expect(r.retryable).toBe(true);
  });
});

describe("classifyAgentStartError — transport failures", () => {
  it("network-level ECONNREFUSED is transport (retryable)", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 0,
      body: "",
      cause: "transport",
      transportError: "ECONNREFUSED",
    });
    expect(r.kind).toBe("transport");
    expect(r.retryable).toBe(true);
    expect(r.detail).toContain("ECONNREFUSED");
  });

  it("timeout is transport (retryable)", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 0,
      body: "",
      cause: "transport",
      transportError: "AbortError: timeout",
    });
    expect(r.kind).toBe("transport");
    expect(r.retryable).toBe(true);
  });
});

describe("classifyAgentStartError — generic agent_error", () => {
  it("HTTP 500 with non-throttle body is agent_error", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 500,
      body: "internal server error",
    });
    expect(r.kind).toBe("agent_error");
    expect(r.retryable).toBe(false);
  });

  it("HTTP 400 with validation body is agent_error", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 400,
      body: "missing required field 'message'",
    });
    expect(r.kind).toBe("agent_error");
    expect(r.retryable).toBe(false);
  });
});

describe("classifyAgentStartError — secret redaction", () => {
  it("redacts api-key-like substrings from detail", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 401,
      body: "invalid key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(r.detail).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(r.detail).toContain("[redacted]");
  });

  it("redacts bearer tokens from detail", () => {
    const r = classifyAgentStartError({
      provider: "anthropic",
      status: 401,
      body: "Authorization: Bearer eyJhbGciOi.eyJzdWIiOiJ.signaturepart",
    });
    expect(r.detail).not.toContain("eyJhbGciOi.eyJzdWIiOiJ.signaturepart");
    expect(r.detail).toContain("[redacted]");
  });
});
