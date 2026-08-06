import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CheckinRow, TaskRow } from "../../src/db/types.js";
import { DAILY_DESK_CAPS, DAILY_DESK_MAX_BYTES, DAILY_DESK_MAX_FIELD, buildDailyDeskResponse } from "../../src/daily-desk/projection.js";
import type {
  DailyDeskFollowThroughSource,
  DailyDeskMetadataRow,
  DailyDeskNeedsResponseSource,
  DailyDeskSourceSet,
} from "../../src/daily-desk/types.js";
import type { InboxItemRow } from "../../src/inbox/types.js";
import type { ReviewNextSourceRow } from "../../src/review-next/types.js";
import { taskRowToEntry } from "../../src/tasks-readmodel/entry-projection.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const TODAY = "2026-08-05";

describe("daily-desk.v1 manager projection", () => {
  it("captures the production-safe four-lane fixture, parity, A1 reuse, contamination and determinism receipts", async () => {
    const source = fixture();
    const first = buildDailyDeskResponse(source, { now: NOW, today: TODAY });
    const second = buildDailyDeskResponse({
      today: [...source.today].reverse(),
      review_next_source: [...source.review_next_source].reverse(),
      needs_response: [...source.needs_response].reverse(),
      follow_through: [...source.follow_through].reverse(),
    }, { now: NOW, today: TODAY });
    const memberships = membership(first);

    expect(first.schema_version).toBe("daily-desk.v1");
    expect(first.lanes.map((lane) => lane.id)).toEqual(["today", "review_next", "needs_response", "follow_through"]);
    expect(memberships).toEqual({
      today: ["task-today-newer", "task-today-older"],
      review_next: ["art-fresh-august", "art-revalidated-decision"],
      needs_response: ["inbox-operator-approval", "inbox-operator-reply"],
      follow_through: ["checkin-operator-soon", "checkin-operator-later"],
    });
    expect(membership(second)).toEqual(memberships);
    expect(second.authority.source_cursor).toBe(first.authority.source_cursor);
    expect(second).toEqual(first);
    expect(first.review_next_receipt).toMatchObject({
      schema_version: "review-next.v1",
      count: 2,
      max_rows: 5,
    });
    expect(first.lanes[1].rows.map((row) => row.review_next?.id)).toEqual(["art-fresh-august", "art-revalidated-decision"]);

    const allIds = first.lanes.flatMap((lane) => lane.rows.map((row) => row.id));
    expect(allIds.some((id) => /test|fixture|system|terminal|resolved|expired/i.test(id))).toBe(false);
    for (const lane of first.lanes) {
      expect(lane.rows.length).toBeLessThanOrEqual(DAILY_DESK_CAPS[lane.id]);
      for (const row of lane.rows) {
        expect(row).toMatchObject({
          authority: { owner: "manager", projection: "daily_desk", state: "authoritative" },
          audience: "operator",
          environment: "production",
          admission_reason: { code: expect.any(String), detail: expect.any(String), source: expect.any(String) },
          effective_lifecycle: expect.any(String),
          canonical_url: expect.any(String),
          permitted_actions: expect.any(Array),
          source_cursor: expect.stringMatching(/^sha256:/),
          source_as_of: expect.any(String),
          projection_as_of: NOW.toISOString(),
          freshness_state: expect.any(String),
          freshness_reason: expect.any(String),
        });
      }
    }
    expect(first.payload_bytes).toBe(Buffer.byteLength(JSON.stringify(first), "utf8"));
    expect(first.payload_bytes).toBeLessThanOrEqual(DAILY_DESK_MAX_BYTES);

    const canonicalTaskviewIds = source.today
      .map((row) => ({ row, entry: taskRowToEntry(row, new Map(), TODAY) }))
      .filter(({ row, entry }) => row.status !== "done" && !entry.done && !entry.archived && entry.band === "today")
      .filter(({ row }) => !/(?:^|[:/_-])(?:test|tests|fixture|fixtures|system)(?:[:/_-]|$)/i.test(`${row.id} ${row.name} ${row.title}`))
      .sort((a, b) => b.row.updated_at - a.row.updated_at || a.entry.phid.localeCompare(b.entry.phid))
      .map(({ entry }) => entry.phid);
    expect(memberships.today).toEqual(canonicalTaskviewIds);

    const stableJson = JSON.stringify(first);
    const repeatedHashes = Array.from({ length: 25 }, () => sha256(JSON.stringify(buildDailyDeskResponse(source, { now: NOW, today: TODAY }))));
    expect(new Set(repeatedHashes)).toEqual(new Set([sha256(stableJson)]));

    await mkdir("output/daily-desk-a2", { recursive: true });
    await Promise.all([
      writeFile("output/daily-desk-a2/manager-response.json", `${JSON.stringify(first, null, 2)}\n`, "utf8"),
      writeFile("output/daily-desk-a2/fixture-evidence.json", `${JSON.stringify({
        fixed_now: NOW.toISOString(),
        fixed_today: TODAY,
        admitted_membership: memberships,
        contaminants_present_in_source: [
          "task-system-fixture", "task-terminal", "art-system", "art-fixture", "art-terminal", "art-expired",
          "inbox-test-fixture", "inbox-resolved", "inbox-terminal", "checkin-test-fixture", "checkin-closed", "checkin-expired",
        ],
        admitted_contaminants: allIds.filter((id) => /test|fixture|system|terminal|resolved|expired/i.test(id)),
        needs_response_lifecycle: first.lanes[2].rows.map(({ id, effective_lifecycle, admission_reason }) => ({ id, effective_lifecycle, admission_reason })),
        follow_through_lifecycle: first.lanes[3].rows.map(({ id, effective_lifecycle, admission_reason }) => ({ id, effective_lifecycle, admission_reason })),
      }, null, 2)}\n`, "utf8"),
      writeFile("output/daily-desk-a2/today-taskview-parity.json", `${JSON.stringify({
        fixed_today: TODAY,
        filter: "task status != done; canonical task band == today; not archived; production-safe source id",
        canonical_taskview_ids: canonicalTaskviewIds,
        daily_desk_ids: memberships.today,
        canonical_count: canonicalTaskviewIds.length,
        daily_desk_count: memberships.today.length,
        parity: JSON.stringify(canonicalTaskviewIds) === JSON.stringify(memberships.today),
      }, null, 2)}\n`, "utf8"),
      writeFile("output/daily-desk-a2/determinism.json", `${JSON.stringify({
        sample_count: repeatedHashes.length,
        fixed_now: NOW.toISOString(),
        fixed_today: TODAY,
        unique_hashes: [...new Set(repeatedHashes)],
        source_cursor: first.authority.source_cursor,
        identical_lane_membership_and_order: membership(second),
      }, null, 2)}\n`, "utf8"),
    ]);
  });

  it("enforces every lane cap, bounded field lengths and the 64-KiB envelope ceiling", () => {
    const source = fixture();
    source.today = Array.from({ length: 30 }, (_, index) => task(`task-${index}`, {
      title: `${"T".repeat(10_000)} due:2026-08-05`, updated_at: epoch(`2026-08-05T${String(11 - Math.min(index, 11)).padStart(2, "0")}:00:00.000Z`),
    }));
    source.needs_response = Array.from({ length: 20 }, (_, index) => needs(`inbox-${index}`, { source_subject: "N".repeat(10_000) }));
    source.follow_through = Array.from({ length: 20 }, (_, index) => follow(`checkin-${index}`, { note: "F".repeat(10_000), next_fire_at: NOW.getTime() + index }));
    const response = buildDailyDeskResponse(source, { now: NOW, today: TODAY });
    expect(response.lanes.map((lane) => lane.rows.length)).toEqual([8, 2, 5, 5]);
    expect(response.payload_bytes).toBeLessThanOrEqual(DAILY_DESK_MAX_BYTES);
    for (const row of response.lanes.flatMap((lane) => lane.rows)) {
      expect(row.id.length).toBeLessThanOrEqual(DAILY_DESK_MAX_FIELD.id);
      expect(row.title.length).toBeLessThanOrEqual(DAILY_DESK_MAX_FIELD.title);
      expect(row.canonical_url.length).toBeLessThanOrEqual(DAILY_DESK_MAX_FIELD.url);
      expect(row.freshness_reason.length).toBeLessThanOrEqual(DAILY_DESK_MAX_FIELD.reason);
    }
  });
});

