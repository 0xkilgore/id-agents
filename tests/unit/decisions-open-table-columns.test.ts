// S1 — the decisions producer must locate the Status column by HEADER NAME, not
// a fixed index. The canonical "## OPEN ≤60s items" table is 4 columns
// (| # | One-line | Recommend | Status |); the legacy "## Maestra summary" table
// is 3. A hardcoded cells[2] read the Recommend column on the real file and
// surfaced ZERO open items even though #53/#54 were open.

import { describe, it, expect } from "vitest";
import { parseDecisionsSourceMarkdown } from "../../src/decisions/producer.js";
import { defaultDecisionsSourcePath } from "../../src/decisions/routes.js";

const FOUR_COL = `# Kapelle decisions queue

## OPEN ≤60s items (canonical lookup; rebuilt on every resolution)

**7 genuinely open ≤60s items** as of 2026-06-16.

| # | One-line | Recommend | Status |
|---|---|---|---|
| 53 | Cane FIX 1 — \`/agent-done\` doc/rename. **PARTLY SUPERSEDED** | Chris RE-CHECK before dispatch | OPEN — Chris re-check needed before Roger dispatch |
| 54 | Cane FIX 2 — dashboard data.json auto-commit | pending Chris read | OPEN — Chris yes unblocks Roger dispatch |
| 77 | AGPL/OSS-lift standing directive | YES — STANDING RULE | **RESOLVED 2026-06-16 PM** — Maestra encoding |
| 78 | Operator-trust artifact-accessibility | YES adopted | **RESOLVED 2026-06-16 PM** |

(Rebuild rule note.)

## Resolved — grouped by date
`;

describe("producer — open-items table column resolution", () => {
  it("surfaces OPEN rows from the real 4-column table (Status is the LAST column)", () => {
    const r = parseDecisionsSourceMarkdown(FOUR_COL, { source_path: "/tmp/decisions.md" });
    const openIds = r.open.map((o) => o.display_id).sort();
    expect(openIds).toEqual(["#53", "#54"]);
  });

  it("does NOT treat RESOLVED rows in the same table as open", () => {
    const r = parseDecisionsSourceMarkdown(FOUR_COL, { source_path: "/tmp/decisions.md" });
    expect(r.open.find((o) => o.display_id === "#77")).toBeUndefined();
    expect(r.open.find((o) => o.display_id === "#78")).toBeUndefined();
  });

  it("carries the one-line text from the One-line column (not Recommend/Status)", () => {
    const r = parseDecisionsSourceMarkdown(FOUR_COL, { source_path: "/tmp/decisions.md" });
    const row53 = r.open.find((o) => o.display_id === "#53");
    expect(row53?.one_line).toMatch(/Cane FIX 1/);
  });

  it("still parses the legacy 3-column '## Maestra summary' table", () => {
    const threeCol = `## Maestra summary of what Chris owes

| # | One-line | Status |
|---|---|---|
| 9 | A genuinely open question | open |
| 10 | A resolved one | resolved |
`;
    const r = parseDecisionsSourceMarkdown(threeCol, { source_path: "/tmp/d.md" });
    expect(r.open.map((o) => o.display_id)).toEqual(["#9"]);
  });

  it("resolves the Status column even when it is not last", () => {
    const md = `## OPEN ≤60s items

| # | Status | One-line |
|---|---|---|
| 12 | open | something Chris owes |
`;
    const r = parseDecisionsSourceMarkdown(md, { source_path: "/tmp/d.md" });
    expect(r.open.map((o) => o.display_id)).toEqual(["#12"]);
    expect(r.open[0].one_line).toBe("something Chris owes");
  });
});

describe("defaultDecisionsSourcePath", () => {
  it("honors DECISIONS_QUEUE_SOURCE_PATH", () => {
    expect(defaultDecisionsSourcePath({ DECISIONS_QUEUE_SOURCE_PATH: "/x/y.md" } as NodeJS.ProcessEnv)).toBe("/x/y.md");
  });
  it("falls back to the canonical agent-platform path", () => {
    expect(defaultDecisionsSourcePath({} as NodeJS.ProcessEnv)).toMatch(/agent-platform\/output\/kapelle-decisions-queue\.md$/);
  });
});
