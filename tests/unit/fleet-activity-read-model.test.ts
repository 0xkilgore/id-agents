import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import {
  buildFleetActivity,
  normalizeKinds,
  normalizeLimit,
  normalizeSince,
} from "../../src/fleet-activity/read-model.js";
import { mountFleetActivityRoutes } from "../../src/fleet-activity/routes.js";

const TEAM = "team_fleet";
const OTHER_TEAM = "team_other";
const NOW = "2026-06-29T12:00:00.000Z";
const SINCE = "2026-06-29T00:00:00.000Z";

async function seedBase(adapter: SqliteAdapter): Promise<void> {
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2), ($3, $4)`, [
    TEAM,
    "fleet",
    OTHER_TEAM,
    "other",
  ]);
  await adapter.query(
    `INSERT INTO agents
       (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata, last_seen)
     VALUES
       (? ,? ,? ,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL,?),
       (? ,? ,? ,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL,?),
       (? ,? ,? ,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL,?)`,
    [
      "agent_eames", TEAM, "eames",
      Date.parse("2026-06-29T10:15:00.000Z"),
      "agent_roger", TEAM, "roger",
      Date.parse("2026-06-28T23:00:00.000Z"),
      "agent_outsider", OTHER_TEAM, "outsider",
      Date.parse("2026-06-29T10:45:00.000Z"),
    ],
  );
}

async function seedArtifact(
  adapter: SqliteAdapter,
  id: string,
  agent: string,
  producedAt: string,
): Promise<void> {
  await adapter.query(
    `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, source_badges, created_at, updated_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,'agent-done','present','[]',$7,$8)`,
    [id, `${id}.md`, agent, `/tmp/${id}.md`, `Artifact ${id}`, producedAt, producedAt, producedAt],
  );
}

async function seedTask(
  adapter: SqliteAdapter,
  id: string,
  teamId: string,
  status: string,
  opts: { name: string; title: string; owner?: string | null; updatedAt: string; completedAt?: string | null },
): Promise<void> {
  await adapter.query(
    `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,'agent_eames',$7,$8,$9,$10,'daily')`,
    [
      id,
      opts.name,
      `uuid-${id}`,
      teamId,
      opts.title,
      status,
      opts.owner ?? null,
      Date.parse("2026-06-28T00:00:00.000Z"),
      Date.parse(opts.updatedAt),
      opts.completedAt ? Date.parse(opts.completedAt) : null,
    ],
  );
}

async function seedComment(
  adapter: SqliteAdapter,
  artifactId: string,
  actor: string,
  ts: string,
  body: string,
): Promise<void> {
  await adapter.query(
    `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
     VALUES ($1,'comment_recorded',$2,$3,$4,NULL,NULL)`,
    [artifactId, actor, ts, JSON.stringify({ body, anchor: null })],
  );
}

async function seedDispatch(
  adapter: SqliteAdapter,
  phid: string,
  teamId: string,
  status: string,
  opts: { startedAt?: string | null; completedAt?: string | null; updatedAt: string },
): Promise<void> {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, priority, status, not_before_at,
        attempt_count, bounce_count, started_at, completed_at, updated_at)
     VALUES ($1,$2,$3,$4,'manager','dispatch',$5,'body','openai','codex',5,$6,$7,0,0,$8,$9,$10)`,
    [
      phid, teamId, `q-${phid}`, "eames", `Subject ${phid}`, status,
      opts.updatedAt, opts.startedAt ?? null, opts.completedAt ?? null, opts.updatedAt,
    ],
  );
}

