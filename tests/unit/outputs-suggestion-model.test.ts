// Artifact Review v1 — suggested-change PURE model (no DB / no HTTP).
// Covers the span-apply drift guard and the append-only lifecycle
// reconstruction, per cto/output/2026-06-29-suggested-change-route-contract.md.

import { describe, it, expect } from "vitest";
import type { ArtifactOpRow } from "../../src/outputs/types.js";
import {
  SUGGESTION_OP_TYPE,
  applySuggestionSpan,
  buildSuggestionCreatePayload,
  buildSuggestionTransitionPayload,
  mintSuggestionId,
  reconstructSuggestion,
  reconstructSuggestions,
  type SuggestionAnchor,
} from "../../src/outputs/suggestion.js";

const BODY = "The quick brown fox jumps over the lazy dog.";

function anchorFor(body: string, quote: string): SuggestionAnchor {
  const start = body.indexOf(quote);
  return { kind: "span", quote, char_start: start, char_end: start + quote.length, heading_path: null };
}

describe("applySuggestionSpan — drift guard", () => {
  it("applies at the anchor offsets when the span still matches", () => {
    const anchor = anchorFor(BODY, "brown fox");
    const r = applySuggestionSpan(BODY, "brown fox", "red hen", anchor);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next_body).toBe("The quick red hen jumps over the lazy dog.");
  });

  it("re-finds the span when offsets drifted but original_text is unique", () => {
    // Body reflowed: a prefix was inserted, so the old offsets are stale.
    const reflowed = "PREFIX. " + BODY;
    const staleAnchor = anchorFor(BODY, "lazy dog"); // offsets computed on the OLD body
    const r = applySuggestionSpan(reflowed, "lazy dog", "sleepy cat", staleAnchor);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next_body).toBe("PREFIX. The quick brown fox jumps over the sleepy cat.");
  });

  it("refuses (drift) when original_text is ambiguous (appears more than once)", () => {
    const dupBody = "fix this and fix that";
    const r = applySuggestionSpan(dupBody, "fix", "amend", { char_start: 999, char_end: 1002 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("drift");
  });

  it("refuses (drift) when original_text is gone from the body", () => {
    const r = applySuggestionSpan(BODY, "purple elephant", "x", { char_start: 0, char_end: 15 });
    expect(r.ok).toBe(false);
  });
});

describe("suggestion lifecycle reconstruction", () => {
  const ART = "art-model-1";
  const author = "user:chris";

  function op(op_id: number, payload_json: string, ts: string): ArtifactOpRow {
    return { op_id, artifact_id: ART, op_type: SUGGESTION_OP_TYPE, actor: author, ts, payload_json, source_link: null };
  }

  it("reconstructs a proposed suggestion from its create op", () => {
    const id = mintSuggestionId();
    const anchor = anchorFor(BODY, "brown fox");
    const ops = [
      op(1, buildSuggestionCreatePayload(id, {
        anchor, original_text: "brown fox", proposed_text: "red hen", author, rationale: "clearer", reaction: null,
      }), "2026-06-29T00:00:00.000Z"),
    ];
    const rec = reconstructSuggestion(ops, ART, id);
    expect(rec).not.toBeNull();
    expect(rec!.state).toBe("proposed");
    expect(rec!.original_text).toBe("brown fox");
    expect(rec!.proposed_text).toBe("red hen");
    expect(rec!.author).toBe("user:chris");
  });

  it("advances state to the latest transition op (proposed → accepted)", () => {
    const id = mintSuggestionId();
    const anchor = anchorFor(BODY, "brown fox");
    const ops = [
      op(1, buildSuggestionCreatePayload(id, {
        anchor, original_text: "brown fox", proposed_text: "red hen", author, rationale: "clearer", reaction: null,
      }), "2026-06-29T00:00:00.000Z"),
      op(2, buildSuggestionTransitionPayload(id, "accepted", { applied_edit_op_id: 42 }), "2026-06-29T00:01:00.000Z"),
    ];
    const rec = reconstructSuggestion(ops, ART, id)!;
    expect(rec.state).toBe("accepted");
    expect(rec.applied_edit_op_id).toBe(42);
    expect(rec.updated_at).toBe("2026-06-29T00:01:00.000Z");
  });

  it("returns null for an unknown suggestion_id", () => {
    expect(reconstructSuggestion([], ART, "phid:sug-nope")).toBeNull();
  });

  it("lists multiple suggestions newest-created first", () => {
    const a = mintSuggestionId();
    const b = mintSuggestionId();
    const base = { anchor: anchorFor(BODY, "brown fox"), original_text: "brown fox", proposed_text: "x", author, rationale: "r", reaction: null };
    const ops = [
      op(1, buildSuggestionCreatePayload(a, base), "2026-06-29T00:00:00.000Z"),
      op(2, buildSuggestionCreatePayload(b, base), "2026-06-29T01:00:00.000Z"),
    ];
    const all = reconstructSuggestions(ops, ART);
    expect(all.map((s) => s.suggestion_id)).toEqual([b, a]);
  });
});