function fixture(): DailyDeskSourceSet {
  return {
    today: [
      task("task-today-older", { updated_at: epoch("2026-08-05T09:00:00.000Z") }),
      task("task-today-newer", { updated_at: epoch("2026-08-05T11:00:00.000Z") }),
      task("task-tomorrow", { title: "Tomorrow due:2026-08-06" }),
      task("task-system-fixture", { title: "System fixture due:2026-08-05" }),
      task("task-terminal", { status: "done", completed_at: epoch("2026-08-05T10:00:00.000Z") }),
    ],
    review_next_source: [
      review("art-fresh-august", { attention_priority: 0 }),
      review("art-revalidated-decision", {
        attention_priority: 1, source_as_of: "2026-07-20T12:00:00.000Z", artifact_created_at: "2026-07-20T12:00:00.000Z",
        revalidated_at: "2026-08-05T06:00:00.000Z", effective_lifecycle: "open",
      }),
      review("art-system", { audience: "system" }),
      review("art-fixture", { abs_path: "/repo/tests/fixtures/art.md" }),
      review("art-terminal", { effective_lifecycle: "resolved" }),
      review("art-expired", { source_as_of: "2026-07-01T12:00:00.000Z" }),
    ],
    needs_response: [
      needs("inbox-operator-reply", { source_subject: "Reply to neighborhood partner" }),
      needs("inbox-operator-approval", { source_subject: "Approve board packet", classification_label: "approval_needed", received_at: "2026-08-05T11:30:00.000Z" }),
      needs("inbox-test-fixture", {}, { environment: "test" }),
      needs("inbox-resolved", { resolved_at: "2026-08-05T11:00:00.000Z" }),
      needs("inbox-terminal", { operator_state: "checked_off", checked_off_at: "2026-08-05T11:00:00.000Z" }),
    ],
    follow_through: [
      follow("checkin-operator-later", { next_fire_at: NOW.getTime() + 20_000 }),
      follow("checkin-operator-soon", { next_fire_at: NOW.getTime() + 10_000 }),
      follow("checkin-test-fixture", {}, { environment: "test" }),
      follow("checkin-closed", { status: "closed" }),
      follow("checkin-expired", { ttl_expires_at: NOW.getTime() - 1 }),
    ],
  };
}

