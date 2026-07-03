// RD-007 — decisions-queue OPEN-table parity (the "false-open bug class").
//
// Fable critique 2026-07-01 found kapelle-decisions-queue.md serving a stale
// OPEN table: 7 rows resolved 2026-06-16 PM were sitting in the OPEN table
// in-place while the header still declared "7 genuinely open" — but only 2
// (#53, #54) were actually open. The producer already parses status
// structurally (a RESOLVED-marked Status cell is never counted open), so the
// defect was pure markdown hygiene. This test locks the parity the reconciled
// file must hold, and proves the pre-fix shape WOULD fail it:
//
//   (a) declared header count == rows imported as status=open
//   (b) no OPEN-table row counted open carries a RESOLVED/SUPERSEDED/DECLINED
//       status string
//   (c) the manager's stored open rows (what GET /decisions/queue?status=open
//       reads) match the OPEN table 1:1

import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  countDecisionsByStatus,
  listDecisions,
  migrateDecisionsTables,
} from "../../src/decisions/storage.js";
import {
  ingestDecisionsFromMarkdown,
  parseDecisionsSourceMarkdown,
  parseDeclaredOpenCount,
} from "../../src/decisions/producer.js";

const SOURCE_PATH = "/agent-platform/output/kapelle-decisions-queue.md";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateDecisionsTables(adapter);
  return adapter;
}

// A faithful minimal excerpt of the RECONCILED file: 2 genuinely-open rows in
// the OPEN table, the 2026-06-16 PM batch moved down to Resolved.
const RECONCILED_MD = `
# Kapelle Decisions Log — open + resolved (markdown authors/intakes; the manager \`decisions\` table status column is canonical post-ingest)

## OPEN ≤60s items (authoring intake; rebuilt on every resolution)

**2 genuinely open ≤60s items** as of 2026-07-02 (RD-007 reconciliation).

| # | One-line | Recommend | Status |
|---|---|---|---|
| 53 | Cane FIX 1 — /agent-done response-codes doc | Chris re-check | OPEN — Chris re-check needed before Roger dispatch |
| 54 | Cane FIX 2 — personal/dashboard data.json auto-commit | pending Chris read | OPEN — Chris yes unblocks Roger dispatch |

## Resolved — grouped by date

### 2026-06-16 PM (Loops product decisions + AGPL/OSS-lift standing rule)

- **#72 Loops PD-1 RESOLVED** → **RESOLVED 2026-06-16** — YES adopted.
- **#77 AGPL/OSS-lift standing directive RESOLVED** → **RESOLVED 2026-06-16** — STANDING RULE.
- **#78 Operator-trust artifact-accessibility scope RESOLVED** → **RESOLVED 2026-06-16** — Track T11.
`;

// The PRE-FIX (broken) shape: header declares 7 open, but 5 of the OPEN-table
// rows carry a RESOLVED status string in-place. The structured parser still
// only imports #53/#54 as open — so declared(7) != imported(2). This is the
// exact false-open bug class RD-007 fixed.
const BROKEN_MD = `
## OPEN ≤60s items (canonical lookup; rebuilt on every resolution)

**7 genuinely open ≤60s items** as of 2026-06-16.

| # | One-line | Recommend | Status |
|---|---|---|---|
| 53 | Cane FIX 1 | Chris re-check | OPEN — Chris re-check needed |
| 54 | Cane FIX 2 | pending Chris read | OPEN — Chris yes unblocks Roger |
| 72 | Loops PD-1 | YES adopted | **RESOLVED 2026-06-16 PM** |
| 73 | Loops PD-2 | YES adopted | **RESOLVED 2026-06-16 PM** |
| 74 | Loops PD-3 | YES adopted | **RESOLVED 2026-06-16 PM** |
| 77 | AGPL/OSS-lift | YES adopted | **RESOLVED 2026-06-16 PM** |
| 78 | Artifact-accessibility | YES adopted | **RESOLVED 2026-06-16 PM** |
`;

describe("RD-007 — parseDeclaredOpenCount reads the header count (prose, not status)", () => {
  it("extracts the declared 'N genuinely open' number", () => {
    expect(parseDeclaredOpenCount(RECONCILED_MD)).toBe(2);
    expect(parseDeclaredOpenCount(BROKEN_MD)).toBe(7);
  });

  it("returns null when no count line is present (no claim != claims zero)", () => {
    expect(parseDeclaredOpenCount("no header here")).toBeNull();
  });
});

describe("RD-007 — reconciled OPEN table holds parity", () => {
  it("(a) declared header count equals imported open_count", async () => {
    const adapter = await setup();
    const result = await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: RECONCILED_MD,
    });
    expect(result.open_count).toBe(2);
    expect(parseDeclaredOpenCount(RECONCILED_MD)).toBe(result.open_count);
  });

  it("(b) no OPEN-parsed row carries a resolution status string", () => {
    const parsed = parseDecisionsSourceMarkdown(RECONCILED_MD, { source_path: SOURCE_PATH });
    expect(parsed.open.map((o) => o.display_id).sort()).toEqual(["#53", "#54"]);
    for (const o of parsed.open) {
      expect(o.summary_status).not.toMatch(/resolved|superseded|declined/i);
    }
  });

  it("(c) stored open rows (what /decisions/queue reads) match the OPEN table 1:1", async () => {
    const adapter = await setup();
    await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: RECONCILED_MD,
    });
    expect(await countDecisionsByStatus(adapter, "open")).toBe(2);
    const open = await listDecisions(adapter, { status: "open", limit: 100 });
    expect(open.map((r) => r.display_id).sort()).toEqual(["#53", "#54"]);
    // The moved-down 2026-06-16 batch lands as resolved, never open — no
    // #72–#78 leaks into the open set.
    const resolvedOpenLeak = open.filter((r) => /#7[2-8]/.test(r.display_id ?? ""));
    expect(resolvedOpenLeak).toHaveLength(0);
  });
});

describe("RD-007 — the pre-fix shape FAILS the parity guard (regression proof)", () => {
  it("declared count (7) diverges from imported open_count (2) — the false-open bug", async () => {
    const adapter = await setup();
    const result = await ingestDecisionsFromMarkdown(adapter, {
      source_path: SOURCE_PATH,
      source_md: BROKEN_MD,
    });
    // The structured parser is robust — it only imports the 2 real opens…
    expect(result.open_count).toBe(2);
    // …but the human header lied ("7 genuinely open"). That mismatch IS the
    // bug class; a healthy file has declared === imported.
    expect(parseDeclaredOpenCount(BROKEN_MD)).not.toBe(result.open_count);
  });
});
