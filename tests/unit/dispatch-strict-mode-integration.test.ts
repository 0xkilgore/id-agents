// Closeout-override decision tests.
//
// SchedulerHandle.handleAgentDone consults this pure helper at the
// closeout boundary. The headline live-bug fix: a rate_limit_error
// response body arriving with `success: true` (the current /agent-done
// contract) must be marked `failed` with a typed reason in enforce
// mode, and must NOT be silently delivered.

import { describe, expect, it } from "vitest";

import {
  classifyAgentResponse,
  decideStrictModeOverride,
  parseStrictModeFlag,
} from "../../src/dispatch-scheduler/strict-mode-classifier.js";

const NOW = "2026-06-11T17:00:00Z";

const RATE_LIMIT_BODY = { error: { type: "rate_limit_error", message: "429" } };

const VALID_BODY = {
  id: "msg_abc",
  content: [{ type: "text", text: "Done. Here's the summary." }],
  stop_reason: "end_turn",
};

const NARRATING_BODY = {
  id: "msg_abc",
  content: [
    {
      type: "text",
      text:
        "To handle rate limits gracefully, your client should back off " +
        "with exponential jitter when it sees a 429 response.",
    },
  ],
  stop_reason: "end_turn",
};

function classify(body: unknown) {
  return classifyAgentResponse({
    body,
    transport_status: 200,
    classified_at: NOW,
  });
}

describe("parseStrictModeFlag", () => {
  it("defaults to off", () => {
    expect(parseStrictModeFlag(undefined)).toBe("off");
    expect(parseStrictModeFlag("")).toBe("off");
    expect(parseStrictModeFlag("garbage")).toBe("off");
  });
  it("accepts shadow / enforce (case-insensitive)", () => {
    expect(parseStrictModeFlag("shadow")).toBe("shadow");
    expect(parseStrictModeFlag("SHADOW")).toBe("shadow");
    expect(parseStrictModeFlag("Enforce")).toBe("enforce");
    expect(parseStrictModeFlag("enforce")).toBe("enforce");
  });
});

describe("decideStrictModeOverride", () => {
  it("flag=off + rate_limit body → null (no override, no log payload required)", () => {
    const c = classify(RATE_LIMIT_BODY);
    const d = decideStrictModeOverride("off", c);
    // off + failed classification: still produces the log payload for
    // observability, but does not override.
    expect(d?.override).toBe(false);
  });

  it("flag=shadow + rate_limit body → log but no override (the headline shadow behavior)", () => {
    const c = classify(RATE_LIMIT_BODY);
    const d = decideStrictModeOverride("shadow", c);
    expect(d?.override).toBe(false);
    expect(d?.log_payload.mode).toBe("shadow");
    expect(d?.log_payload.failure_reason).toBe("rate_limit_error");
  });

  it("flag=enforce + rate_limit body → OVERRIDE to failed with strict_mode_classified + typed detail (the headline live-bug fix)", () => {
    const c = classify(RATE_LIMIT_BODY);
    const d = decideStrictModeOverride("enforce", c);
    expect(d?.override).toBe(true);
    expect(d?.failure_kind).toBe("strict_mode_classified");
    expect(d?.detail).toContain("rate_limit_error");
    expect(d?.detail).toContain("structured");
  });

  it("flag=enforce + valid response body → null (no override; closeout proceeds to delivered)", () => {
    const c = classify(VALID_BODY);
    const d = decideStrictModeOverride("enforce", c);
    expect(d).toBeNull();
  });

  it("flag=enforce + valid response that NARRATES rate limits → null (false-positive guard preserved through the decision layer)", () => {
    const c = classify(NARRATING_BODY);
    const d = decideStrictModeOverride("enforce", c);
    expect(d).toBeNull();
  });

  it("decision.detail format matches the closeout-row format that handleAgentDone writes (`strict_mode:<reason>:<confidence>:<matched_pattern>`)", () => {
    const c = classify(RATE_LIMIT_BODY);
    const d = decideStrictModeOverride("enforce", c);
    expect(d?.detail.split(":")).toContain("strict_mode");
    expect(d?.detail.split(":")).toContain("rate_limit_error");
    expect(d?.detail.split(":")).toContain("structured");
    // Ensure the matched_pattern key is in the detail, too.
    expect(d?.detail).toContain("error.type=rate_limit_error");
  });

  it("flag=enforce + provider_auth_error → override with provider_auth_error reason", () => {
    const c = classify({
      error: { type: "authentication_error", message: "Invalid API key" },
    });
    const d = decideStrictModeOverride("enforce", c);
    expect(d?.override).toBe(true);
    expect(d?.detail).toContain("provider_auth_error");
  });

  it("flag=shadow + provider_server_error → log payload includes typed reason without override", () => {
    const c = classify({
      error: { type: "provider_server_error", message: "upstream 502" },
    });
    const d = decideStrictModeOverride("shadow", c);
    expect(d?.override).toBe(false);
    expect(d?.log_payload.failure_reason).toBe("provider_server_error");
  });
});
