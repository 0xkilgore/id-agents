import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { listDeskItems } from "../../src/desk/storage.js";
import { emitNotificationReactorEvent } from "../../src/notifications/reactor.js";

describe("notification reactor", () => {
  it("writes an operator-safe durable Desk row and notification event", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await adapter.query(
      `INSERT INTO teams (id, name, config, port_start, port_end) VALUES (?, ?, ?, ?, ?)`,
      ["team-notify", "team-notify", "{}", 4101, 4125],
    );

    const event = await emitNotificationReactorEvent(adapter, {
      team_id: "team-notify",
      reason: "action_delivery_timeout",
      classification: "retryable",
      owner_route: "substrate-orch-codex",
      source: {
        dispatch_id: "phid:disp-timeout",
        query_id: "query-timeout",
        action_id: "operator-action:retry:phid:disp-timeout:substrate-orch-codex",
      },
      occurred_at: "2026-07-09T12:00:00.000Z",
      safe_message: "Operator action timed out at /tmp/raw-stack.ts:12:4; retry is safe.",
    });

    expect(event).toMatchObject({
      topic: "notification:raised",
      reason: "action_delivery_timeout",
      classification: "retryable",
      owner_route: "substrate-orch-codex",
      source: { dispatch_id: "phid:disp-timeout", query_id: "query-timeout" },
    });
    expect(event.safe_message).not.toContain("/tmp/raw-stack.ts");

    const rows = await listDeskItems(adapter, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      desk_item_id: event.notification_id,
      tray_zone: "needs_you",
      source_ref: event.notification_id,
      body_md: event.safe_message,
      added_by: "notification-reactor",
    });

    const { rows: eventRows } = await adapter.query<{ topic: string; subject_id: string; data: string }>(
      `SELECT topic, subject_id, data FROM event_log WHERE team_id = ?`,
      ["team-notify"],
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].topic).toBe("notification:raised");
    expect(eventRows[0].subject_id).toBe(event.notification_id);
    expect(JSON.parse(eventRows[0].data)).toMatchObject({
      notification_id: event.notification_id,
      safe_message: event.safe_message,
    });
  });
});
