// Kapelle decisions producer -> projection wiring tests.
//
// The producer reads Maestra's canonical decisions source markdown,
// classifies each row as open / resolved / superseded / declined, and
// upserts into the manager decisions table. Re-ingest must be
// idempotent: same logical decision -> same decision_id -> single row
// (RD-001).
//
// OPEN items come from a structured summary section (the Maestra
// "summary of what Chris owes" table per the cto interim format) — never
// inferred from prose tense, heading vibes, or tail-slice reads.

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  countDecisionsByStatus,
  getDecisionById,
  listDecisions,
  migrateDecisionsTables,
} from "../../src/decisions/storage.js";
import {
  ingestDecisionsFromMarkdown,
  parseDecisionsSourceMarkdown,
  decisionStableId,
} from "../../src/decisions/producer.js";

const SOURCE_PATH = "/agent-platform/output/kapelle-decisions-queue.md";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDecisionsTables(adapter);
  return adapter;
}

describe("decisions producer — stable id (RD-001)", () => {
  it("decisionStableId is deterministic for (source_path, display_id)", () => {
    const a = decisionStableId(SOURCE_PATH, "#42");
    const b = decisionStableId(SOURCE_PATH, "#42");
    expect(a).toBe(b);
    expect(a).toMatch(/^dec_[a-f0-9]{16}$/);
    const c = decisionStableId(SOURCE_PATH, "#43");
    expect(c).not.toBe(a);
    const d = decisionStableId("/other/path.md", "#42");
    expect(d).not.toBe(a);
  });

  it("the id does NOT depend on the title — title edits leave the id intact", () => {
    const a = decisionStableId(SOURCE_PATH, "#42");
    // Title is intentionally not an argument: stable id only varies on
    // (source_path, display_id). Same display_id under the same source
    // path always resolves to the same row.
    expect(typeof decisionStableId).toBe("function");
    expect(decisionStableId.length).toBe(2);
    expect(decisionStableId(SOURCE_PATH, "#42")).toBe(a);
  });
});

describe("decisions producer — parser surfaces OPEN from the Maestra summary table, not prose", () => {
  it("imports table rows under '## Maestra summary' as open decisions", () => {
    const md = `
# Kapelle Decisions Queue — Open ≤60s items for Chris

## From the source section A

99. **A genuinely open question?** Recommend: yes.

100. **A resolved question?** → **RESOLVED 2026-06-09 (Chris approved):** done.

## Maestra summary of what Chris owes

| # | One-line | Status |
|---|---|---|
| 99 | A genuinely open question | open |
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open.map((o) => o.display_id)).toEqual(["#99"]);
    expect(result.open[0].one_line).toBe("A genuinely open question");
    expect(result.resolved.map((r) => r.display_id)).toEqual(["#100"]);
    expect(result.resolved[0].status).toBe("resolved");
    expect(result.skipped.map((s) => s.display_id)).toEqual([]);
  });

  it("returns 0 open when the summary table is empty (matches real-data current state)", () => {
    const md = `
## From a source section

42. **An item that got resolved?** → **RESOLVED 2026-06-09:** done.

## Maestra summary of what Chris owes (rebuilt 2026-06-09 evening — second pass)

**Genuinely open items only.** All N items in the prior table were ruled.

| # | One-line | Status |
|---|---|---|

**0 genuinely open decisions** as of 2026-06-09 evening.
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open).toEqual([]);
    expect(result.resolved.map((r) => r.display_id)).toEqual(["#42"]);
  });

  it("never produces open from prose alone — a row with no marker and no summary entry is SKIPPED, never open", () => {
    const md = `
## From a section

7. **Question that sounds open in prose tense?** Recommend: yes.

## Maestra summary

| # | One-line | Status |
|---|---|---|
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open).toEqual([]);
    // #7 isn't in the summary AND has no resolution marker, so it's
    // skipped — not silently coerced to open or resolved.
    expect(result.skipped.map((s) => s.display_id)).toEqual(["#7"]);
    expect(result.skipped[0].reason).toMatch(/no_explicit_status_marker/);
  });

  it("REGRESSION — #42-#45 verbatim from the live file all classify as resolved, none as open", () => {
    const md = `
## From the calendar product scope

42. **Add \`Event\` document model + typed Event ops to the Tier-1 task sweep proof case scope?** → **RESOLVED 2026-06-09 (Chris approved):** Event is the fourth Tier-1 sibling.

43. **Adopt RFC 5545 \`RRULE\` as Kapelle's recurrence shape?** → **RESOLVED 2026-06-09 (Chris approved):** RFC 5545 RRULE is canonical.

44. **OP-9 calendar widget on /ops/Today?** → **RESOLVED 2026-06-09 (Chris approved):** OP-9 is the Today/This Week calendar widget.

45. **Face B + Face C deferred?** → **RESOLVED 2026-06-09 (Chris approved):** Face A ships first; face B/C deferred.

## Maestra summary

| # | One-line | Status |
|---|---|---|
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open).toEqual([]);
    expect(result.resolved.map((r) => r.display_id).sort()).toEqual(["#42", "#43", "#44", "#45"]);
  });

  it("when the summary contains an open item not present in any source-doc section, the table one-line is used as the title", () => {
    const md = `
## From a section

10. **An unrelated resolved item?** → **RESOLVED 2026-06-09:** done.

## Maestra summary

| # | One-line | Status |
|---|---|---|
| 99 | Standalone summary-only open item | open |
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open).toHaveLength(1);
    expect(result.open[0].display_id).toBe("#99");
    expect(result.open[0].one_line).toBe("Standalone summary-only open item");
  });

  it("status mapping covers all four Maestra taxonomy values via the summary table", () => {
    const md = `
## From a section

1. **An open question?** Recommend: yes.
2. **A resolved question?** → **RESOLVED 2026-06-09:** done.
3. **A superseded question?** → **SUPERSEDED 2026-06-08:** replaced.
4. **A declined question?** → **DECLINED 2026-06-09:** declined.

## Maestra summary

| # | One-line | Status |
|---|---|---|
| 1 | An open question | open |
`;
    const result = parseDecisionsSourceMarkdown(md, { source_path: SOURCE_PATH });
    expect(result.open.map((r) => r.display_id)).toEqual(["#1"]);
    const byStatus = (s: string) => result.resolved.filter((r) => r.status === s).map((r) => r.display_id);
    expect(byStatus("resolved")).toEqual(["#2"]);
    expect(byStatus("superseded")).toEqual(["#3"]);
    expect(byStatus("declined")).toEqual(["#4"]);
  });
});

