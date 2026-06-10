#!/usr/bin/env node
// Kapelle decisions producer — operator smoke CLI.
//
// Usage:
//   tsx scripts/ingest-decisions.ts \
//     --source /Users/kilgore/Dropbox/Code/agent-platform/output/kapelle-decisions-queue.md \
//     [--db /Users/kilgore/Dropbox/Code/cane/id-agents/data/manager.sqlite]
//
// Reads the Maestra-canonical decisions markdown, runs the safe-by-
// construction parser, upserts each classified row into the manager
// decisions table, and prints an IngestResult so the operator can verify
// the inserted/updated/skipped counts before pinging /decisions/queue.

import path from "node:path";
import { SqliteAdapter } from "../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../src/db/migrations/sqlite.js";
import {
  migrateDecisionsTables,
  listDecisions,
} from "../src/decisions/storage.js";
import { ingestDecisionsFromMarkdown } from "../src/decisions/producer.js";

function parseArgs(argv: string[]): { source: string; db: string } {
  let source = "";
  let db = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    else if (argv[i] === "--db" && argv[i + 1]) db = argv[++i];
  }
  if (!source) {
    console.error("error: --source <path-to-decisions.md> is required");
    process.exit(2);
  }
  if (!db) {
    db = path.resolve(
      process.env.HOME ?? "~",
      "Dropbox/Code/cane/id-agents/data/manager.sqlite",
    );
  }
  return { source, db };
}

async function main(): Promise<void> {
  const { source, db } = parseArgs(process.argv.slice(2));
  const adapter = new SqliteAdapter(db);
  await migrateSqlite(adapter);
  await migrateDecisionsTables(adapter);

  console.log(`[ingest-decisions] db=${db}`);
  console.log(`[ingest-decisions] source=${source}`);

  const result = await ingestDecisionsFromMarkdown(adapter, { source_path: source });
  console.log("\n[ingest-decisions] result:");
  console.log(JSON.stringify(result, null, 2));

  const open = await listDecisions(adapter, { status: "open" });
  console.log(`\n[ingest-decisions] decisions table now contains ${open.length} open row(s):`);
  for (const row of open) {
    console.log(`  ${row.display_id ?? row.decision_id}: ${row.title}`);
  }
  if (open.length === 0) {
    console.log("  (queue is fully reconciled — matches Maestra's current state)");
  }

  if (result.skipped.length > 0) {
    console.log(`\n[ingest-decisions] skipped ${result.skipped.length} row(s) with no explicit status marker:`);
    for (const s of result.skipped) {
      console.log(`  ${s.display_id}: ${s.title.slice(0, 80)}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[ingest-decisions] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
