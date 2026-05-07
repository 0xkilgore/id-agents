import { describe, expect, it, vi } from "vitest";
import { VetraWriter } from "../../src/vetra/writer.js";

describe("VetraWriter", () => {
  it("reads the persisted row before CREATE_DISPATCH", async () => {
    const db = {
      dispatches: {
        getById: vi.fn().mockResolvedValue({
          id: 42,
          dispatched_at: 1000,
          from_actor: "manager",
          to_agent: "cane",
          channel: "talk",
          message: "write the plan",
          query_id: "q-1",
          status: "queued",
          responded_at: null,
          response: null,
          artifact_path: null,
          verify_signal_json: JSON.stringify({
            type: "desk_tag",
            artifact_path: "/tmp/out.md",
            within_hours: 24,
          }),
          verify_status: null,
          verify_last_checked: null,
          verify_failures_json: null,
          parent_dispatch_id: null,
        }),
      },
    } as any;
    const client = { createDocumentIfMissing: vi.fn(), mutateDocument: vi.fn().mockResolvedValue(undefined) };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };
    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    await writer.createDispatch(42);

    expect(db.dispatches.getById).toHaveBeenCalledWith(42);
    expect(client.mutateDocument).toHaveBeenCalledWith(
      "d-42",
      expect.objectContaining({
        type: "CREATE_DISPATCH",
        input: expect.objectContaining({
          verify_signal: {
            type: "desk_tag",
            artifact_path: "/tmp/out.md",
            within_hours: 24,
          },
        }),
      }),
    );
  });

  it("verifySignal rejects pending verify_status (does not leak PENDING to Vetra)", async () => {
    const db = {
      dispatches: {
        getById: vi.fn().mockResolvedValue({
          id: 7,
          dispatched_at: 1000,
          from_actor: "manager",
          to_agent: "cane",
          channel: "talk",
          message: "wait for verification",
          query_id: null,
          status: "done",
          responded_at: 2000,
          response: null,
          artifact_path: null,
          verify_signal_json: JSON.stringify({ type: "desk_tag", artifact_path: "/tmp/x.md", within_hours: 24 }),
          verify_status: "pending",
          verify_last_checked: 2000,
          verify_failures_json: null,
          parent_dispatch_id: null,
        }),
      },
    } as any;
    const client = { createDocumentIfMissing: vi.fn(), mutateDocument: vi.fn() };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };
    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    await expect(writer.verifySignal(7)).rejects.toThrow(/pending/i);
    expect(client.mutateDocument).not.toHaveBeenCalled();
  });

  it("verifySignal sends PASS when row.verify_status is 'pass'", async () => {
    const db = {
      dispatches: {
        getById: vi.fn().mockResolvedValue({
          id: 8,
          dispatched_at: 1000,
          from_actor: "manager",
          to_agent: "cane",
          channel: "talk",
          message: "ok",
          query_id: null,
          status: "done",
          responded_at: 2000,
          response: null,
          artifact_path: "/tmp/ok.md",
          verify_signal_json: JSON.stringify({ type: "desk_tag", artifact_path: "/tmp/ok.md", within_hours: 24 }),
          verify_status: "pass",
          verify_last_checked: 2000,
          verify_failures_json: "[]",
          parent_dispatch_id: null,
        }),
      },
    } as any;
    const client = { createDocumentIfMissing: vi.fn(), mutateDocument: vi.fn().mockResolvedValue(undefined) };
    const queue = { appendPending: vi.fn(), appendDeadLetter: vi.fn() };
    const writer = new VetraWriter({ db, client: client as any, queue: queue as any });

    await writer.verifySignal(8);

    expect(client.mutateDocument).toHaveBeenCalledWith(
      "d-8",
      expect.objectContaining({
        type: "VERIFY_SIGNAL",
        input: expect.objectContaining({ verify_status: "PASS" }),
      }),
    );
  });
});
