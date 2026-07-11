import { describe, expect, it } from "vitest";
import React from "react";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  readDispatchAttemptLedger,
  recordDispatchAttempt,
} from "../../src/dispatch-attempt-ledger/storage.js";
import { DispatchAttemptLedgerPanel } from "../../src/tui/components/DispatchAttemptLedgerPanel.js";
import type { DispatchAttemptLedgerRow } from "../../src/tui/api/types.js";

const TEAM = "team-ledger";
const NOW = "2026-07-07T15:00:00.000Z";

describe("dispatch attempt ledger", () => {
  it("collapses forced /talk-to failure and /news-to fallback into one row", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await recordDispatchAttempt(adapter, {
        team_id: TEAM,
        route: "/talk-to",
        to_agent: "substrate-api-codex",
        from_actor: "continuous-orchestration",
        original_query_id: "query_1783439711510_sacmggk",
        original_dispatch_id: "phid:disp-cleveland",
        subject: "urgent Cleveland Park task",
        status_code: 502,
        ok: false,
        error: "Bad Gateway",
        response_json: { error: "Bad Gateway" },
        created_at: NOW,
      });
      await recordDispatchAttempt(adapter, {
        team_id: TEAM,
        route: "/news-to",
        to_agent: "substrate-api-codex",
        from_actor: "continuous-orchestration",
        original_query_id: "query_1783439711510_sacmggk",
        original_dispatch_id: "phid:disp-cleveland",
        subject: "urgent Cleveland Park task",
        status_code: 202,
        ok: true,
        error: null,
        response_json: { success: true, triggered: true },
        created_at: "2026-07-07T15:00:01.000Z",
      });

      const rows = await readDispatchAttemptLedger(adapter, TEAM, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        original_query_id: "query_1783439711510_sacmggk",
        original_dispatch_id: "phid:disp-cleveland",
        talk_to_attempted: true,
        talk_to_ok: false,
        talk_to_status_code: 502,
        news_to_attempted: true,
        news_to_ok: true,
        news_to_status_code: 202,
        fallback_used: true,
        fallback_ok: true,
      });
      expect(rows[0].attempts_json).toHaveLength(2);
    } finally {
      await adapter.close();
    }
  });

  it("renders the console panel with the fallback outcome", () => {
    const row = {
      id: "attempt_1",
      team_id: TEAM,
      correlation_key: "query:query_1",
      to_agent: "finances",
      from_actor: "continuous-orchestration",
      original_query_id: "query_1",
      original_dispatch_id: null,
      subject: "finances task",
      talk_to_attempted: true,
      talk_to_ok: false,
      talk_to_status_code: 502,
      talk_to_error: "Bad Gateway",
      talk_to_at: NOW,
      news_to_attempted: true,
      news_to_ok: true,
      news_to_status_code: 202,
      news_to_error: null,
      news_to_at: "2026-07-07T15:00:01.000Z",
      fallback_used: true,
      fallback_ok: true,
      attempts_json: [],
      created_at: NOW,
      updated_at: "2026-07-07T15:00:01.000Z",
    } satisfies DispatchAttemptLedgerRow;

    const rendered = DispatchAttemptLedgerPanel({ rows: [row], loading: false, error: null });
    expect(flattenText(rendered)).toContain("/talk-to 502");
    expect(flattenText(rendered)).toContain("fallback ok");
    expect(flattenText(rendered)).toContain("finances");
  });
});

function flattenText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: unknown; row?: unknown };
    if (typeof node.type === "function" && props.row) {
      return flattenText(node.type(props));
    }
    return flattenText(props.children);
  }
  return "";
}
