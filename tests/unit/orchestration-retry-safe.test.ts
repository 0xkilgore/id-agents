import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  getBacklogItem,
  insertBacklogItem,
  promoteToReady,
  setItemState,
} from "../../src/continuous-orchestration/storage.js";
import { planAdmission } from "../../src/continuous-orchestration/admission.js";
import { defaultConfig } from "../../src/continuous-orchestration/config.js";
import type { BacklogItem, UsageGateView } from "../../src/continuous-orchestration/types.js";

const usage: UsageGateView = { hard_paused: false, daily_percent: 0, weekly_percent: 0, enforcement: "enforce" };

function admissionFor(item: BacklogItem) {
  return planAdmission([item], {
    mode: "running",
    kill_switch_active: false,
    usage,
    daily_tokens_used: 0,
    in_flight: 0,
    active_write_scopes: new Set(),
    done_item_ids: new Set(),
    admit_limit: 1,
  }, defaultConfig());
}

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

async function alreadyDispatchedReview(adapter: SqliteAdapter, last_dispatch_phid: string) {
  const item = await insertBacklogItem(adapter, {
    title: "retry candidate",
    to_agent: "roger",
    dispatch_body: "do retry work",
    readiness_state: "ready",
    risk_class: "build",
    priority: 5,
    write_scope: ["repo"],
    token_estimate: 0,
  });
  await setItemState(adapter, item.item_id, "in_flight", { dispatch_phid: last_dispatch_phid });
  await setItemState(adapter, item.item_id, "needs_review");
  return (await getBacklogItem(adapter, item.item_id))!;
}

describe("orchestration retry-safe guard", () => {
  it("manual promotion of a failed/review row with last_dispatch_phid is held unless retry_safe is explicit", async () => {
    const adapter = await freshDb();
    const reviewed = await alreadyDispatchedReview(adapter, "phid:disp-failed-once");

    const promoted = await promoteToReady(adapter, reviewed.item_id, "chris");
    expect(promoted.ok).toBe(true);
    expect(promoted.item?.retry_safe).toBe(false);

    const plan = admissionFor(promoted.item!);
    expect(plan.admit).toHaveLength(0);
    expect(plan.skipped[0].metadata?.code).toBe("duplicate_dispatch_guard");
    await adapter.close();
  });

  it("manual promotion of a needs_clarification/review row is also held by last_dispatch_phid", async () => {
    const adapter = await freshDb();
    const reviewed = await alreadyDispatchedReview(adapter, "phid:disp-needs-clarification");

    const promoted = await promoteToReady(adapter, reviewed.item_id, "chris");
    expect(promoted.ok).toBe(true);

    const plan = admissionFor(promoted.item!);
    expect(plan.admit).toHaveLength(0);
    expect(plan.skipped[0].metadata?.last_dispatch_phid).toBe("phid:disp-needs-clarification");
    await adapter.close();
  });

  it("retry_safe promotion admits once, then setItemState(in_flight) consumes the marker", async () => {
    const adapter = await freshDb();
    const reviewed = await alreadyDispatchedReview(adapter, "phid:disp-old");

    const promoted = await promoteToReady(adapter, reviewed.item_id, "chris", { retry_safe: true });
    expect(promoted.ok).toBe(true);
    expect(promoted.item).toMatchObject({
      retry_safe: true,
      retry_approved_by: "chris",
    });
    expect(admissionFor(promoted.item!).admit.map((item) => item.item_id)).toEqual([reviewed.item_id]);

    await setItemState(adapter, reviewed.item_id, "in_flight", { dispatch_phid: "phid:disp-retry" });
    const consumed = (await getBacklogItem(adapter, reviewed.item_id))!;
    expect(consumed.retry_safe).toBe(false);
    expect(consumed.last_dispatch_phid).toBe("phid:disp-retry");
    await adapter.close();
  });

  it("superseded rows are not promotable for retry", async () => {
    const adapter = await freshDb();
    const reviewed = await alreadyDispatchedReview(adapter, "phid:disp-superseded");
    await setItemState(adapter, reviewed.item_id, "superseded");

    const promoted = await promoteToReady(adapter, reviewed.item_id, "chris", { retry_safe: true });
    expect(promoted.ok).toBe(false);
    expect(promoted.reason).toBe("cannot promote from superseded");
    await adapter.close();
  });
});
