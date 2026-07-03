// Kapelle decisions producer -> projection wiring.
//
// Reads Maestra's canonical decisions source markdown
// (agent-platform/output/kapelle-decisions-queue.md) and upserts each
// classified row into the manager `decisions` table.
//
// Three rules, all from the cto scope
// (2026-06-09-decision-queue-structured-status-scope.md):
//
//   1. Stable IDs (RD-001). decision_id is sha256(source_path + ":" +
//      display_id), so the same logical row resolves to the same id
//      across every re-ingest even when title prose is edited. Upsert
//      semantics make re-ingest idempotent: no duplicate rows ever.
//
//   2. OPEN is structured, not prose. A decision is imported with
//      status=open ONLY when the Maestra "summary of what Chris owes"
//      table explicitly lists it as open. The parser NEVER coerces a
//      row to status=open from prose tense, heading vibes, or
//      tail-slice reads. Rows with no explicit marker and no summary
//      entry are reported in `skipped[]` and left out of the table.
//
//   3. Resolved/superseded/declined come from the existing safe
//      bootstrap parser (parseDecisionsMarkdown), which only accepts
//      "→ **RESOLVED|SUPERSEDED|DECLINED <date>**" markers and
//      "**DUPLICATE OF #N" duplicate flags. Markdown prose is never
//      sufficient.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { DbAdapter } from "../db/db-adapter.js";
import {
  BOOTSTRAP_PARSER_VERSION,
  parseDecisionsMarkdown,
  type BootstrapSkipped,
} from "./bootstrap.js";
import { upsertDecision } from "./storage.js";
import type { DecisionRow, SourceRef } from "./types.js";

export const PRODUCER_PARSER_VERSION = "decisions.producer.v1";

export interface SummaryOpenItem {
  display_id: string;
  one_line: string;
  summary_status: string;
}

export interface ParseSourceResult {
  open: SummaryOpenItem[];
  resolved: DecisionRow[];
  skipped: BootstrapSkipped[];
  parser_version: string;
  source_path: string;
}

export interface IngestOptions {
  source_path: string;
  source_md?: string;
  now?: string;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  open_count: number;
  resolved_count: number;
  superseded_count: number;
  declined_count: number;
  skipped: BootstrapSkipped[];
  parser_version: string;
  source_hash: string;
  source_path: string;
}

/**
 * Compute the stable decision_id for a (source_path, display_id) pair.
 * This is the canonical RD-001 identity for a Maestra-sourced decision:
 * the title can be edited without changing the id, but a renumber in
 * Maestra's source IS a new logical row.
 */
export function decisionStableId(source_path: string, display_id: string): string {
  const digest = createHash("sha256")
    .update(`${source_path}:${display_id}`)
    .digest("hex")
    .slice(0, 16);
  return `dec_${digest}`;
}

/**
 * Read the human-declared open count from the decisions-queue header line
 * (`**N genuinely open ≤60s items** as of …`). This is prose, NOT a status
 * signal — the producer never gates open/resolved on it. It exists only so the
 * "false-open bug class" can be MACHINE-checked: a reconciled file's declared
 * count must equal the number of rows the structured parser actually imports as
 * open (see decisions-rd007-open-parity.test.ts). Returns null when no such
 * line is present, so callers can distinguish "no claim" from "claims zero".
 */