describe("decisions producer — ingestFromMarkdown upsert + idempotency", () => {
  it("inserts new rows on first ingest and reports counts", async () => {
    const adapter = await setup();
    const md = `
## From a section

10. **An open question?** Recommend: yes.
11. **A resolved question?** → **RESOLVED 2026-06-09 (Chris):** done.

## Maestra summary

| # | One-line | Status |
|---|---|---|
| 10 | An open question | open |
`;
    const result = await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: md,
    });
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.open_count).toBe(1);
    expect(result.skipped).toHaveLength(0);

    expect(await countDecisionsByStatus(adapter, "open")).toBe(1);
    expect(await countDecisionsByStatus(adapter, "resolved")).toBe(1);

    // Decision_id is stable across re-ingest -> upsert path -> no dup rows.
    const replay = await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: md,
    });
    expect(replay.inserted).toBe(0);
    expect(replay.updated).toBe(2);
    expect(await countDecisionsByStatus(adapter, "open")).toBe(1);
    expect(await countDecisionsByStatus(adapter, "resolved")).toBe(1);
  });

  it("re-ingest preserves decision_id even when titles in the source change (RD-001)", async () => {
    const adapter = await setup();
    const v1 = `
## From a section

20. **Original title for the question?** → **RESOLVED 2026-06-09:** done.
`;
    await ingestDecisionsFromMarkdown(adapter, { source_path: SOURCE_PATH, source_md: v1 });
    const id1 = decisionStableId(SOURCE_PATH, "#20");
    const before = await getDecisionById(adapter, id1);
    expect(before?.title).toMatch(/Original title/);

    const v2 = `
## From a section

20. **Edited title for the question — Maestra reworded?** → **RESOLVED 2026-06-09:** done.
`;
    const replay = await ingestDecisionsFromMarkdown(adapter, { source_path: SOURCE_PATH, source_md: v2 });
    expect(replay.inserted).toBe(0);
    expect(replay.updated).toBe(1);
    const after = await getDecisionById(adapter, id1);
    expect(after?.decision_id).toBe(id1);
    expect(after?.title).toMatch(/Edited title/);
  });

  it("status transition: a previously-open item later marked resolved by Maestra flips status on re-ingest", async () => {
    const adapter = await setup();
    const open = `
## From a section

30. **Open question?** Recommend: yes.

## Maestra summary

| # | One-line | Status |
|---|---|---|
| 30 | Open question | open |
`;
    await ingestDecisionsFromMarkdown(adapter, { source_path: SOURCE_PATH, source_md: open });
    expect(await countDecisionsByStatus(adapter, "open")).toBe(1);

    const closed = `
## From a section

30. **Open question?** → **RESOLVED 2026-06-09 (Chris approved):** decided.

## Maestra summary

| # | One-line | Status |
|---|---|---|
`;
    await ingestDecisionsFromMarkdown(adapter, { source_path: SOURCE_PATH, source_md: closed });
    expect(await countDecisionsByStatus(adapter, "open")).toBe(0);
    expect(await countDecisionsByStatus(adapter, "resolved")).toBe(1);
    const row = await getDecisionById(adapter, decisionStableId(SOURCE_PATH, "#30"));
    expect(row?.status).toBe("resolved");
    expect(row?.resolved_at).toBeTruthy();
  });

  it("ingest result includes parser_version + source_hash for provenance", async () => {
    const adapter = await setup();
    const md = `
## Test

1. **Q?** → **RESOLVED 2026-06-09:** done.
`;
    const result = await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: md,
    });
    expect(result.parser_version).toBeTruthy();
    expect(result.source_hash).toMatch(/^[a-f0-9]{16,}$/);
  });
});

