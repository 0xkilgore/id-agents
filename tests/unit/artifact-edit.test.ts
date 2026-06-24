// T-CKPT.8 edit-in-product (phase 1) — pure helpers + the substrate-only,
// file-never-mutated edit-capture round trip.

import { describe, it, expect } from "vitest";
import {
  EDIT_OP_TYPE,
  buildEditPayload,
  isEditInProductEnabled,
  latestEdit,
} from "../../src/outputs/edit.js";
import type { ArtifactOpRow } from "../../src/outputs/types.js";

function op(over: Partial<ArtifactOpRow>): ArtifactOpRow {
  return {
    op_id: 1,
    artifact_id: "art_1",
    op_type: "edit",
    actor: "user:chris",
    ts: "2026-06-24T18:00:00.000Z",
    payload_json: null,
    source_link: null,
    ...over,
  };
}

describe("isEditInProductEnabled", () => {
  it("is OFF by default and ON only for truthy flag values", () => {
    expect(isEditInProductEnabled({})).toBe(false);
    expect(isEditInProductEnabled({ ARTIFACTS_EDIT_IN_PRODUCT: "0" })).toBe(false);
    expect(isEditInProductEnabled({ ARTIFACTS_EDIT_IN_PRODUCT: "1" })).toBe(true);
    expect(isEditInProductEnabled({ ARTIFACTS_EDIT_IN_PRODUCT: "true" })).toBe(true);
    expect(isEditInProductEnabled({ ARTIFACTS_EDIT_IN_PRODUCT: "on" })).toBe(true);
  });
});

describe("buildEditPayload", () => {
  it("round-trips content (+ optional note)", () => {
    expect(JSON.parse(buildEditPayload("hello", null))).toEqual({ content: "hello" });
    expect(JSON.parse(buildEditPayload("hi", "typo fix"))).toEqual({ content: "hi", note: "typo fix" });
  });
});

describe("latestEdit", () => {
  it("returns null when there is no edit op", () => {
    expect(latestEdit([])).toBeNull();
    expect(latestEdit([op({ op_type: "view", op_id: 3 })])).toBeNull();
  });

  it("picks the most recent edit (by op_id) and parses its body + editor", () => {
    const ops: ArtifactOpRow[] = [
      op({ op_id: 1, payload_json: buildEditPayload("v1", null) }),
      op({ op_id: 5, actor: "user:liz", ts: "2026-06-24T19:00:00.000Z", payload_json: buildEditPayload("v2 latest", "polish") }),
      op({ op_id: 2, op_type: "view" }),
    ];
    const e = latestEdit(ops)!;
    expect(e.content).toBe("v2 latest");
    expect(e.note).toBe("polish");
    expect(e.editor).toEqual({ type: "user", id: "liz" });
    expect(e.edited_at).toBe("2026-06-24T19:00:00.000Z");
  });

  it("tolerates a malformed payload (empty body, no throw)", () => {
    expect(latestEdit([op({ op_id: 1, payload_json: "{not json" })])!.content).toBe("");
  });

  it("uses the canonical edit op-type", () => {
    expect(EDIT_OP_TYPE).toBe("edit");
  });
});
