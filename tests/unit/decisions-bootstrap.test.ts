// Kapelle decisions queue — safe-only markdown bootstrap importer tests.
//
// Per the cto scope: "accept ONLY explicit structured/fenced records or
// an operator-reviewed migration map. Do NOT ship a parser whose
// correctness depends on 'nearby prose says resolved'. If items can't
// be safely classified, leave them out and report them, don't guess."
//
// The parser recognises these unambiguous structured markers ONLY:
//   "→ **RESOLVED YYYY-MM-DD..." -> status: resolved
//   "→ **SUPERSEDED YYYY-MM-DD..." -> status: superseded
//   "→ **DECLINED YYYY-MM-DD..."  -> status: declined
//   "**DUPLICATE OF #N — RESOLVED..." -> status: superseded (with note)
//
// Any decision row whose status marker is missing or ambiguous is
// REPORTED in the result.skipped array and NOT imported.

import { describe, it, expect } from "vitest";
import { parseDecisionsMarkdown } from "../../src/decisions/bootstrap.js";

describe("decisions bootstrap — safe-only markdown parser", () => {
  it("imports a row only when an explicit structured RESOLVED/SUPERSEDED/DECLINED marker is present", () => {
    const md = `
## From the example doc

1. **First decision question?** Recommend: yes. → **RESOLVED 2026-06-09 (Chris approved):** done.

2. **Second decision question?** Recommend: no. → **SUPERSEDED 2026-06-08:** replaced by #5.

3. **Third decision question?** Recommend: maybe. → **DECLINED 2026-06-09:** Chris declined.

4. **Ambiguous open-looking question with no marker?** Recommend: yes.
`;
    const result = parseDecisionsMarkdown(md, {
      source_path: "/agent-platform/output/kapelle-decisions-queue.md",
    });

    expect(result.decisions.map((d) => d.display_id)).toEqual(["#1", "#2", "#3"]);
    expect(result.decisions.find((d) => d.display_id === "#1")?.status).toBe("resolved");
    expect(result.decisions.find((d) => d.display_id === "#2")?.status).toBe("superseded");
    expect(result.decisions.find((d) => d.display_id === "#3")?.status).toBe("declined");

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].display_id).toBe("#4");
    expect(result.skipped[0].reason).toMatch(/no_explicit_status_marker/);
  });

  it("treats `**DUPLICATE OF #N` as superseded — never as open — and notes the link", () => {
    const md = `
## Section

11. **Same question as #7?** **DUPLICATE OF #7 — RESOLVED via batch item 4.**
`;
    const result = parseDecisionsMarkdown(md, { source_path: "/x.md" });
    expect(result.decisions).toHaveLength(1);
    const row = result.decisions[0];
    expect(row.display_id).toBe("#11");
    expect(row.status).toBe("superseded");
    expect(row.resolution_note).toContain("DUPLICATE OF #7");
  });

  it("never marks a row open even when prose 'feels open' — open requires explicit operator action, not parser inference", () => {
    // Cto scope's named test #1: a fixture where prose contains an old
    // open question PLUS an inline resolved marker. The structured-status
    // query MUST exclude it. Verified at the parser layer: the import
    // step never produces status:open from prose alone — the absence of
    // a marker is a SKIP, not an open import. The presence of a marker
    // wins (no guessing).
    const md = `
## Section

5. **This question is in present tense — sounds open to a human reader.** Recommend: yes. → **RESOLVED 2026-06-09:** Chris confirmed.

6. **Genuinely no marker on this question — sounds equally open.** Recommend: yes.
`;
    const result = parseDecisionsMarkdown(md, { source_path: "/x.md" });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].display_id).toBe("#5");
    expect(result.decisions[0].status).toBe("resolved");

    // #6 was skipped — not imported as 'open' even though the prose tense
    // matches the open style.
    expect(result.decisions.find((d) => d.display_id === "#6")).toBeUndefined();
    expect(result.skipped.find((s) => s.display_id === "#6")).toBeDefined();
    expect(result.skipped.find((s) => s.display_id === "#6")?.reason).toMatch(/no_explicit_status_marker/);
  });

  it("REGRESSION — #42 #43 #44 #45 calendar records with the real markdown all import as resolved (none as open)", () => {
    // Verbatim shape of the real lines from
    // agent-platform/output/kapelle-decisions-queue.md as of 2026-06-09.
    // The incident was: prose-tail-read importer marked these as open.
    // The structured parser MUST mark them resolved.
    const md = `
## From the calendar product scope

42. **Add \`Event\` document model + typed Event ops to the Tier-1 task sweep proof case scope (alongside Task + Inbox + Dispatch)?** → **RESOLVED 2026-06-09 (Chris approved):** Event is the fourth Tier-1 sibling. Encoded in operator-tilt board direction call 3b.

43. **Adopt RFC 5545 \`RRULE\` as Kapelle's recurrence shape (no custom recurrence DSL)?** → **RESOLVED 2026-06-09 (Chris approved):** RFC 5545 RRULE is canonical. Encoded across calendar product scope.

44. **OP-9 (\`/ops/calendar\` view) as a new Tier-2 operator-productivity track slot, sequenced after OP-1 ships?** → **RESOLVED 2026-06-09 (Chris approved); RECONFIRMED 2026-06-09 evening with product-framing split:** OP-9 is the Today/This Week calendar widget on /ops/Today (read-only MVP).

45. **Face B (external calendar sync — Google/Apple bidirectional) and face C (consistent ICS invite format via email channel adapter) stay deferred to a separate later workstream after OP-9 + Tier-1 substrate exercise stabilize?** → **RESOLVED 2026-06-09 (Chris approved):** Face A (OP-9 calendar band) ships first; face B/C deferred to a separate later workstream.
`;
    const result = parseDecisionsMarkdown(md, {
      source_path: "/agent-platform/output/kapelle-decisions-queue.md",
    });

    expect(result.decisions.map((d) => d.display_id).sort()).toEqual(["#42", "#43", "#44", "#45"]);
    for (const d of result.decisions) {
      expect(d.status).toBe("resolved");
      expect(d.resolved_at).toMatch(/^2026-06-09/);
    }
    expect(result.skipped).toHaveLength(0);
  });

  it("populates source_refs_json + provenance_json with the section path + anchor for forensic trace", () => {
    const md = `
## From the OpenHermit competitive analysis (\`output/2026-06-08-openhermit-competitive-analysis.md\`)

26. **Add OP-4 — Telegram channel-adapter v0?** Recommend: yes. → **RESOLVED 2026-06-09 (Chris approved batch item 14):** OP-4 greenlit.
`;
    const result = parseDecisionsMarkdown(md, {
      source_path: "/agent-platform/output/kapelle-decisions-queue.md",
    });

    expect(result.decisions).toHaveLength(1);
    const row = result.decisions[0];
    const refs = JSON.parse(row.source_refs_json) as Array<Record<string, unknown>>;
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "decision_doc", stable_id: "/agent-platform/output/kapelle-decisions-queue.md" }),
      ]),
    );
    const prov = JSON.parse(row.provenance_json) as Record<string, unknown>;
    expect(prov.source_path).toBe("/agent-platform/output/kapelle-decisions-queue.md");
    expect(typeof prov.parser_version).toBe("string");
  });

  it("returns an empty result.decisions array when the markdown is empty or has no numbered items", () => {
    const result = parseDecisionsMarkdown("", { source_path: "/x.md" });
    expect(result.decisions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
