// Kapelle decisions queue — safe-only markdown bootstrap importer.
//
// Cto scope: "accept ONLY explicit structured/fenced records or an
// operator-reviewed migration map. Do NOT ship a parser whose
// correctness depends on 'nearby prose says resolved'. If items can't be
// safely classified, leave them out and report them, don't guess."
//
// Recognised markers (anchored, anywhere within the decision body):
//
//   "→ **RESOLVED <date>..."   -> status: resolved
//   "→ **SUPERSEDED <date>..."  -> status: superseded
//   "→ **DECLINED <date>..."    -> status: declined
//   "**DUPLICATE OF #N ..."     -> status: superseded
//
// A decision row without any of these markers is REPORTED in
// `result.skipped` and NOT imported. The parser never produces
// `status: open` from prose alone — open decisions must be created via
// `POST /decisions` (out of this v1 scope) or through an operator-
// reviewed migration map.

import { createHash } from "node:crypto";
import type { DecisionRow, DecisionStatus, SourceRef } from "./types.js";

export const BOOTSTRAP_PARSER_VERSION = "decisions.bootstrap.v1";

export interface BootstrapOptions {
  source_path: string;
  now?: string;
}

export interface BootstrapSkipped {
  display_id: string;
  title: string;
  reason: "no_explicit_status_marker" | "malformed_header";
  detail: string;
}

export interface BootstrapResult {
  decisions: DecisionRow[];
  skipped: BootstrapSkipped[];
  parser_version: string;
  source_path: string;
}

// Match a numbered decision line. Captures: 1=number, 2=body
const ITEM_HEADER_RE = /^(\d+)\.\s+\*\*([^]*?)\*\*\s*(.*)$/;

// Recognised structured markers — captures: 1=marker word, 2=date-or-noise
const RESOLVED_RE = /→\s*\*\*\s*RESOLVED\s+(\d{4}-\d{2}-\d{2})/i;
const SUPERSEDED_RE = /→\s*\*\*\s*SUPERSEDED\s+(\d{4}-\d{2}-\d{2})/i;
const DECLINED_RE = /→\s*\*\*\s*DECLINED\s+(\d{4}-\d{2}-\d{2})/i;
const DUPLICATE_RE = /\*\*\s*DUPLICATE\s+OF\s+#(\d+)/i;

// Section heading — captures: 1=section title
const SECTION_RE = /^##\s+(.+)$/;

export function parseDecisionsMarkdown(
  md: string,
  opts: BootstrapOptions,
): BootstrapResult {
  const now = opts.now ?? new Date().toISOString();
  const lines = md.split(/\r?\n/);
  const decisions: DecisionRow[] = [];
  const skipped: BootstrapSkipped[] = [];

  let currentSection = "";
  const buffered: Array<{ number: number; title: string; body: string; startLine: number }> = [];
  let active: { number: number; title: string; body: string; startLine: number } | null = null;

  function flush(_section: string) {
    if (active) buffered.push(active);
    active = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      flush(currentSection);
      currentSection = sectionMatch[1].trim();
      continue;
    }
    const headerMatch = line.match(ITEM_HEADER_RE);
    if (headerMatch) {
      flush(currentSection);
      const num = Number(headerMatch[1]);
      const title = headerMatch[2].trim();
      const trailing = headerMatch[3] ?? "";
      active = {
        number: num,
        title,
        body: trailing,
        startLine: i,
      };
      continue;
    }
    if (active && line.trim().length > 0) {
      active.body = `${active.body}\n${line}`;
    }
    // blank line within an item is allowed; next non-blank either
    // continues the body or a new section/header flushes via the loop.
  }
  flush(currentSection);

  for (const item of buffered) {
    const display_id = `#${item.number}`;
    const fullBody = `${item.title}\n${item.body}`;
    const classification = classify(fullBody);
    if (!classification) {
      skipped.push({
        display_id,
        title: condense(item.title),
        reason: "no_explicit_status_marker",
        detail: "Row had no `→ **RESOLVED|SUPERSEDED|DECLINED <date>**` marker and no `**DUPLICATE OF #N` marker; safe parser refuses to guess open vs resolved from prose.",
      });
      continue;
    }
    const decisionIdHash = createHash("sha256")
      .update(`${opts.source_path}:#${item.number}:${item.title}`)
      .digest("hex")
      .slice(0, 16);
    const decision_id = `dec_${decisionIdHash}`;
    const sourceRefs: SourceRef[] = [
      {
        kind: "decision_doc",
        stable_id: opts.source_path,
        display_id,
        title: condense(item.title),
        href: null,
      },
    ];
    const provenance = {
      source_path: opts.source_path,
      source_anchor: display_id,
      source_hash: createHash("sha256")
        .update(fullBody)
        .digest("hex")
        .slice(0, 16),
      parser_version: BOOTSTRAP_PARSER_VERSION,
      originating_artifact_id: null,
      originating_task_name: null,
      originating_dispatch_id: null,
    };
    decisions.push({
      decision_id,
      display_id,
      title: condense(item.title),
      question: extractQuestion(item.title),
      context_excerpt: condense(item.body.slice(0, 280)),
      recommendation_json: null,
      options_json: null,
      status: classification.status,
      estimated_seconds: 60,
      priority: "normal",
      owner: "chris",
      requested_by: "maestra",
      created_at: classification.resolved_at ?? now,
      updated_at: classification.resolved_at ?? now,
      resolved_at: classification.resolved_at,
      resolved_by: classification.resolved_at ? "human:chris" : null,
      resolution_note: classification.note,
      selected_option_id: null,
      source_refs_json: JSON.stringify(sourceRefs),
      provenance_json: JSON.stringify(provenance),
    });
  }

  return {
    decisions,
    skipped,
    parser_version: BOOTSTRAP_PARSER_VERSION,
    source_path: opts.source_path,
  };
}

interface Classification {
  status: DecisionStatus;
  resolved_at: string | null;
  note: string | null;
}

function classify(body: string): Classification | null {
  const dup = body.match(DUPLICATE_RE);
  if (dup) {
    // A duplicate is canonically SUPERSEDED — the original carries the status.
    const resolvedMatch = body.match(RESOLVED_RE);
    return {
      status: "superseded",
      resolved_at: resolvedMatch ? toIso(resolvedMatch[1]) : null,
      note: `DUPLICATE OF #${dup[1]}`,
    };
  }
  const r = body.match(RESOLVED_RE);
  if (r) return { status: "resolved", resolved_at: toIso(r[1]), note: null };
  const s = body.match(SUPERSEDED_RE);
  if (s) return { status: "superseded", resolved_at: toIso(s[1]), note: null };
  const d = body.match(DECLINED_RE);
  if (d) return { status: "declined", resolved_at: toIso(d[1]), note: null };
  return null;
}

function toIso(yyyyMmDd: string): string {
  return `${yyyyMmDd}T00:00:00.000Z`;
}

function condense(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

function extractQuestion(title: string): string {
  // The question is everything up to the first sentence-ending punctuation
  // (?, .) if present; else the whole title condensed.
  const m = title.match(/^(.*?[?.!])\s/);
  if (m) return m[1].trim();
  return condense(title, 280);
}
