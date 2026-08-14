import { describe, expect, it } from "vitest";
import { buildOperatorAttention, OperatorAttentionUnavailableError } from "../../src/operator-attention/projection.js";
import type { OperatorAttentionCandidate, OperatorAttentionSourceSet } from "../../src/operator-attention/types.js";

const NOW = new Date("2026-08-13T15:00:00.000Z");

describe("operator-attention.v1", () => {
  it("admits manager-derived primary, linked decisions and waiting work deterministically", () => {
    const source = fixture([
      candidate("feedback-terminal", { source_kind: "feedback", attention_kind: "urgent", manager_derived: true }),
      candidate("linked-decision", { attention_kind: "decide", requested_by_ref: "dispatch:one", requested_by_waiting: true }),
      candidate("waiting-receipt", { source_kind: "feedback", attention_kind: "waiting" }),
    ]);
    const first = buildOperatorAttention(source, { evaluatedAt: NOW });
    const second = buildOperatorAttention({ ...source, candidates: [...source.candidates!].reverse() }, { evaluatedAt: NOW });

    expect(first.response.schema_version).toBe("operator-attention.v1");
    expect(first.response.bands.primary.map((row) => row.ref)).toEqual(["feedback-terminal"]);
    expect(first.response.bands.next.map((row) => row.ref)).toEqual(["linked-decision"]);
    expect(first.response.bands.waiting.map((row) => row.ref)).toEqual(["waiting-receipt"]);
    expect(second).toEqual(first);
    expect(first.response.payload_bytes).toBe(Buffer.byteLength(JSON.stringify(first.response), "utf8"));
    expect(first.response.payload_bytes).toBeLessThanOrEqual(64 * 1024);

  });

  it("fails closed with inspectable suppression reasons and owner budgets", () => {
    const source = fixture([
      candidate("unlinked", { attention_kind: "approve", requested_by_waiting: false }),
      candidate("test-report", { environment: "test" }),
      candidate("report-a", { owner: "agent-one" }),
      candidate("report-b", { owner: "agent-one", meaningful_at: "2026-08-13T13:00:00.000Z" }),
      candidate("report-c", { owner: "agent-one", meaningful_at: "2026-08-13T14:00:00.000Z" }),
      candidate("report-d", { owner: "agent-two" }),
      candidate("report-e", { owner: "agent-three" }),
      candidate("report-f", { owner: "agent-four" }),
      candidate("report-g", { owner: "agent-five" }),
    ]);
    const { response, suppressions } = buildOperatorAttention(source, { evaluatedAt: NOW });

    expect(suppressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "unlinked", reason: "unlinked_decision" }),
      expect.objectContaining({ ref: "test-report", reason: "test_material" }),
      expect.objectContaining({ ref: "report-c", reason: "owner_budget_exhausted" }),
      expect.objectContaining({ reason: "over_budget" }),
    ]));
    expect(response.bands.next).toHaveLength(4);
    expect(response.counts.overflow).toBeGreaterThan(0);
    expect(response.counts.suppressed).toBe(suppressions.length);
  });

  it("distinguishes healthy-empty and degraded snapshots from unavailable sources", () => {
    const healthy = buildOperatorAttention(fixture([]), { evaluatedAt: NOW }).response;
    const degraded = buildOperatorAttention({ ...fixture([]), source_health: "degraded", source_health_reason: "one source is delayed" }, { evaluatedAt: NOW }).response;
    expect(healthy.freshness_state).toBe("current");
    expect(degraded.freshness_state).toBe("degraded");
    expect(degraded.freshness_reason).toBe("one source is delayed");
    expect(degraded.authority.source_cursor).not.toBe(healthy.authority.source_cursor);
    expect(() => buildOperatorAttention({
      ...fixture([]),
      source_health: "unavailable",
      source_health_reason: "manager source unavailable",
    }, { evaluatedAt: NOW })).toThrow(OperatorAttentionUnavailableError);
  });

  it("fails closed when the bounded response would exceed 64 KiB", () => {
    expect(() => buildOperatorAttention(fixture([candidate("visible")]), {
      evaluatedAt: NOW,
      capabilities: { open: `disabled:${"x".repeat(70_000)}` },
    })).toThrow("operator_attention_payload_exceeds_65536_bytes");
  });

  it("suppresses malformed source timestamps instead of ranking them", () => {
    const { response, suppressions } = buildOperatorAttention(fixture([
      candidate("malformed", { source_as_of: "not-a-timestamp" }),
    ]), { evaluatedAt: NOW });

    expect(response.counts.next).toBe(0);
    expect(suppressions).toContainEqual(expect.objectContaining({
      ref: "malformed",
      reason: "stale_unlabeled",
    }));
  });
});

function fixture(candidates: OperatorAttentionCandidate[]): OperatorAttentionSourceSet {
  return { daily_desk: { today: [], review_next_source: [], needs_response: [], follow_through: [] }, candidates };
}

function candidate(ref: string, overrides: Partial<OperatorAttentionCandidate> = {}): OperatorAttentionCandidate {
  return {
    ref, title: `Synthetic ${ref}`, owner: "synthetic-owner", audience: "operator", environment: "production",
    authority_owner: "manager", canonical_url: `/ops/synthetic/${ref}`, lifecycle: "open",
    source_as_of: "2026-08-13T14:00:00.000Z", meaningful_at: "2026-08-13T12:00:00.000Z",
    expires_at: "2026-08-14T00:00:00.000Z", source_kind: "report", attention_kind: "read",
    actions: ["open"], admission_code: "synthetic_explicit_request",
    admission_detail: "synthetic fixture carries an explicit bounded request", ...overrides,
  };
}