async function request(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("fleet activity read-model", () => {
  it("returns team-scoped artifact, comment, task, and dispatch activity since the watermark, newest-first", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    // In-window, on-team
    await seedArtifact(adapter, "art_new", "eames", "2026-06-29T09:00:00.000Z");
    // Out-of-window (before SINCE) — must be excluded
    await seedArtifact(adapter, "art_old", "roger", "2026-06-28T09:00:00.000Z");
    // In-window but foreign team's agent — must be excluded
    await seedArtifact(adapter, "art_foreign", "outsider", "2026-06-29T10:00:00.000Z");
    await seedComment(adapter, "art_new", "user:chris", "2026-06-29T09:15:00.000Z", "Looks good.");
    await seedComment(adapter, "art_foreign", "user:chris", "2026-06-29T10:15:00.000Z", "Other team only.");

    await seedTask(adapter, "task_done", TEAM, "done", {
      name: "finish-daily-brief",
      title: "Finish daily brief",
      owner: "agent_eames",
      updatedAt: "2026-06-29T10:20:00.000Z",
      completedAt: "2026-06-29T10:20:00.000Z",
    });
    await seedTask(adapter, "task_claimed", TEAM, "doing", {
      name: "review-feed",
      title: "Review feed",
      owner: "agent_roger",
      updatedAt: "2026-06-29T08:30:00.000Z",
    });
    await seedTask(adapter, "task_foreign", OTHER_TEAM, "done", {
      name: "foreign-task",
      title: "Foreign task",
      owner: "agent_outsider",
      updatedAt: "2026-06-29T10:40:00.000Z",
      completedAt: "2026-06-29T10:40:00.000Z",
    });

    // In-window completed dispatch (newest event)
    await seedDispatch(adapter, "phid:disp-done", TEAM, "done", {
      startedAt: "2026-06-29T10:00:00.000Z",
      completedAt: "2026-06-29T11:00:00.000Z",
      updatedAt: "2026-06-29T11:00:00.000Z",
    });
    // In-window queued dispatch
    await seedDispatch(adapter, "phid:disp-queued", TEAM, "queued", {
      updatedAt: "2026-06-29T08:00:00.000Z",
    });
    // Out-of-window completed dispatch — excluded
    await seedDispatch(adapter, "phid:disp-old", TEAM, "done", {
      completedAt: "2026-06-28T08:00:00.000Z",
      updatedAt: "2026-06-28T08:00:00.000Z",
    });
    // Foreign team dispatch in-window — excluded
    await seedDispatch(adapter, "phid:disp-foreign", OTHER_TEAM, "done", {
      completedAt: "2026-06-29T10:30:00.000Z",
      updatedAt: "2026-06-29T10:30:00.000Z",
    });

    const res = await buildFleetActivity(adapter, {
      teamName: "fleet",
      since: SINCE,
      generatedAt: NOW,
    });

    expect(res.schema_version).toBe("fleet.activity.v1");
    expect(res.team).toEqual({ id: TEAM, name: "fleet" });
    expect(res.warnings).toEqual([]);

    const ids = res.items.map((i) => i.id);
    expect(ids).toEqual([
      "dispatch_completed:phid:disp-done", // 11:00 newest
      "task_completed:task_done", // 10:20
      "artifact_commented:art_new:1", // 09:15
      "artifact_produced:art_new", // 09:00
      "task_claimed:task_claimed", // 08:30
      "dispatch_queued:phid:disp-queued", // 08:00
    ]);
    expect(ids).not.toContain("artifact_produced:art_old");
    expect(ids).not.toContain("artifact_produced:art_foreign");
    expect(ids).not.toContain("artifact_commented:art_foreign:2");
    expect(ids).not.toContain("task_completed:task_foreign");
    expect(ids).not.toContain("dispatch_completed:phid:disp-old");
    expect(ids).not.toContain("dispatch_completed:phid:disp-foreign");

    expect(res.counts).toMatchObject({
      total: 6,
      returned: 6,
      artifact_produced: 1,
      dispatch_completed: 1,
      dispatch_queued: 1,
      task_completed: 1,
      task_claimed: 1,
      artifact_commented: 1,
    });
    // Watermark advances to the newest returned event.
    expect(res.watermark.since).toBe(SINCE);
    expect(res.watermark.next).toBe("2026-06-29T11:00:00.000Z");

    // The completed event carries the producing agent + dispatch metadata.
    const done = res.items.find((i) => i.kind === "dispatch_completed")!;
    expect(done.actor).toBe("eames");
    expect(done.ts).toBe("2026-06-29T11:00:00.000Z");
    expect(done.metadata.status).toBe("done");

    const comment = res.items.find((i) => i.kind === "artifact_commented")!;
    expect(comment.actor).toBe("user:chris");
    expect(comment.summary).toBe("Looks good.");

    expect(res.instrumentation).toMatchObject({
      generated_for_day: "2026-06-29",
      active_window_hours: 24,
      daily_active_agents: 1,
    });
    expect(res.instrumentation.agents.map((a) => a.name)).toEqual(["eames", "roger"]);
    expect(res.instrumentation.agents.find((a) => a.name === "eames")).toMatchObject({
      last_seen_at: "2026-06-29T10:15:00.000Z",
      active_today: true,
    });
    expect(res.instrumentation.agents.find((a) => a.name === "roger")).toMatchObject({
      last_seen_at: "2026-06-28T23:00:00.000Z",
      active_today: false,
    });
  });

  it("filters by kinds and honors the limit with a truncation warning", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    await seedArtifact(adapter, "art_a", "eames", "2026-06-29T09:00:00.000Z");
    await seedArtifact(adapter, "art_b", "roger", "2026-06-29T09:30:00.000Z");
    await seedDispatch(adapter, "phid:disp-x", TEAM, "done", {
      completedAt: "2026-06-29T11:00:00.000Z",
      updatedAt: "2026-06-29T11:00:00.000Z",
    });

    const onlyArtifacts = await buildFleetActivity(adapter, {
      teamName: "fleet",
      since: SINCE,
      kinds: ["artifact_produced"],
      generatedAt: NOW,
    });
    expect(onlyArtifacts.items.every((i) => i.kind === "artifact_produced")).toBe(true);
    expect(onlyArtifacts.counts.artifact_produced).toBe(2);
    expect(onlyArtifacts.counts.dispatch_completed).toBe(0);
    expect(onlyArtifacts.counts.task_completed).toBe(0);

    const limited = await buildFleetActivity(adapter, {
      teamName: "fleet",
      since: SINCE,
      limit: 1,
      generatedAt: NOW,
    });
    expect(limited.items).toHaveLength(1);
    expect(limited.counts.total).toBe(3);
    expect(limited.counts.returned).toBe(1);
    expect(limited.warnings.some((w) => w.code === "truncated")).toBe(true);
  });

  it("scopes to nothing and warns when the team is unknown", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    await seedArtifact(adapter, "art_a", "eames", "2026-06-29T09:00:00.000Z");

    const res = await buildFleetActivity(adapter, {
      teamName: "does-not-exist",
      generatedAt: NOW,
    });
    expect(res.team.id).toBeNull();
    expect(res.items).toEqual([]);
    expect(res.counts.total).toBe(0);
    expect(res.warnings.some((w) => w.code === "team_not_found")).toBe(true);
  });

  it("warns on an unparseable since and returns the full recent window", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    await seedArtifact(adapter, "art_old", "eames", "2020-01-01T00:00:00.000Z");

    const res = await buildFleetActivity(adapter, {
      teamName: "fleet",
      since: "not-a-date",
      generatedAt: NOW,
    });
    expect(res.filters.since).toBeNull();
    expect(res.items.map((i) => i.id)).toContain("artifact_produced:art_old");
    expect(res.warnings.some((w) => w.code === "invalid_since")).toBe(true);
  });

  it("serves the envelope over GET /fleet/activity", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    await seedArtifact(adapter, "art_new", "eames", "2026-06-29T09:00:00.000Z");

    const app = express();
    mountFleetActivityRoutes(app, adapter, { now: () => new Date(NOW) });
    const { status, body } = await request(
      app,
      `/fleet/activity?team=fleet&since=${encodeURIComponent(SINCE)}`,
    );
    expect(status).toBe(200);
    expect(body.schema_version).toBe("fleet.activity.v1");
    expect(body.team.id).toBe(TEAM);
    expect(body.items.map((i: any) => i.id)).toContain("artifact_produced:art_new");
  });
});

describe("fleet activity normalizers", () => {
  it("normalizeLimit clamps and defaults", () => {
    expect(normalizeLimit(undefined)).toBe(50);
    expect(normalizeLimit("0")).toBe(50);
    expect(normalizeLimit("10")).toBe(10);
    expect(normalizeLimit("9999")).toBe(200);
  });

  it("normalizeSince validates ISO", () => {
    expect(normalizeSince("2026-06-29T00:00:00.000Z")).toBe("2026-06-29T00:00:00.000Z");
    expect(normalizeSince("nope")).toBeNull();
    expect(normalizeSince(undefined)).toBeNull();
  });

  it("normalizeKinds parses a csv and drops unknowns", () => {
    expect(normalizeKinds("artifact_produced,bogus")).toEqual(["artifact_produced"]);
    expect(normalizeKinds("bogus")).toBeNull();
    expect(normalizeKinds(undefined)).toBeNull();
  });
});
