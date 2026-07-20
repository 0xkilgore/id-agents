import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type WorkLeaseState = "acquired" | "renewed" | "released" | "expired";
export type WorkLeaseAuthority = "off" | "shadow" | "canary";

export interface WorkLease {
  lease_id: string;
  resource: string;
  dispatch_id: string;
  owner_id: string;
  fencing_token: number;
  state: WorkLeaseState;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
  released_at_ms: number | null;
}

export interface WorkLeaseCanaryPolicy {
  authority: WorkLeaseAuthority;
  lane: string | null;
}

export class WorkLeaseConflict extends Error {
  constructor(public readonly code: "lease_held" | "stale_fence" | "lease_inactive", message: string) {
    super(message);
  }
}

export function workLeaseCanaryPolicy(env: NodeJS.ProcessEnv = process.env): WorkLeaseCanaryPolicy {
  const raw = (env.IDAGENTS_WORKLEASE_AUTHORITY ?? "off").trim().toLowerCase();
  const authority: WorkLeaseAuthority = raw === "shadow" || raw === "canary" ? raw : "off";
  const lane = env.IDAGENTS_WORKLEASE_CANARY_LANE?.trim() || null;
  return { authority, lane };
}

/** Only the named lane may transfer authority. Shadow observes every lane. */
export function shouldEnforceWorkLease(policy: WorkLeaseCanaryPolicy, lane: string): boolean {
  return policy.authority === "canary" && policy.lane !== null && policy.lane === lane;
}

