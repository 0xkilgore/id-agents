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
  let inTable = false;
  let headerSeen = false;
  let separatorSeen = false;
  const out: SummaryOpenItem[] = [];

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
        inTable = false;
        headerSeen = false;
        separatorSeen = false;
        continue;
      }
      if (inSummarySection) break; // hit the next section — stop
      continue;
    }
    if (!inSummarySection) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      // table ended on a non-pipe line; reset table state but stay in
      // section in case another table appears.
      if (inTable) inTable = false;
      continue;
    }
    // We're in a table row.
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

    if (!headerSeen) {
      // First pipe row in this section is the header; remember and move on.
      headerSeen = true;
      inTable = true;
      continue;
    }
    if (!separatorSeen) {
      // Second row is the markdown separator `---|---|---`.
      const isSeparator = cells.every((c) => /^:?-{3,}:?$/.test(c));
      if (isSeparator) {
        separatorSeen = true;
        continue;
      }
      // Sometimes the separator was bundled with the header (rare); just
      // fall through.
    }
    // A data row.
    if (cells.length < 3) continue;
    const numCell = cells[0];
    const oneLine = cells[1];
    const status = cells[2].toLowerCase();
    const m = numCell.match(/^#?(\d+)$/);
    if (!m) continue;
    if (!/open/.test(status)) continue;
    out.push({
      display_id: `#${m[1]}`,
      one_line: oneLine,
      summary_status: status,
    });
  }

  return out;
}