function task(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id, name: id, uuid: id, team_id: "team-1", title: `Task ${id} due:2026-08-05`, description: null,
    status: "todo", created_by: "operator", owner: "cane", created_at: epoch("2026-08-05T08:00:00.000Z"),
    updated_at: epoch("2026-08-05T10:00:00.000Z"), completed_at: null, track: "kapelle", ...overrides,
  };
}

function review(id: string, overrides: Partial<ReviewNextSourceRow> = {}): ReviewNextSourceRow {
  return {
    artifact_id: id, title: `Artifact ${id}`, artifact_created_at: "2026-08-05T10:00:00.000Z",
    produced_at: "2026-08-05T10:00:00.000Z", source: "agent-done", availability: "present",
    abs_path: `/operator/output/${id}.md`, basename: `${id}.md`, audience: "operator", environment: "production",
    owner: "cane", canonical_url: `/ops/artifacts/${id}`, effective_lifecycle: "needs_review",
    source_as_of: "2026-08-05T10:00:00.000Z", revised_at: null, revalidated_at: null, pinned_at: null,
    attention_state: "needs_review", attention_reason: "operator deliverable is ready", attention_priority: 10,
    admission_reason: "explicit operator registration", permitted_actions_json: JSON.stringify(["open", "comment", "approve"]),
    ...overrides,
  };
}