export class WorkLeaseStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_leases (
        lease_id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        state TEXT NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        renewed_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        released_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS work_leases_resource_idx
        ON work_leases(resource, fencing_token DESC);
      CREATE TABLE IF NOT EXISTS work_lease_fences (
        resource TEXT PRIMARY KEY,
        next_token INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_lease_operations (
        operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        lease_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        operation TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        occurred_at_ms INTEGER NOT NULL
      );
    `);
  }

  acquire(input: { resource: string; dispatch_id: string; owner_id: string; ttl_ms: number; now_ms?: number }): WorkLease {
    const now = input.now_ms ?? Date.now();
    this.validateTtl(input.ttl_ms);
    return this.db.transaction(() => {
      this.expireResource(input.resource, now);
      const live = this.current(input.resource);
      if (live && live.expires_at_ms > now) {
        if (live.dispatch_id === input.dispatch_id && live.owner_id === input.owner_id) return live;
        throw new WorkLeaseConflict("lease_held", `resource ${input.resource} is held by ${live.owner_id}`);
      }
      this.db.prepare(`INSERT INTO work_lease_fences(resource, next_token) VALUES (?, 2)
        ON CONFLICT(resource) DO UPDATE SET next_token = next_token + 1`).run(input.resource);
      const fence = this.db.prepare("SELECT next_token - 1 AS token FROM work_lease_fences WHERE resource = ?")
        .get(input.resource) as { token: number };
      const lease: WorkLease = {
        lease_id: `wkl_${randomUUID()}`,
        resource: input.resource,
        dispatch_id: input.dispatch_id,
        owner_id: input.owner_id,
        fencing_token: fence.token,
        state: "acquired",
        acquired_at_ms: now,
        renewed_at_ms: now,
        expires_at_ms: now + input.ttl_ms,
        released_at_ms: null,
      };
      this.insertLease(lease);
      this.record(lease, "acquired", now);
      return lease;
    })();
  }

  renew(leaseId: string, fencingToken: number, ttlMs: number, now = Date.now()): WorkLease {
    this.validateTtl(ttlMs);
    return this.db.transaction(() => {
      const lease = this.requireFence(leaseId, fencingToken, now);
      this.db.prepare("UPDATE work_leases SET state='renewed', renewed_at_ms=?, expires_at_ms=? WHERE lease_id=?")
        .run(now, now + ttlMs, leaseId);
      const renewed = this.byId(leaseId)!;
      this.record(renewed, "renewed", now);
      return renewed;
    })();
  }

  release(leaseId: string, fencingToken: number, now = Date.now()): WorkLease {
    return this.db.transaction(() => {
      const lease = this.requireFence(leaseId, fencingToken, now);
      this.db.prepare("UPDATE work_leases SET state='released', released_at_ms=? WHERE lease_id=?").run(now, leaseId);
      const released = this.byId(leaseId)!;
      this.record(released, "released", now);
      return released;
    })();
  }

  /** Required immediately before any authoritative completion/write. */
  assertFence(resource: string, leaseId: string, fencingToken: number, now = Date.now()): WorkLease {
    this.expireResource(resource, now);
    const lease = this.byId(leaseId);
    const current = this.current(resource);
    if (!lease || lease.fencing_token !== fencingToken || current?.lease_id !== leaseId) {
      throw new WorkLeaseConflict("stale_fence", `fencing token ${fencingToken} is stale for ${resource}`);
    }
    if ((lease.state !== "acquired" && lease.state !== "renewed") || lease.expires_at_ms <= now) {
      throw new WorkLeaseConflict("lease_inactive", `lease ${leaseId} is not active`);
    }
    return lease;
  }

  /** Restart recovery: durably expire elapsed leases and return live ownership. */
  recover(now = Date.now()): WorkLease[] {
    this.db.transaction(() => {
      const resources = this.db.prepare("SELECT DISTINCT resource FROM work_leases").all() as Array<{ resource: string }>;
      for (const { resource } of resources) this.expireResource(resource, now);
    })();
    return this.db.prepare("SELECT * FROM work_leases WHERE state IN ('acquired','renewed') AND expires_at_ms > ?")
      .all(now) as WorkLease[];
  }

  byId(leaseId: string): WorkLease | null {
    return (this.db.prepare("SELECT * FROM work_leases WHERE lease_id=?").get(leaseId) as WorkLease | undefined) ?? null;
  }

  current(resource: string): WorkLease | null {
    return (this.db.prepare("SELECT * FROM work_leases WHERE resource=? AND state IN ('acquired','renewed') ORDER BY fencing_token DESC LIMIT 1")
      .get(resource) as WorkLease | undefined) ?? null;
  }

  private expireResource(resource: string, now: number): void {
    const elapsed = this.db.prepare("SELECT * FROM work_leases WHERE resource=? AND state IN ('acquired','renewed') AND expires_at_ms <= ?")
      .all(resource, now) as WorkLease[];
    const update = this.db.prepare("UPDATE work_leases SET state='expired' WHERE lease_id=?");
    for (const lease of elapsed) {
      update.run(lease.lease_id);
      this.record({ ...lease, state: "expired" }, "expired", now);
    }
  }

  private requireFence(leaseId: string, token: number, now: number): WorkLease {
    const lease = this.byId(leaseId);
    if (!lease || lease.fencing_token !== token) throw new WorkLeaseConflict("stale_fence", `stale fence for ${leaseId}`);
    return this.assertFence(lease.resource, leaseId, token, now);
  }

  private insertLease(lease: WorkLease): void {
    this.db.prepare(`INSERT INTO work_leases VALUES
      (@lease_id,@resource,@dispatch_id,@owner_id,@fencing_token,@state,@acquired_at_ms,@renewed_at_ms,@expires_at_ms,@released_at_ms)`)
      .run(lease);
  }

  private record(lease: WorkLease, operation: WorkLeaseState, at: number): void {
    this.db.prepare("INSERT INTO work_lease_operations(lease_id,resource,operation,fencing_token,occurred_at_ms) VALUES (?,?,?,?,?)")
      .run(lease.lease_id, lease.resource, operation, lease.fencing_token, at);
  }

  private validateTtl(ttl: number): void {
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new RangeError("ttl_ms must be a positive safe integer");
  }
}
