// CANE_DRAFT_ARTIFACTS — pure helpers for the send executor + draft body
// derivation. No DB, no network.

import { describe, it, expect } from "vitest";
import { pendingIdFromDraftId, caneBaseUrl } from "../../src/outputs/ship-executor.js";
import { latestDraftBody, REVISE_DRAFT_OP_TYPE } from "../../src/outputs/ops.js";
import type { ArtifactOpRow, CaneDraftPayload } from "../../src/outputs/types.js";

function payload(over: Partial<CaneDraftPayload> = {}): CaneDraftPayload {
  return {
    draft_id: "cane:draft:p1",
    channel: "email",
    to: "liz@example.com",
    subject: "Re: x",
    body_markdown: "registered body",
    send_recommendation: "needs_approval",
    revision_history: [],
    ...over,
  };
}

function op(over: Partial<ArtifactOpRow>): ArtifactOpRow {
  return {
    op_id: 1,
    artifact_id: "art_1",
    op_type: REVISE_DRAFT_OP_TYPE,
    actor: "user:chris",
    ts: "2026-06-24T20:00:00.000Z",
    payload_json: null,
    source_link: null,
    ...over,
  };
}

describe("pendingIdFromDraftId", () => {
  it("strips the cane:draft: prefix", () => {
    expect(pendingIdFromDraftId("cane:draft:abc123")).toBe("abc123");
  });
  it("falls back to the whole id when unprefixed", () => {
    expect(pendingIdFromDraftId("xyz")).toBe("xyz");
  });
});

describe("caneBaseUrl", () => {
  it("defaults to localhost and strips a trailing slash from the override", () => {
    expect(caneBaseUrl({})).toBe("http://localhost:8765");
    expect(caneBaseUrl({ CANE_BASE_URL: "http://cane.local:9000/" })).toBe("http://cane.local:9000");
  });
});

describe("latestDraftBody", () => {
  it("returns the registered body when there is no revision", () => {
    expect(latestDraftBody(payload(), [])).toBe("registered body");
    expect(latestDraftBody(payload(), [op({ op_type: "view", op_id: 9 })])).toBe("registered body");
  });

  it("returns the most recent revise_draft body (by op_id)", () => {
    const ops: ArtifactOpRow[] = [
      op({ op_id: 1, payload_json: JSON.stringify({ body_markdown: "v1" }) }),
      op({ op_id: 5, payload_json: JSON.stringify({ body_markdown: "v2 latest" }) }),
      op({ op_id: 3, op_type: "view" }),
    ];
    expect(latestDraftBody(payload(), ops)).toBe("v2 latest");
  });

  it("tolerates a malformed revise payload (falls back to registered body)", () => {
    expect(latestDraftBody(payload(), [op({ op_id: 1, payload_json: "{not json" })])).toBe(
      "registered body",
    );
  });
});