export function parseDeclaredOpenCount(md: string): number | null {
  const m = md.match(/(\d+)\s+genuinely\s+open\b/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Two-pass parser that distinguishes the structured OPEN signal
 * (Maestra summary table) from the structured RESOLVED signal
 * (per-item "→ **RESOLVED..." markers). Rows that satisfy NEITHER
 * structured signal are reported in result.skipped[].
 */
export function parseDecisionsSourceMarkdown(
  md: string,
  opts: { source_path: string; now?: string },
): ParseSourceResult {
  const now = opts.now ?? new Date().toISOString();

  // Pass 1: the existing safe bootstrap parser handles RESOLVED /
  // SUPERSEDED / DECLINED + DUPLICATE markers and surfaces every other
  // row in `skipped`.
  const resolved = parseDecisionsMarkdown(md, { source_path: opts.source_path, now });

  // Pass 2: the Maestra summary table — the canonical OPEN source. Only
  // table rows whose Status column matches /open/i count as open.
  const summary = parseMaestraSummaryTable(md);

  // Any item present in the summary table as `open` is REMOVED from the
  // skipped[] list — that's the signal that promotes it from "no
  // marker" to "explicit open". An item whose source-doc section
  // already had a resolution marker AND who also appears in the summary
  // as `open` is treated as a Maestra-side inconsistency; the summary
  // wins (open), and we surface a warning by leaving it in resolved[]
  // too — but the producer upserts `open` last so the final stored
  // status is `open`. Practically, this never happens in Maestra's
  // current file.
  const openDisplayIds = new Set(summary.map((s) => s.display_id));
  const skipped = resolved.skipped.filter((s) => !openDisplayIds.has(s.display_id));

  return {
    open: summary,
    resolved: resolved.decisions,
    skipped,
    parser_version: `${PRODUCER_PARSER_VERSION}+${BOOTSTRAP_PARSER_VERSION}`,
    source_path: opts.source_path,
  };
}

/**
 * Read + parse + upsert. Reads the file from disk when `source_md` is
 * omitted; otherwise uses the in-memory string (lets tests run without
 * touching the filesystem).
 */
export async function ingestDecisionsFromMarkdown(
  adapter: DbAdapter,
  opts: IngestOptions,
): Promise<IngestResult> {
  const now = opts.now ?? new Date().toISOString();
  const md = opts.source_md ?? (await fs.readFile(opts.source_path, "utf8"));
  const parsed = parseDecisionsSourceMarkdown(md, { source_path: opts.source_path, now });
  const sourceHash = createHash("sha256").update(md).digest("hex").slice(0, 16);

  let inserted = 0;
  let updated = 0;

  // Apply resolved/superseded/declined first so any conflict with
  // summary-open gets overwritten by the open upsert below.
  for (const decision of parsed.resolved) {
    const row = stabilizeRow(decision, opts.source_path, now);
    const outcome = await upsertDecision(adapter, row);
    if (outcome === "inserted") inserted++;
    else updated++;
  }

  for (const open of parsed.open) {
    const row = buildOpenRow({
      open,
      resolvedRows: parsed.resolved,
      source_path: opts.source_path,
      now,
    });
    const outcome = await upsertDecision(adapter, row);
    if (outcome === "inserted") inserted++;
    else updated++;
  }

  const open_count = parsed.open.length;
  const resolved_count = parsed.resolved.filter((r) => r.status === "resolved").length;
  const superseded_count = parsed.resolved.filter((r) => r.status === "superseded").length;
  const declined_count = parsed.resolved.filter((r) => r.status === "declined").length;

  return {
    inserted,
    updated,
    open_count,
    resolved_count,
    superseded_count,
    declined_count,
    skipped: parsed.skipped,
    parser_version: parsed.parser_version,
    source_hash: sourceHash,
    source_path: opts.source_path,
  };
}

function stabilizeRow(decision: DecisionRow, source_path: string, now: string): DecisionRow {
  // The bootstrap parser already produces a decision_id, but we re-
  // compute via the stable formula here so every Maestra-sourced row
  // produced by the producer uses the SAME identity scheme — guarantees
  // RD-001 idempotency across mixed-path mounts.
  const display_id = decision.display_id ?? "#0";
  return {
    ...decision,
    decision_id: decisionStableId(source_path, display_id),
    updated_at: now,
  };
}

function buildOpenRow(opts: {
  open: SummaryOpenItem;
  resolvedRows: DecisionRow[];
  source_path: string;
  now: string;
}): DecisionRow {
  const { open, resolvedRows, source_path, now } = opts;
  // Prefer the title from the matching source-doc section when present;
  // fall back to the summary one_line otherwise.
  const sourceRow = resolvedRows.find((r) => r.display_id === open.display_id);
  const title = sourceRow?.title ?? open.one_line;
  const question = sourceRow?.question ?? open.one_line;
  const sourceRefs: SourceRef[] = [
    {
      kind: "decision_doc",
      stable_id: source_path,
      display_id: open.display_id,
      title,
      href: null,
    },
  ];
  const provenance = {
    source_path,
    source_anchor: open.display_id,
    source_hash: null,
    parser_version: PRODUCER_PARSER_VERSION,
    originating_artifact_id: null,
    originating_task_name: null,
    originating_dispatch_id: null,
  };
  return {
    decision_id: decisionStableId(source_path, open.display_id),
    display_id: open.display_id,
    title,
    question,
    context_excerpt: sourceRow?.context_excerpt ?? null,
    recommendation_json: null,
    options_json: null,
    status: "open",
    estimated_seconds: 60,
    priority: "normal",
    owner: "chris",
    requested_by: "maestra",
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    selected_option_id: null,
    source_refs_json: JSON.stringify(sourceRefs),
    provenance_json: JSON.stringify(provenance),
  };
}

/**
 * Scan the markdown for the Maestra summary section and extract any
 * pipe-delimited table rows whose Status column is "open".
 *
 * Recognised section headings (case-insensitive substring match):
 *   "## Maestra summary"
 *   "## OPEN ≤60s items" / "## OPEN <=60s items"
 *
 * The first matching section wins. Table layout follows the cto interim
 * structure:
 *
 *   | # | One-line | Status |
 *   |---|---|---|
 *   | 99 | Some open question | open |
 *
 * Rows whose Status column is NOT "open" are filtered out — only the
 * explicit open signal is surfaced.
 */
function parseMaestraSummaryTable(md: string): SummaryOpenItem[] {
  const lines = md.split(/\r?\n/);
  let inSummarySection = false;
  let headerSeen = false;
  let separatorSeen = false;
  // Column indices resolved from the HEADER row by name — NOT positionally.
  // The canonical "## OPEN ≤60s items" table is 4 columns
  // (| # | One-line | Recommend | Status |); the legacy "## Maestra summary"
  // table is 3 (| # | One-line | Status |). Reading the Status column by its
  // header keeps both layouts (and any future column inserts) working.
  let numIdx = 0;
  let oneLineIdx = 1;
  let statusIdx = -1;
  const out: SummaryOpenItem[] = [];

  const splitCells = (row: string): string[] =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      const looksLikeSummary =
        title.includes("maestra summary") ||
        title.match(/open\s+[≤<=]?\s*60s\s+items/) !== null ||
        title.match(/^open[: ]/i) !== null;
      if (looksLikeSummary) {
        inSummarySection = true;
        headerSeen = false;
        separatorSeen = false;
        numIdx = 0;
        oneLineIdx = 1;
        statusIdx = -1;
        continue;
      }
      if (inSummarySection) break; // hit the next section — stop
      continue;
    }
    if (!inSummarySection) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = splitCells(trimmed);

    if (!headerSeen) {
      // First pipe row is the header — resolve column indices by name.
      headerSeen = true;
      const lower = cells.map((c) => c.toLowerCase());
      const findIdx = (re: RegExp, dflt: number) => {
        const i = lower.findIndex((c) => re.test(c));
        return i >= 0 ? i : dflt;
      };
      numIdx = findIdx(/^#$|number|item|^id$/, 0);
      oneLineIdx = findIdx(/one.?line|question|title|summary/, 1);
      // Status is the canonical signal — if there is no explicit Status
      // header, fall back to the LAST column (closest to the historical
      // 3-column assumption) rather than a fixed index.
      statusIdx = findIdx(/status/, cells.length - 1);
      continue;
    }
    if (!separatorSeen) {
      const isSeparator = cells.every((c) => /^:?-{3,}:?$/.test(c));
      if (isSeparator) {
        separatorSeen = true;
        continue;
      }
      // Separator missing/bundled — fall through and treat as a data row.
    }
    // A data row.
    if (statusIdx < 0 || cells.length <= statusIdx) continue;
    const numCell = cells[numIdx] ?? "";
    const oneLine = cells[oneLineIdx] ?? "";
    const status = (cells[statusIdx] ?? "").toLowerCase();
    const m = numCell.match(/^#?(\d+)$/);
    if (!m) continue;
    // Only the explicit OPEN signal counts. A Status cell that begins with a
    // resolution marker (RESOLVED/SUPERSEDED/DECLINED) is never open, even if
    // the word "open" appears later in the prose.
    if (/^\**\s*(resolved|superseded|declined)/.test(status)) continue;
    if (!/\bopen\b/.test(status)) continue;
    out.push({
      display_id: `#${m[1]}`,
      one_line: oneLine,
      summary_status: status,
    });
  }

  return out;
}
