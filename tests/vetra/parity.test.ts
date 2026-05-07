import { describe, expect, it } from "vitest";
import { sqliteRowToParityShape } from "../../src/vetra/parity.js";

describe("sqliteRowToParityShape", () => {
  it("translates message, artifact_path, and verify_signal_json", () => {
    const shape = sqliteRowToParityShape({
      id: 42,
      dispatched_at: 1000,
      from_actor: "manager",
      to_agent: "cane",
      channel: "talk",
      message: "write the plan",
      query_id: "q-1",
      status: "done",
      responded_at: 2000,
      response: "done",
      artifact_path: "/tmp/out.md",
      verify_signal_json: JSON.stringify({ type: "desk_tag", artifact_path: "/tmp/out.md", within_hours: 24 }),
      verify_status: "pass",
      verify_last_checked: 2000,
      verify_failures_json: "[]",
      parent_dispatch_id: null,
      team_id: null,
    } as any);

    expect(shape.body_markdown).toBe("write the plan");
    expect(shape.artifacts).toEqual([{ path: "/tmp/out.md" }]);
    expect(shape.verify_signal).toEqual({ type: "desk_tag", artifact_path: "/tmp/out.md", within_hours: 24 });
  });
});