function metadata(id: string, lane: "needs_response" | "follow_through", kind: "inbox" | "checkin", overrides: Partial<DailyDeskMetadataRow> = {}): DailyDeskMetadataRow {
  return {
    team_id: "team-1", lane, entity_kind: kind, entity_id: id, audience: "operator", environment: "production",
    owner: "cane", canonical_url: lane === "needs_response" ? `/ops/inboxes?item=${id}` : `/ops/tasks?checkin=${id}`,
    effective_lifecycle: lane === "needs_response" ? "needs_response" : "waiting", source_as_of: "2026-08-05T11:00:00.000Z",
    admission_code: lane === "needs_response" ? "operator_response_required" : "active_outcome_watch",
    admission_detail: lane === "needs_response" ? "unresolved production message needs operator response" : "active production checkin awaits an outcome",
    permitted_actions_json: JSON.stringify(["open", "acknowledge"]), created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides,
  };
}

function needs(id: string, overrides: Partial<InboxItemRow> = {}, metadataOverrides: Partial<DailyDeskMetadataRow> = {}): DailyDeskNeedsResponseSource {
  return {
    metadata: metadata(id, "needs_response", "inbox", { source_as_of: overrides.received_at ?? "2026-08-05T11:00:00.000Z", ...metadataOverrides }),
    inbox: {
      inbox_phid: id, operator_state: "new", source_kind: "email", source_external_id: `production-${id}`,
      source_text: "Please respond", source_excerpt: "Please respond", source_subject: "Operator message", source_from: "person@example.com",
      classification_label: "action", classification_confidence: 1, classification_classifier: "human",
      classification_rationale: "operator response requested", project_hint: "kapelle", agent_hint: null, origin_ref: null,
      received_at: "2026-08-05T11:00:00.000Z", triaged_at: null, resolved_at: null, snoozed_until: null,
      checked_off_at: null, checked_off_reason: null, source: "index", parity_status: "ok", generated_at: NOW.toISOString(),
      projection_version: 1, legacy_inbox_md_line: null, legacy_shadow_path: null, read_at: null, ...overrides,
    },
  };
}

function follow(id: string, checkinOverrides: Partial<CheckinRow> = {}, metadataOverrides: Partial<DailyDeskMetadataRow> = {}): DailyDeskFollowThroughSource {
  const linkedTask = task(`linked-${id}`, { status: "doing" });
  return {
    metadata: metadata(id, "follow_through", "checkin", metadataOverrides),
    checkin: {
      id, team_id: "team-1", owner_agent_id: "cane", created_by_agent_id: "operator", linked_task_id: linkedTask.id,
      interval_seconds: 600, priority: "normal", status: "active", close_when: { task_status: ["done"] }, max_iterations: 10,
      iteration_count: 0, next_fire_at: NOW.getTime() + 60_000, snooze_until: null, ttl_expires_at: NOW.getTime() + 86_400_000,
      last_fire_at: null, last_event_seq: null, note: `Follow through ${id}`, created_at: NOW.getTime() - 60_000,
      updated_at: NOW.getTime() - 30_000, closed_at: null, closed_reason: null, ...checkinOverrides,
    },
    task: linkedTask,
  };
}

function membership(response: ReturnType<typeof buildDailyDeskResponse>): Record<string, string[]> {
  return Object.fromEntries(response.lanes.map((lane) => [lane.id, lane.rows.map((row) => row.id)]));
}

function epoch(iso: string): number { return Date.parse(iso) / 1000; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
