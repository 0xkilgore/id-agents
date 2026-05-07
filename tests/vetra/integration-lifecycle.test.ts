/**
 * Task 7: Integration Verification Gate (id-agents side)
 *
 * End-to-end integration test that exercises the VetraWriter through
 * all 5 dispatch lifecycle ops against a mock DB + mock VetraClient,
 * then verifies parity between the SQLite row state and what the writer emitted.
 */
import { describe, expect, it, vi } from "vitest";
import { VetraWriter } from "../../src/vetra/writer.js";
import { sqliteRowToParityShape, diffParity } from "../../src/vetra/parity.js";

describe("Integration: VetraWriter lifecycle + parity check", () => {
  const dispatchedAt = new Date("2026-05-05T10:00:00.000Z").getTime();
  const respondedAt = new Date("2026-05-05T10:15:30.000Z").getTime();
  const verifyCheckedAt = new Date("2026-05-05T10:15:45.000Z").getTime();
  const verifySignal = {
    type: "desk_tag",
    artifact_path: "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md",
    within_hours: 24,
  };

  function makeSqliteRow(overrides: Record<string, any> = {}) {
    return {
      id: 101,
      team_id: null,
      dispatched_at: dispatchedAt,
      from_actor: "manager",
      to_agent: "roger",
      channel: "talk",
      message: "Implement integration verification gate for Vetra dispatch beachhead",
      query_id: "q-task7-e2e",
      status: "queued",
      responded_at: null,
      response: null,
      artifact_path: null,
      verify_signal_json: JSON.stringify(verifySignal),
      verify_status: null,
      verify_last_checked: null,
      verify_failures_json: null,
      parent_dispatch_id: null,
      ...overrides,
    };
  }

  it("writer emits all 5 ops in correct sequence with correct action types", async () => {
    const actions: Array<{ documentId: string; action: any }> = [];
    const client = {
      createDocumentIfMissing: vi.fn(),
      mutateDocument: vi.fn(async (docId: string, action: any) => {
        actions.push({ documentId: docId, action });
      }),
    };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };

    // Simulate row state at each lifecycle stage
    const rowQueued = makeSqliteRow();
    const rowInFlight = makeSqliteRow({ status: "in_flight" });
    const rowDone = makeSqliteRow({
      status: "done",
      responded_at: respondedAt,
      response: "done",
      artifact_path: "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md",
      verify_signal_json: JSON.stringify(verifySignal),
      verify_status: "pass",
      verify_last_checked: verifyCheckedAt,
      verify_failures_json: "[]",
    });

    const db = {
      dispatches: {
        getById: vi.fn()
          .mockResolvedValueOnce(rowQueued)   // createDispatch reads row
          .mockResolvedValueOnce(rowDone),    // verifySignal reads row
      },
    } as any;

    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    // Step 1: CREATE_DISPATCH
    await writer.createDispatch(101);
    expect(actions[0].action.type).toBe("CREATE_DISPATCH");
    expect(actions[0].documentId).toBe("d-101");
    expect(actions[0].action.input.verify_signal).toEqual(verifySignal);

    // Step 2: START_PROCESSING
    await writer.startProcessing(101);
    expect(actions[1].action.type).toBe("START_PROCESSING");
    expect(actions[1].action.input.dispatch_id).toBe(101);

    // Step 3: REGISTER_ARTIFACT
    await writer.registerArtifact(101, {
      artifact_path: "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md",
      tl_dr: "Vetra integration test passing",
      registered_by: "roger",
      ts: respondedAt,
    });
    expect(actions[2].action.type).toBe("REGISTER_ARTIFACT");
    expect(actions[2].action.input.artifact_path).toBe(
      "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md",
    );

    // Step 4: MARK_DONE
    await writer.markDone(101, {
      outcome: "success",
      response: "Integration test written and passing",
      ts: respondedAt,
    });
    expect(actions[3].action.type).toBe("MARK_DONE");
    expect(actions[3].action.input.outcome).toBe("success");

    // Step 5: VERIFY_SIGNAL
    await writer.verifySignal(101);
    expect(actions[4].action.type).toBe("VERIFY_SIGNAL");
    expect(actions[4].action.input.verify_status).toBe("PASS");
    expect(actions[4].action.input.verify_failures).toEqual([]);

    // All 5 ops emitted to the same document
    expect(actions).toHaveLength(5);
    expect(actions.every((a) => a.documentId === "d-101")).toBe(true);

    // Verify op type sequence
    const opTypes = actions.map((a) => a.action.type);
    expect(opTypes).toEqual([
      "CREATE_DISPATCH",
      "START_PROCESSING",
      "REGISTER_ARTIFACT",
      "MARK_DONE",
      "VERIFY_SIGNAL",
    ]);
  });

  it("parity check passes when SQLite row matches final Vetra state", () => {
    const finalRow = makeSqliteRow({
      status: "done",
      responded_at: respondedAt,
      response: "done",
      artifact_path: "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md",
      verify_status: "pass",
      verify_last_checked: verifyCheckedAt,
      verify_failures_json: "[]",
    });

    const sqliteShape = sqliteRowToParityShape(finalRow);

    // Simulate what the Vetra document state would look like after all ops
    const vetraShape = {
      dispatch_id: 101,
      query_id: "q-task7-e2e",
      from_actor: "manager",
      to_agent: "roger",
      channel: "talk",
      status: "DONE",
      dispatched_at: new Date(dispatchedAt).toISOString(),
      responded_at: new Date(respondedAt).toISOString(),
      verify_status: "PASS",
      verify_last_checked: new Date(verifyCheckedAt).toISOString(),
      parent_dispatch_id: null,
      body_markdown: "Implement integration verification gate for Vetra dispatch beachhead",
      artifacts: [{ path: "/Users/kilgore/Dropbox/Obsidian/reports/task7-output.md" }],
      verify_signal: verifySignal,
      verify_failures: [],
    };

    const drifts = diffParity(sqliteShape, vetraShape);
    expect(drifts).toEqual([]);
  });

  it("parity check detects drift when status diverges", () => {
    // SQLite says in_flight but Vetra advanced to DONE
    const staleRow = makeSqliteRow({ status: "in_flight" });
    const sqliteShape = sqliteRowToParityShape(staleRow);
    const vetraShape = { ...sqliteShape, status: "DONE" };

    const drifts = diffParity(sqliteShape, vetraShape);
    expect(drifts.length).toBe(1);
    expect(drifts[0].field).toBe("status");
    expect(drifts[0].sqlite).toBe("IN_FLIGHT");
    expect(drifts[0].vetra).toBe("DONE");
  });

  it("writer enqueues to retry when VetraClient throws", async () => {
    const row = makeSqliteRow();
    const db = { dispatches: { getById: vi.fn().mockResolvedValue(row) } } as any;
    const client = {
      createDocumentIfMissing: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      mutateDocument: vi.fn(),
    };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };
    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    // Should not throw - enqueues instead
    await writer.createDispatch(101);

    expect(queue.appendPending).toHaveBeenCalledTimes(1);
    const entry = queue.appendPending.mock.calls[0][0];
    expect(entry.kind).toBe("CREATE_DISPATCH");
    expect(entry.dispatch_id).toBe(101);
    expect(entry.document_id).toBe("d-101");
    expect(entry.attempt_count).toBe(1);
  });

  it("writer rejects verifySignal when verify_status is pending", async () => {
    const pendingRow = makeSqliteRow({
      status: "done",
      responded_at: respondedAt,
      verify_status: "pending",
      verify_last_checked: verifyCheckedAt,
    });
    const db = { dispatches: { getById: vi.fn().mockResolvedValue(pendingRow) } } as any;
    const client = { createDocumentIfMissing: vi.fn(), mutateDocument: vi.fn() };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };
    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    await expect(writer.verifySignal(101)).rejects.toThrow(/pending/i);
    expect(client.mutateDocument).not.toHaveBeenCalled();
  });
});
