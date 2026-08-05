import { describe, expect, it } from "vitest";
import {
  REVIEW_NEXT_MAX_BYTES,
  buildReviewNextResponse,
} from "../../src/review-next/projection.js";
import type { ReviewNextSourceRow } from "../../src/review-next/types.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");

function row(id: string, overrides: Partial<ReviewNextSourceRow> = {}): ReviewNextSourceRow {
  return {
    artifact_id: id,
    title: `Artifact ${id}`,
    artifact_created_at: "2026-08-05T10:00:00.000Z",
    produced_at: "2026-08-05T10:00:00.000Z",
    source: "agent-done",
    availability: "present",
    abs_path: `/operator/output/${id}.md`,
    basename: `${id}.md`,
    audience: "operator",
    environment: "production",
    owner: "cane",
    canonical_url: `/ops/artifacts/${id}`,
    effective_lifecycle: "needs_review",
    source_as_of: "2026-08-05T10:00:00.000Z",
    revised_at: null,
    revalidated_at: null,
    pinned_at: null,
    attention_state: "needs_review",
    attention_reason: "operator deliverable is ready",
    attention_priority: 10,
    admission_reason: "explicit operator registration",
    permitted_actions_json: JSON.stringify(["open", "comment", "approve", "snooze", "mark_done"]),
    ...overrides,
  };
}

describe("review-next.v1 authoritative projection", () => {
  it("default-denies legacy/title fixtures and excludes test, terminal, unavailable, and expired rows", () => {
    const sources: ReviewNextSourceRow[] = [
      row("art-fresh-august", { attention_priority: 0 }),
      ...[1, 2, 3, 4].map((n) => row(`approval-test-july-21-${n}`, {
        audience: "",
        environment: "",
        source_as_of: "2026-07-21T12:00:00.000Z",
        title: `Approval test ${n}`,
      })),
      row("art-terminal", { effective_lifecycle: "resolved" }),
      row("art-eight-days", { source_as_of: "2026-07-28T11:59:59.999Z" }),
      row("art-test-environment", { environment: "test" }),
      row("art-fixture-path", { abs_path: "/repo/tests/fixtures/output.md" }),
      row("art-system", { audience: "system" }),
      row("art-missing", { availability: "missing" }),
    ];

    const response = buildReviewNextResponse(sources, { now: NOW });
    expect(response.rows.map((item) => item.id)).toEqual(["art-fresh-august"]);
    expect(response.rows[0].title).toBe("Artifact art-fresh-august");
    expect(response.rows[0].permitted_actions).toEqual(["open", "comment", "approve"]);
    expect(response.rows[0].permitted_actions).not.toContain("snooze");
    expect(response.rows[0].permitted_actions).not.toContain("mark_done");
  });

  it("covers both sides of seven days plus pin and explicit 24-hour revalidation exceptions", () => {
    const response = buildReviewNextResponse([
      row("boundary-in", { source_as_of: "2026-07-29T12:00:00.000Z", attention_priority: 3 }),
      row("boundary-out", { source_as_of: "2026-07-29T11:59:59.999Z" }),
      row("pinned-old", { source_as_of: "2026-07-01T12:00:00.000Z", pinned_at: "2026-07-02T12:00:00.000Z", attention_priority: 99 }),
      row("revalidated-old", { source_as_of: "2026-07-20T12:00:00.000Z", revalidated_at: "2026-08-04T12:00:00.000Z", attention_priority: 4 }),
      row("revalidation-too-old", { source_as_of: "2026-07-20T12:00:00.000Z", revalidated_at: "2026-08-04T11:59:59.999Z" }),
    ], { now: NOW });

    expect(response.rows.map((item) => item.id)).toEqual(["pinned-old", "boundary-in", "revalidated-old"]);
    expect(response.rows.find((item) => item.id === "pinned-old")?.freshness_state).toBe("pinned");
    expect(response.rows.find((item) => item.id === "revalidated-old")?.freshness_state).toBe("revalidated");
  });

  it("is stable across shuffled input and repeat reads", () => {
    const sources = [
      row("c", { attention_priority: 2, source_as_of: "2026-08-05T09:00:00.000Z" }),
      row("a", { attention_priority: 1, source_as_of: "2026-08-05T08:00:00.000Z" }),
      row("b", { attention_priority: 1, source_as_of: "2026-08-05T08:00:00.000Z" }),
      row("p", { attention_priority: 99, pinned_at: "2026-08-05T07:00:00.000Z" }),
    ];
    const first = buildReviewNextResponse(sources, { now: NOW });
    const second = buildReviewNextResponse([sources[2], sources[0], sources[3], sources[1]], { now: NOW });
    expect(first.rows.map((item) => item.id)).toEqual(["p", "a", "b", "c"]);
    expect(second.rows).toEqual(first.rows);
    expect(second.authority.source_cursor).toBe(first.authority.source_cursor);
  });

  it("caps rows and payload, and includes every authority/freshness/lifecycle/action field", () => {
    const response = buildReviewNextResponse(
      Array.from({ length: 20 }, (_, index) => row(`art-${String(index).padStart(2, "0")}`, {
        title: "x".repeat(10_000),
        attention_priority: index,
      })),
      { now: NOW },
    );
    expect(response.rows).toHaveLength(5);
    expect(response.payload_bytes).toBeLessThanOrEqual(REVIEW_NEXT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBe(response.payload_bytes);
    expect(response).toMatchObject({
      schema_version: "review-next.v1",
      authority: { owner: "manager", projection: "review_next", state: "authoritative" },
      projection_as_of: NOW.toISOString(),
      freshness_state: "current",
      count: 5,
    });
    for (const item of response.rows) {
      expect(item).toEqual(expect.objectContaining({
        id: expect.any(String),
        canonical_url: expect.any(String),
        owner: expect.any(String),
        audience: "operator",
        admission_reason: expect.any(String),
        attention_state: expect.any(String),
        attention_reason: expect.any(String),
        effective_lifecycle: "needs_review",
        source_as_of: expect.any(String),
        freshness_state: expect.any(String),
        freshness_reason: expect.any(String),
        permitted_actions: expect.any(Array),
      }));
    }
  });
});
