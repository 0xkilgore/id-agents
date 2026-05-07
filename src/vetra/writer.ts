import crypto from "crypto";
import type { Db } from "../db/db-service.js";
import { VetraClient } from "./client.js";
import { retryQueue } from "./retry-queue.js";

export class VetraWriter {
  constructor(
    private readonly deps: {
      db: Db;
      client?: VetraClient;
      queue?: typeof retryQueue;
    },
  ) {}

  private get client() { return this.deps.client ?? new VetraClient(); }
  private get queue() { return this.deps.queue ?? retryQueue; }

  async createDispatch(dispatchId: number): Promise<void> {
    const row = await this.deps.db.dispatches.getById(dispatchId);
    if (!row || !row.verify_signal_json) throw new Error(`dispatch ${dispatchId} missing verify_signal_json`);
    const documentId = `d-${dispatchId}`;
    const action = {
      id: crypto.randomUUID(),
      type: "CREATE_DISPATCH" as const,
      scope: "global" as const,
      timestampUtcMs: new Date().toISOString(),
      input: {
        dispatch_id: row.id,
        query_id: row.query_id,
        from_actor: row.from_actor,
        to_agent: row.to_agent,
        channel: row.channel,
        body_markdown: row.message,
        dispatched_at: new Date(row.dispatched_at).toISOString(),
        parent_dispatch_id: row.parent_dispatch_id,
        verify_signal: JSON.parse(row.verify_signal_json),
        actor: "manager",
      },
    };
    await this.safeSend(documentId, dispatchId, action);
  }

  async startProcessing(dispatchId: number): Promise<void> {
    await this.safeSend(`d-${dispatchId}`, dispatchId, {
      id: crypto.randomUUID(),
      type: "START_PROCESSING",
      scope: "global",
      timestampUtcMs: new Date().toISOString(),
      input: { dispatch_id: dispatchId, actor: "manager" },
    });
  }

  async registerArtifact(dispatchId: number, input: { artifact_path: string; tl_dr?: string | null; urgency?: string | null; registered_by: string; ts: number }): Promise<void> {
    await this.safeSend(`d-${dispatchId}`, dispatchId, {
      id: crypto.randomUUID(),
      type: "REGISTER_ARTIFACT",
      scope: "global",
      timestampUtcMs: new Date(input.ts).toISOString(),
      input: {
        dispatch_id: dispatchId,
        artifact_path: input.artifact_path,
        tl_dr: input.tl_dr ?? null,
        urgency: input.urgency ?? null,
        registered_by: input.registered_by,
        actor: "manager",
        ts: new Date(input.ts).toISOString(),
      },
    });
  }

  async markDone(dispatchId: number, input: { outcome: "success" | "failure" | "partial"; response?: string | null; ts: number }): Promise<void> {
    await this.safeSend(`d-${dispatchId}`, dispatchId, {
      id: crypto.randomUUID(),
      type: "MARK_DONE",
      scope: "global",
      timestampUtcMs: new Date(input.ts).toISOString(),
      input: {
        dispatch_id: dispatchId,
        outcome: input.outcome,
        response: input.response ?? null,
        actor: "manager",
        ts: new Date(input.ts).toISOString(),
      },
    });
  }

  async verifySignal(dispatchId: number): Promise<void> {
    const row = await this.deps.db.dispatches.getById(dispatchId);
    if (!row || !row.verify_signal_json || !row.verify_last_checked) {
      throw new Error(`dispatch ${dispatchId} missing verify snapshot`);
    }
    if (row.verify_status !== "pass" && row.verify_status !== "fail") {
      throw new Error(`dispatch ${dispatchId} verify_status is ${row.verify_status ?? "null"}; cannot emit VERIFY_SIGNAL`);
    }
    await this.safeSend(`d-${dispatchId}`, dispatchId, {
      id: crypto.randomUUID(),
      type: "VERIFY_SIGNAL",
      scope: "global",
      timestampUtcMs: new Date(row.verify_last_checked).toISOString(),
      input: {
        dispatch_id: dispatchId,
        verify_signal_json: JSON.parse(row.verify_signal_json),
        verify_status: row.verify_status.toUpperCase(),
        verify_failures: row.verify_failures_json ? JSON.parse(row.verify_failures_json) : [],
        verify_last_checked: new Date(row.verify_last_checked).toISOString(),
        actor: "manager",
      },
    });
  }

  private async safeSend(documentId: string, dispatchId: number, action: any) {
    try {
      await this.client.createDocumentIfMissing(documentId);
      await this.client.mutateDocument(documentId, action);
    } catch (error) {
      this.queue.appendPending({
        op_id: action.id,
        dispatch_id: dispatchId,
        kind: action.type,
        document_id: documentId,
        action,
        attempt_count: 1,
        first_failed_at: new Date().toISOString(),
        last_failed_at: new Date().toISOString(),
      });
    }
  }
}
