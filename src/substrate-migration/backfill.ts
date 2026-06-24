// DV7 — generic idempotent backfill harness.
//
// Generalized from src/outputs/storage.ts `backfillCatalogFromDeliveryLog`: walk
// a legacy source, parse each row, and upsert it into the substrate. Idempotency
// is delegated to the caller's `upsert` (which returns whether the row was
// newly inserted), exactly as `registerArtifact` does — so a re-run converges
// instead of duplicating. The harness only owns the tally and the parse/skip
// bookkeeping, which is the part every domain re-implemented identically.

import type { BackfillSummary } from "./types.js";

export interface BackfillOptions<TRow, TParsed> {
  /** The legacy rows to backfill (already-split lines, DB rows, etc.). */
  rows: Iterable<TRow> | AsyncIterable<TRow>;
  /** Parse/validate a row. Return `null` to skip it (comment, malformed, …);
   *  the skip is counted but not fatal. Defaults to identity. */
  parse?: (row: TRow) => TParsed | null;
  /** Idempotent upsert into the substrate. `inserted: true` ⇒ new row,
   *  `false` ⇒ existing row updated. Must itself be idempotent on re-run. */
  upsert: (parsed: TParsed) => Promise<{ inserted: boolean }> | { inserted: boolean };
}

function isAsyncIterable<T>(value: Iterable<T> | AsyncIterable<T>): value is AsyncIterable<T> {
  return typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}

/**
 * Run an idempotent backfill, returning the same `BackfillSummary` shape the
 * artifacts backfill returns. Pure control-flow around the caller's I/O —
 * unit-tested with an in-memory upsert.
 */
export async function runBackfill<TRow, TParsed = TRow>(
  opts: BackfillOptions<TRow, TParsed>,
): Promise<BackfillSummary> {
  const parse = opts.parse ?? ((row: TRow) => row as unknown as TParsed);
  const out: BackfillSummary = { rows_seen: 0, rows_parsed: 0, inserted: 0, updated: 0, skipped: 0 };

  const handle = async (row: TRow): Promise<void> => {
    out.rows_seen += 1;
    const parsed = parse(row);
    if (parsed === null || parsed === undefined) {
      out.skipped += 1;
      return;
    }
    out.rows_parsed += 1;
    const { inserted } = await opts.upsert(parsed);
    if (inserted) out.inserted += 1;
    else out.updated += 1;
  };

  if (isAsyncIterable(opts.rows)) {
    for await (const row of opts.rows) await handle(row);
  } else {
    for (const row of opts.rows) await handle(row);
  }
  return out;
}
