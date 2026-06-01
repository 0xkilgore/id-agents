// Usage Meter — Claude transcript JSONL parser tests.
// Spec: cto/output/2026-05-31-usage-meter-controls-spec.md
//
// Weighted-tokens math:
//   weighted_tokens =
//     input_tokens +
//     output_tokens +
//     cache_creation_input_tokens +
//     cache_read_input_tokens * 0.1

import { describe, it, expect } from "vitest";
import {
  parseTranscriptLine,
  parseTranscriptContent,
  computeWeightedTokens,
} from "../../src/usage-meter/transcripts.js";

const VALID_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_abc",
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 200,
    },
  },
  session_id: "session_xyz",
  uuid: "msg_uuid_1",
  timestamp: "2026-05-31T18:00:00.000Z",
});

describe("computeWeightedTokens", () => {
  it("input + output + cache_creation + cache_read * 0.1", () => {
    expect(
      computeWeightedTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 200,
      }),
    ).toBe(100 + 50 + 20 + 20); // 200 * 0.1 = 20
  });

  it("missing fields default to 0", () => {
    expect(computeWeightedTokens({ input_tokens: 10 })).toBe(10);
  });

  it("rounds to integer", () => {
    expect(
      computeWeightedTokens({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 7, // 7 * 0.1 = 0.7 → 1
      }),
    ).toBe(1);
  });
});

describe("parseTranscriptLine", () => {
  it("parses a valid assistant line with usage block", () => {
    const ev = parseTranscriptLine(VALID_LINE, "transcript-A.jsonl", 0);
    expect(ev).not.toBeNull();
    expect(ev!.input_tokens).toBe(100);
    expect(ev!.output_tokens).toBe(50);
    expect(ev!.cache_creation_input_tokens).toBe(20);
    expect(ev!.cache_read_input_tokens).toBe(200);
    expect(ev!.weighted_tokens).toBe(190);
    expect(ev!.raw_tokens).toBe(100 + 50 + 20 + 200);
    expect(ev!.session_id).toBe("session_xyz");
    expect(ev!.model).toBe("claude-sonnet-4-6");
    // Stable hex digest (sha256 prefix); the assertion below verifies
    // determinism across calls with the same inputs.
    expect(ev!.idempotency_key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("derives a stable idempotency key from path + line + message uuid", () => {
    const ev1 = parseTranscriptLine(VALID_LINE, "abc.jsonl", 5);
    const ev2 = parseTranscriptLine(VALID_LINE, "abc.jsonl", 5);
    expect(ev1!.idempotency_key).toBe(ev2!.idempotency_key);
    const ev3 = parseTranscriptLine(VALID_LINE, "abc.jsonl", 6);
    expect(ev3!.idempotency_key).not.toBe(ev1!.idempotency_key);
  });

  it("returns null on non-assistant rows (skip silently)", () => {
    const userLine = JSON.stringify({ type: "user", message: { content: "hi" } });
    expect(parseTranscriptLine(userLine, "x.jsonl", 0)).toBeNull();
  });

  it("returns null on assistant rows without usage block", () => {
    const noUsage = JSON.stringify({ type: "assistant", message: { content: "hi", model: "x" } });
    expect(parseTranscriptLine(noUsage, "x.jsonl", 0)).toBeNull();
  });

  it("returns null on malformed JSON (no throw)", () => {
    expect(parseTranscriptLine("{ not json", "x.jsonl", 0)).toBeNull();
    expect(parseTranscriptLine("", "x.jsonl", 0)).toBeNull();
  });

  it("ts is parsed from message.timestamp (unix ms)", () => {
    const ev = parseTranscriptLine(VALID_LINE, "x.jsonl", 0);
    expect(ev!.ts).toBe(Date.parse("2026-05-31T18:00:00.000Z"));
  });
});

describe("parseTranscriptContent (whole file)", () => {
  it("parses all assistant usage lines, skipping user/system/malformed lines", () => {
    const content = [
      JSON.stringify({ type: "system", message: { content: "init" } }),
      VALID_LINE,
      "{ malformed",
      JSON.stringify({ type: "user", message: { content: "go" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_b",
          model: "claude-opus-4-7",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
        session_id: "session_xyz",
        uuid: "u2",
        timestamp: "2026-05-31T18:01:00.000Z",
      }),
    ].join("\n");
    const events = parseTranscriptContent(content, "p1/transcript.jsonl");
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBe("session_xyz");
    expect(events[1].weighted_tokens).toBe(3);
  });

  it("each event gets a unique idempotency key (line index is part of it)", () => {
    const content = [VALID_LINE, VALID_LINE].join("\n");
    const events = parseTranscriptContent(content, "p1/foo.jsonl");
    expect(events).toHaveLength(2);
    expect(events[0].idempotency_key).not.toBe(events[1].idempotency_key);
  });

  it("empty content → empty array", () => {
    expect(parseTranscriptContent("", "x.jsonl")).toEqual([]);
    expect(parseTranscriptContent("\n\n\n", "x.jsonl")).toEqual([]);
  });
});
