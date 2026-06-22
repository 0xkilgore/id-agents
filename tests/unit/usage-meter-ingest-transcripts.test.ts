// Usage Meter transcript ingest — unit tests.
//
// Proves the capture path: parse Claude Code transcript JSONL -> attribute to
// an agent (by transcript path) -> upsert idempotent agent_usage_event rows
// with REAL token counts. This is what makes /usage/daily-report non-zero.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  ingestTranscripts,
  toUsageEvent,
  listTranscriptFiles,
} from "../../src/usage-meter/ingest-transcripts.js";
import type { ParsedTranscriptEvent } from "../../src/usage-meter/transcripts.js";
import type { AttributionResult } from "../../src/usage-meter/attribution.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshAdapter(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(":memory:");
  await adapter.query(
    `CREATE TABLE agent_usage_event (
       event_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'anthropic', agent_id TEXT NOT NULL,
       dispatch_id TEXT, query_id TEXT, session_id TEXT, model TEXT, ts INTEGER NOT NULL,
       input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
       cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
       raw_tokens INTEGER NOT NULL, weighted_tokens INTEGER NOT NULL, source TEXT NOT NULL,
       confidence TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE)`,
    [],
  );
  await adapter.query(`CREATE TABLE agents (name TEXT, working_directory TEXT)`, []);
  await adapter.query(
    `CREATE TABLE dispatch_scheduler_queue (dispatch_phid TEXT, query_id TEXT, agent_query_id TEXT, to_agent TEXT)`,
    [],
  );
  return adapter;
}

function writeTranscripts(agentEncodedDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "usage-ingest-"));
  cleanups.push(root);
  const projectDir = join(root, agentEncodedDir);
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "assistant", timestamp: "2026-06-22T16:00:00Z", session_id: "sess-1", uuid: "u1",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 } },
    }),
    JSON.stringify({
      type: "assistant", timestamp: "2026-06-22T16:01:00Z", session_id: "sess-1", uuid: "u2",
      message: { model: "claude-sonnet-4-6", usage: { input_tokens: 500, output_tokens: 100 } },
    }),
    JSON.stringify({ type: "user", message: { content: "hi" } }), // ignored (no usage)
  ];
  writeFileSync(join(projectDir, "session.jsonl"), lines.join("\n"));
  return root;
}

describe("toUsageEvent", () => {
  it("maps a parsed transcript event + attribution to a storable usage event", () => {
    const parsed: ParsedTranscriptEvent = {
      idempotency_key: "k1", model: "claude-sonnet-4-6", session_id: "s", message_uuid: "u",
      ts: 1750000000000, input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2,
      cache_read_input_tokens: 100, raw_tokens: 117, weighted_tokens: 27,
      source_path: "/x/session.jsonl", source_line: 0,
    };
    const attr: AttributionResult = { agent_id: "roger", dispatch_id: "phid:disp-1", query_id: "q1", confidence: "canonical" };
    const ev = toUsageEvent(parsed, attr, "anthropic");
    expect(ev).toMatchObject({
      event_id: "k1", idempotency_key: "k1", provider: "anthropic", agent_id: "roger",
      dispatch_id: "phid:disp-1", source: "claude_code_transcripts", confidence: "canonical",
      input_tokens: 10, output_tokens: 5, raw_tokens: 117, weighted_tokens: 27, model: "claude-sonnet-4-6",
    });
  });
});

describe("ingestTranscripts", () => {
  it("captures real token counts, attributes by agent, and is idempotent", async () => {
    const adapter = await freshAdapter();
    // agent 'roger' working dir /Users/test/roger -> transcripts under encoded dir name.
    await adapter.query(`INSERT INTO agents (name, working_directory) VALUES (?, ?)`, ["roger", "/Users/test/roger"]);
    const root = writeTranscripts("-Users-test-roger");

    const r1 = await ingestTranscripts(adapter, { transcriptsDir: root, lookbackDays: 99999 });
    expect(r1.files_scanned).toBe(1);
    expect(r1.events_parsed).toBe(2); // user line ignored
    expect(r1.inserted).toBe(2);
    expect(r1.by_agent.roger).toBe(1280 + 600); // weighted: ceil(1000+200+50+300*0.1)=1280, 500+100=600

    const { rows } = await adapter.query<{ c: number; w: number; agent_id: string; source: string }>(
      `SELECT COUNT(*) AS c, SUM(weighted_tokens) AS w, agent_id, source FROM agent_usage_event GROUP BY agent_id, source`,
      [],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].c)).toBe(2);
    expect(Number(rows[0].w)).toBe(1880);
    expect(rows[0].agent_id).toBe("roger");
    expect(rows[0].source).toBe("claude_code_transcripts");

    // Idempotent replay: no new rows.
    const r2 = await ingestTranscripts(adapter, { transcriptsDir: root, lookbackDays: 99999 });
    expect(r2.inserted).toBe(0);
    expect(r2.skipped_idempotent).toBe(2);
  });

  it("falls back to _unknown when no agent matches the transcript path", async () => {
    const adapter = await freshAdapter(); // no agents rows
    const root = writeTranscripts("-Users-test-unmatched");
    const r = await ingestTranscripts(adapter, { transcriptsDir: root, lookbackDays: 99999 });
    expect(r.inserted).toBe(2);
    expect(r.by_agent._unknown).toBe(1880);
  });

  it("respects lookbackDays (old files skipped)", async () => {
    const adapter = await freshAdapter();
    const root = writeTranscripts("-Users-test-roger");
    // now far in the future so the just-written file is 'older' than lookback.
    const r = await ingestTranscripts(adapter, { transcriptsDir: root, lookbackDays: 1, now: () => Date.now() + 10 * 86_400_000 });
    expect(r.files_scanned).toBe(0);
    expect(r.inserted).toBe(0);
  });

  it("listTranscriptFiles returns nothing for a missing dir", () => {
    expect(listTranscriptFiles("/no/such/dir/xyz", 0)).toEqual([]);
  });
});
