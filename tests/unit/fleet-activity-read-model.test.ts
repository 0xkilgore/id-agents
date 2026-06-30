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
       (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata)
     VALUES
       ($1,$2,$3,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL),
       ($4,$5,$6,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL),
       ($7,$8,$9,'worker','test',0,NULL,NULL,'running',1782690000,NULL,NULL)`,
    [
      "agent_eames", TEAM, "eames",
      "agent_roger", TEAM, "roger",
      "agent_outsider", OTHER_TEAM, "outsider",
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
  it("returns team-scoped artifacts + dispatch activity since the watermark, newest-first", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    // In-window, on-team
    await seedArtifact(adapter, "art_new", "eames", "2026-06-29T09:00:00.000Z");
    // Out-of-window (before SINCE) — must be excluded
    await seedArtifact(adapter, "art_old", "roger", "2026-06-28T09:00:00.000Z");
    // In-window but foreign team's agent — must be excluded
    await seedArtifact(adapter, "art_foreign", "outsider", "2026-06-29T10:00:00.000Z");

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
      "artifact_produced:art_new", // 09:00
      "dispatch_queued:phid:disp-queued", // 08:00
    ]);
    expect(ids).not.toContain("artifact_produced:art_old");
    expect(ids).not.toContain("artifact_produced:art_foreign");
    expect(ids).not.toContain("dispatch_completed:phid:disp-old");
    expect(ids).not.toContain("dispatch_completed:phid:disp-foreign");

    expect(res.counts).toMatchObject({
      total: 3,
      returned: 3,
      artifact_produced: 1,
      dispatch_completed: 1,
      dispatch_queued: 1,
    });
    // Watermark advances to the newest returned event.
    expect(res.watermark.since).toBe(SINCE);
    expect(res.watermark.next).toBe("2026-06-29T11:00:00.000Z");

    // The completed event carries the producing agent + dispatch metadata.
    const done = res.items.find((i) => i.kind === "dispatch_completed")!;
    expect(done.actor).toBe("eames");
    expect(done.ts).toBe("2026-06-29T11:00:00.000Z");
    expect(done.metadata.status).toBe("done");
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
