import type { SqliteAdapter } from "../db/sqlite-adapter.js";

export const DISPATCH_OUTBOX_SHADOW_FLAG = "DISPATCH_OUTBOX_SHADOW_ENABLED";

export interface DispatchOperationEnvelope {
  schema_version: "dispatch.operation.v1";
  operation_type: string;
  dispatch_id: string;
  idempotency_key: string;
  team_id: string;
  actor: string;
  causation_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface DispatchOperationOutboxRow {
  operation_id: string;
  envelope: DispatchOperationEnvelope;
  attempt_count: number;
}

/** Configure shadow emission. False is the rollback path; legacy rows remain authoritative. */
export async function configureDispatchOperationOutbox(
  adapter: SqliteAdapter,
  enabled = process.env[DISPATCH_OUTBOX_SHADOW_FLAG] === "1",
): Promise<void> {
  await adapter.query(
    `UPDATE dispatch_operation_outbox_control SET shadow_enabled = ? WHERE singleton = 1`,
    [enabled ? 1 : 0],
  );
}

export interface DispatchOperationSink {
  append(envelope: DispatchOperationEnvelope): Promise<void>;
}

/**
 * Replay boundary: lease a bounded batch, append idempotently to the shadow
 * journal, then acknowledge. A crash after append is safe because the sink
 * receives the stable envelope idempotency_key again.
 */
export class DispatchOperationOutboxWorker {
  constructor(
    private adapter: SqliteAdapter,
    private sink: DispatchOperationSink,
    private workerId: string,
    private now: () => string = () => new Date().toISOString(),
    private maxAttempts = 10,
  ) {}

  async replayBatch(limit = 50): Promise<{ delivered: number; failed: number; dead_lettered: number }> {
    const now = this.now();
    const { rows } = await this.adapter.query<{
      operation_id: string; envelope_json: string; attempt_count: number;
    }>(
      `SELECT operation_id, envelope_json, attempt_count
       FROM dispatch_operation_outbox
       WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= ?
         AND (claimed_at IS NULL OR claimed_at < datetime(?, '-5 minutes'))
       ORDER BY created_at, operation_id LIMIT ?`,
      [now, now, limit],
    );
    let delivered = 0, failed = 0, dead_lettered = 0;
    for (const row of rows) {
      const claimed = await this.adapter.query(
        `UPDATE dispatch_operation_outbox SET claimed_at = ?, claimed_by = ?
         WHERE operation_id = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL
           AND (claimed_at IS NULL OR claimed_at < datetime(?, '-5 minutes'))`,
        [now, this.workerId, row.operation_id, now],
      );
      if (claimed.rowCount === 0) continue;
      try {
        await this.sink.append(JSON.parse(row.envelope_json) as DispatchOperationEnvelope);
        await this.adapter.query(
          `UPDATE dispatch_operation_outbox SET delivered_at = ?, claimed_at = NULL, claimed_by = NULL,
             attempt_count = attempt_count + 1, last_error = NULL WHERE operation_id = ?`,
          [this.now(), row.operation_id],
        );
        delivered++;
      } catch (error) {
        const attempts = row.attempt_count + 1;
        const dead = attempts >= this.maxAttempts;
        const retryAt = new Date(Date.parse(this.now()) + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))).toISOString();
        await this.adapter.query(
          `UPDATE dispatch_operation_outbox SET claimed_at = NULL, claimed_by = NULL,
             attempt_count = ?, last_error = ?, available_at = ?, dead_lettered_at = ?
           WHERE operation_id = ?`,
          [attempts, String(error).slice(0, 2000), retryAt, dead ? this.now() : null, row.operation_id],
        );
        failed++;
        if (dead) dead_lettered++;
      }
    }
    return { delivered, failed, dead_lettered };
  }
}