describe("decisions producer — real data smoke", () => {
  it("ingests the live kapelle-decisions-queue.md: open_count is consistent with the stored open rows and matches the file's OPEN-status table rows", async () => {
    const adapter = await setup();
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const live = path.resolve(
      "/Users/kilgore/Dropbox/Code/agent-platform/output/kapelle-decisions-queue.md",
    );
    const exists = await fs
      .access(live)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      // Real file not present in this checkout — the fixture coverage in
      // decisions-open-table-columns.test.ts is the deterministic contract.
      console.log(`[decisions-producer] live source not present; skipping real-data smoke: ${live}`);
      return;
    }
    const md = await fs.readFile(live, "utf8");
    const result = await ingestDecisionsFromMarkdown(adapter, {
      source_path: live,
      source_md: md,
    });
    const open = await listDecisions(adapter, { status: "open" });

    // Ingestion populated the table (so /decisions/queue is backed by live data).
    expect(result.inserted + result.updated).toBeGreaterThan(0);
    // open_count is internally consistent with what was actually stored open.
    expect(result.open_count).toBe(open.length);
    // Every stored open row is well-formed (status open + a #N display id).
    for (const d of open) {
      expect(d.status).toBe("open");
      expect(d.display_id).toMatch(/^#\d+$/);
    }
    // Re-derive the expectation from the file: count rows in the "OPEN ≤60s
    // items" table whose Status column says OPEN (not RESOLVED/SUPERSEDED).
    // This guards the column-resolution fix against the REAL source format
    // without brittly pinning a number Maestra edits over time.
    const expectedOpen = countOpenStatusRows(md);
    expect(result.open_count).toBe(expectedOpen);
  });
});

/** Independently count OPEN-status rows in the "OPEN ≤60s items" pipe table. */
function countOpenStatusRows(md: string): number {
  const lines = md.split(/\r?\n/);
  let inSection = false;
  let statusIdx = -1;
  let headerSeen = false;
  let count = 0;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (inSection) break;
      inSection = /open\s+[≤<=]?\s*60s\s+items/i.test(h[1]) || /maestra summary/i.test(h[1]);
      headerSeen = false;
      statusIdx = -1;
      continue;
    }
    if (!inSection) continue;
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (!headerSeen) {
      headerSeen = true;
      const i = cells.findIndex((c) => /status/i.test(c));
      statusIdx = i >= 0 ? i : cells.length - 1;
      continue;
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // separator
    if (statusIdx < 0 || cells.length <= statusIdx) continue;
    if (!/^#?\d+$/.test(cells[0])) continue;
    const status = cells[statusIdx].toLowerCase();
    if (/^\**\s*(resolved|superseded|declined)/.test(status)) continue;
    if (/\bopen\b/.test(status)) count++;
  }
  return count;
}
