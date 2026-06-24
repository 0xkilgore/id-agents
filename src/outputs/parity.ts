// ARTIFACTS substrate proof-cut — Step 3: parity gate.
//
// checkArtifactParity() compares the substrate projection against a
// delivery-log.md walk on the do-not-break metrics (read-model contract §5):
// every delivery-log row must be faithfully present in the substrate (matched
// by abs_path), titles (tl_dr) must match, and the newest-N produced_at ordering
// of the shared rows must agree. Substrate MAY be a superset (filesystem /
// agent-done rows the walk never saw) — that is not drift.
//
// The flag flip is BLOCKED unless status === "ok": the console must not cut over
// to a substrate read that would render a different feed than the walk.

import type { DbAdapter } from "../db/db-adapter.js";
import { splitPipeLine } from "./storage.js";
import { listArtifactCatalog } from "./storage.js";
import { artifactRowToEntry } from "./entry-projection.js";

const DEFAULT_NEWEST_N = 20;

/** A delivery-log.md row, parsed positionally (mirrors backfill column order). */
export interface DeliveryLogRow {
  produced_at: string;
  agent: string;
  tag: string | null;
  basename: string;
  abs_path: string;
  title: string | null;
}

/** Comparable shape both sides are normalized to (keyed by abs_path). */
interface ComparableRow {
  abs_path: string;
  agent: string | null;
  tag: string | null;
  title: string | null;
  produced_at: string;
}

export interface ParityMetric {
  name: string;
  substrate: number | string;
  delivery_log: number | string;
  ok: boolean;
}

export interface ParityReport {
  status: "ok" | "drift";
  generated_at: string;
  substrate_count: number;
  delivery_log_count: number;
  metrics: ParityMetric[];
  drift: string[];
}

/**
 * Pure parse of delivery-log.md text into rows. Mirrors
 * backfillCatalogFromDeliveryLog's positional columns:
 *   <ISO-ts> | <agent> | <tag> | <basename> | <abs_path> | "<tl_dr>"
 * Skips blank/comment lines and rows with < 5 fields or missing required cols.
 */
export function parseDeliveryLogRows(text: string): DeliveryLogRow[] {
  const rows: DeliveryLogRow[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitPipeLine(line);
    if (parts.length < 5) continue;
    const [ts, agent, tag, basename, absPath, ...rest] = parts;
    if (!ts || !agent || !basename || !absPath) continue;
    let title: string | null = rest.join("|").trim() || null;
    if (title?.startsWith('"') && title.endsWith('"')) title = title.slice(1, -1);
    rows.push({
      produced_at: ts,
      agent,
      tag: tag === "-" ? null : tag,
      basename,
      abs_path: absPath,
      title,
    });
  }
  return rows;
}

function countBy<T>(rows: T[], key: (r: T) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "(none)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function newestPaths(rows: ComparableRow[], n: number): string[] {
  return [...rows]
    .sort((a, b) => (a.produced_at < b.produced_at ? 1 : a.produced_at > b.produced_at ? -1 : 0))
    .slice(0, n)
    .map((r) => r.abs_path);
}

/**
 * Pure parity computation. `substrate` and `deliveryLog` are normalized rows.
 * Drift is asymmetric: every delivery-log row must be present + faithful in
 * substrate; substrate-only rows are allowed (richer source).
 */
export function computeArtifactParity(
  substrate: ComparableRow[],
  deliveryLog: ComparableRow[],
  now: string,
  newestN: number = DEFAULT_NEWEST_N,
): ParityReport {
  const drift: string[] = [];
  const subByPath = new Map(substrate.map((r) => [r.abs_path, r]));

  // (1) presence + (2) title fidelity — every delivery row present & faithful.
  let missing = 0;
  let titleMismatch = 0;
  for (const d of deliveryLog) {
    const s = subByPath.get(d.abs_path);
    if (!s) {
      missing += 1;
      if (drift.length < 30) drift.push(`missing in substrate: ${d.abs_path}`);
      continue;
    }
    if ((s.title ?? "") !== (d.title ?? "")) {
      titleMismatch += 1;
      if (drift.length < 30) {
        drift.push(`title drift for ${d.abs_path}: substrate="${s.title ?? ""}" vs log="${d.title ?? ""}"`);
      }
    }
  }

  // (3) newest-N ordering over rows shared by both sides.
  const sharedSub = substrate.filter((r) => deliveryLog.some((d) => d.abs_path === r.abs_path));
  const sharedLog = deliveryLog.filter((d) => subByPath.has(d.abs_path));
  const subOrder = newestPaths(sharedSub, newestN);
  const logOrder = newestPaths(sharedLog, newestN);
  const orderingOk = subOrder.length === logOrder.length && subOrder.every((p, i) => p === logOrder[i]);
  if (!orderingOk) drift.push(`newest-${newestN} ordering differs for shared rows`);

  // (4)/(5) count-by-agent / count-by-tag — reported; gate is presence-driven.
  const subAgents = countBy(substrate, (r) => r.agent);
  const logAgents = countBy(deliveryLog, (r) => r.agent);
  const subTags = countBy(substrate, (r) => r.tag);
  const logTags = countBy(deliveryLog, (r) => r.tag);

  const metrics: ParityMetric[] = [
    { name: "delivery_rows_present", substrate: deliveryLog.length - missing, delivery_log: deliveryLog.length, ok: missing === 0 },
    { name: "title_fidelity", substrate: deliveryLog.length - titleMismatch, delivery_log: deliveryLog.length, ok: titleMismatch === 0 },
    { name: `newest_${newestN}_ordering`, substrate: subOrder.length, delivery_log: logOrder.length, ok: orderingOk },
    { name: "distinct_agents", substrate: subAgents.size, delivery_log: logAgents.size, ok: true },
    { name: "distinct_tags", substrate: subTags.size, delivery_log: logTags.size, ok: true },
  ];

  return {
    status: drift.length === 0 ? "ok" : "drift",
    generated_at: now,
    substrate_count: substrate.length,
    delivery_log_count: deliveryLog.length,
    metrics,
    drift,
  };
}

function deliveryToComparable(r: DeliveryLogRow): ComparableRow {
  return { abs_path: r.abs_path, agent: r.agent, tag: r.tag, title: r.title, produced_at: r.produced_at };
}

/**
 * Query the substrate, parse the delivery-log text, and compute parity.
 * Substrate rows are projected through artifactRowToEntry (with no review/ops)
 * so the comparison is over the SAME projection the read route serves.
 */
export async function checkArtifactParity(
  adapter: DbAdapter,
  deliveryLogText: string,
  now: string = new Date().toISOString(),
  newestN: number = DEFAULT_NEWEST_N,
): Promise<ParityReport> {
  const catalog = await listArtifactCatalog(adapter, { limit: 10_000 });
  const substrate: ComparableRow[] = catalog.map((row) => {
    const entry = artifactRowToEntry(row, null, []);
    return {
      abs_path: entry.path ?? "",
      agent: entry.produced_by_agent,
      tag: row.tag, // raw tag for count fidelity (entry.artifact_kind applies a default)
      title: row.title, // raw tl_dr for fidelity (entry.title applies a basename fallback)
      produced_at: entry.created_at,
    };
  });
  const deliveryLog = parseDeliveryLogRows(deliveryLogText).map(deliveryToComparable);
  return computeArtifactParity(substrate, deliveryLog, now, newestN);
}
