import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { appendOperation, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import {
  artifactIdForSurfacingPath,
  buildSurfacedArtifacts,
  buildSurfacedArtifactsReadModel,
  humanTitleFromParts,
  isRawPrimaryTitle,
} from "../../src/surfaced-artifacts/read-model.js";

const NOW = "2026-07-07T12:00:00.000Z";

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  return adapter;
}

async function seedDone(adapter: SqliteAdapter, input: Partial<{
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  subject: string;
  body_markdown: string;
  status: string;
  completed_at: string;
  updated_at: string;
  result_json: string | null;
  artifact_path: string | null;
  promote: number;
  promotion_input_json: string | null;
  promotion_result_json: string | null;
}> = {}) {
  const row = {
    dispatch_phid: input.dispatch_phid ?? `phid:disp-${Math.random().toString(16).slice(2)}`,
    query_id: input.query_id ?? `query_${Math.random().toString(16).slice(2)}`,
    to_agent: input.to_agent ?? "substrate-api-codex",
    subject: input.subject ?? "Build the read model",
    body_markdown: input.body_markdown ?? "Please build the read model",
    status: input.status ?? "done",
    completed_at: input.completed_at ?? NOW,
    updated_at: input.updated_at ?? NOW,
    result_json: input.result_json ?? null,
    artifact_path: input.artifact_path ?? null,
    promote: input.promote ?? 0,
    promotion_input_json: input.promotion_input_json ?? null,
    promotion_result_json: input.promotion_result_json ?? null,
  };
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, priority, status, not_before_at,
        completed_at, updated_at, result_json, artifact_path,
        promote, promotion_input_json, promotion_result_json)
     VALUES (?, 'default', ?, ?, 'cto', 'build', ?, ?, 'codex', 'codex', 5,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.dispatch_phid,
      row.query_id,
      row.to_agent,
      row.subject,
      row.body_markdown,
      row.status,
      row.updated_at,
      row.completed_at,
      row.updated_at,
      row.result_json,
      row.artifact_path,
      row.promote,
      row.promotion_input_json,
      row.promotion_result_json,
    ],
  );
  return row;
}

describe("surfaced artifacts title guard", () => {
  it("rejects raw PHIDs, paths, artifact tokens, and base64-like labels", () => {
    expect(isRawPrimaryTitle("phid:disp-abc123")).toBe(true);
    expect(isRawPrimaryTitle("/Users/kilgore/Dropbox/Code/x/output/a.md")).toBe(true);
    expect(isRawPrimaryTitle("art-257a7e369057ef2d")).toBe(true);
    expect(isRawPrimaryTitle("artifact:v4:abc123")).toBe(true);
    expect(isRawPrimaryTitle("b3RyYW5nZXJhbmRvbXRva2VuZm9ydGVzdA==")).toBe(true);
    expect(isRawPrimaryTitle("L1VzZXJzL2tpbGdvcmUvRHJvcGJveC9Db2RlL3RyaW5pdHkvb3V0cHV0L3phY2gtbWVldGluZy1wcmVwLm1k")).toBe(true);
    expect(isRawPrimaryTitle("Safe Haven call addendum")).toBe(false);
  });

  it("derives title by frontmatter, H1, dispatch/task, basename, fallback", () => {
    expect(humanTitleFromParts({ frontmatterTitle: "Frontmatter title", firstH1: "H1" })).toBe("Frontmatter title");
    expect(humanTitleFromParts({ firstH1: "H1 title" })).toBe("H1 title");
    expect(humanTitleFromParts({ dispatchTitle: "Dispatch title" })).toBe("Dispatch title");
    expect(humanTitleFromParts({ basename: "2026-07-07-zach-meeting-prep.md" })).toBe("Zach meeting prep");
    expect(humanTitleFromParts({ dispatchTitle: "art-257a7e369057ef2d", basename: "2026-07-07-human-fallback.md" })).toBe("Human fallback");
    expect(humanTitleFromParts({ dispatchTitle: "phid:disp-raw", basename: "/Users/raw.md", agent: "maestra", date: NOW }))
      .toBe("Untitled artifact from maestra on 2026-07-07");
  });
});

describe("buildSurfacedArtifacts", () => {
  let adapter: SqliteAdapter;
  const files = new Map<string, string>();
  const readFile = async (path: string) => {
    const value = files.get(path);
    if (value == null) throw new Error("missing");
    return value;
  };

  beforeEach(async () => {
    adapter = await setup();
    files.clear();
  });

  it("emits the row shape and orders relevance before freshness", async () => {
    const criticalPath = "/Users/kilgore/Dropbox/Code/trinity/output/2026-06-02-zach-meeting-prep.md";
    files.set(criticalPath, "# Zach meeting - scan-before-you-walk-in prep\n\nBody");
    await registerArtifact(adapter, {
      basename: "2026-06-02-zach-meeting-prep.md",
      agent: "maestra",
      tag: "brief",
      abs_path: criticalPath,
      title: null,
      produced_at: "2026-07-07T11:00:00.000Z",
      source: "delivery-log",
    }, NOW);
    await seedDone(adapter, { dispatch_phid: "phid:disp-missing", subject: "Newer but missing deliverable", artifact_path: null });
    const rows = await buildSurfacedArtifacts(adapter, { readFile });
    expect(rows.find((r) => r.id === `artifact:${artifactIdForSurfacingPath(criticalPath)}`)).toMatchObject({
      id: `artifact:${artifactIdForSurfacingPath(criticalPath)}`,
      title: "Zach meeting - scan-before-you-walk-in prep",
      status: "unread",
      relevance_reason: "final_user_facing_deliverable",
      needs: "read",
      source_kind: "artifact",
      rank_score: expect.any(Number),
      group_count: 1,
      visibility_proof: { discovered_by: "delivery_log", artifact_path_present: true, body_renderable: true },
    });
    expect(rows.find((r) => r.dispatch_ref === "phid:disp-missing")?.relevance_reason).toBe("blocked_or_stale");
  });

  it("surfaces done dispatches with null, missing, empty, and renderable artifact paths", async () => {
    await seedDone(adapter, { dispatch_phid: "phid:disp-null", subject: "Null artifact path" });
    await seedDone(adapter, { dispatch_phid: "phid:disp-missing-path", subject: "Missing artifact path", artifact_path: "/tmp/vanished.md" });
    files.set("/tmp/empty.md", "   ");
    await seedDone(adapter, { dispatch_phid: "phid:disp-empty-path", subject: "Empty artifact path", artifact_path: "/tmp/empty.md" });
    files.set("/tmp/readable.md", "# Renderable closeout\n\nDone.");
    await seedDone(adapter, { dispatch_phid: "phid:disp-readable", subject: "Renderable deliverable", artifact_path: "/tmp/readable.md" });
    const rows = await buildSurfacedArtifacts(adapter, { readFile });
    expect(rows.filter((r) => r.relevance_reason === "blocked_or_stale").map((r) => r.dispatch_ref).sort())
      .toEqual(["phid:disp-empty-path", "phid:disp-missing-path", "phid:disp-null"]);
    expect(rows.find((r) => r.dispatch_ref === "phid:disp-readable")).toMatchObject({
      relevance_reason: "final_user_facing_deliverable",
      source_kind: "dispatch_done",
      title: "Renderable closeout",
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: true, body_renderable: true },
    });
  });

  it("surfaces comment-needs-routing rows and drops routed comments", async () => {
    await registerArtifact(adapter, {
      artifact_id: "art-comment",
      basename: "2026-07-07-comment-target.md",
      agent: "maestra",
      tag: "feedback",
      abs_path: "/tmp/comment-target.md",
      title: "Comment target",
      produced_at: NOW,
      source: "manual",
    }, NOW);
    await appendOperation(adapter, "art-comment", "comment_recorded", "user:chris", NOW, JSON.stringify({ body: "Please route this" }), null, null);
    await appendOperation(adapter, "art-comment", "comment_recorded", "user:chris", "2026-07-07T12:01:00.000Z", JSON.stringify({ body: "Already routed", route_status: { visible_state: "recorded+routed", routed: true } }), null, null);
    const comments = (await buildSurfacedArtifacts(adapter, { readFile })).filter((r) => r.needs === "route");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ title: "Route comment on Comment target", relevance_reason: "blocked_or_stale", needs: "route", source_kind: "comment" });
  });

  it("ranks accepted reasons before freshness", async () => {
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-newest-missing",
      subject: "Newest missing closeout",
      completed_at: "2026-07-07T12:05:00.000Z",
      updated_at: "2026-07-07T12:05:00.000Z",
    });
    files.set("/tmp/final.md", "# Final deliverable");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-final",
      subject: "Final deliverable",
      completed_at: "2026-07-07T12:04:00.000Z",
      updated_at: "2026-07-07T12:04:00.000Z",
      artifact_path: "/tmp/final.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-product",
      subject: "Promote changed product behavior",
      completed_at: "2026-07-07T12:03:00.000Z",
      updated_at: "2026-07-07T12:03:00.000Z",
      artifact_path: "/tmp/final.md",
      promote: 1,
      promotion_input_json: JSON.stringify({ repo: "/repo/id-agents", branch: "feat/x", base: "main", remote: "origin" }),
    });
    await registerArtifact(adapter, {
      artifact_id: "art-domain",
      basename: "2026-07-07-cleveland-park-domain-action.md",
      agent: "cleveland-park",
      tag: "urgent",
      abs_path: "/Users/kilgore/Dropbox/Code/cleveland-park/output/2026-07-07-cleveland-park-domain-action.md",
      title: "Cleveland Park domain action",
      produced_at: "2026-07-07T12:02:00.000Z",
      source: "manual",
    }, NOW);
    await registerArtifact(adapter, {
      artifact_id: "art-decision",
      basename: "2026-07-07-needs-decision.md",
      agent: "maestra",
      tag: "needs-decision",
      abs_path: "/tmp/needs-decision.md",
      title: "Needs decision on flood policy",
      produced_at: "2026-07-07T12:01:00.000Z",
      source: "manual",
    }, NOW);

    const firstByReason = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile })).reduce<string[]>((acc, row) => {
      if (!acc.includes(row.relevance_reason)) acc.push(row.relevance_reason);
      return acc;
    }, []);
    expect(firstByReason).toEqual([
      "needs_decision",
      "blocked_or_stale",
      "final_user_facing_deliverable",
      "changed_product_behavior",
      "domain_action",
    ]);
  });

  it("groups a 30-45 minute artifact flood and exposes Recent Flood raw provenance", async () => {
    files.set("/tmp/final.md", "# Final user deliverable");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-final",
      subject: "Final user deliverable",
      completed_at: "2026-07-07T12:15:00.000Z",
      updated_at: "2026-07-07T12:15:00.000Z",
      artifact_path: "/tmp/final.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-blocked",
      subject: "Blocked missing closeout",
      completed_at: "2026-07-07T12:16:00.000Z",
      updated_at: "2026-07-07T12:16:00.000Z",
      artifact_path: null,
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-promoted",
      subject: "Promote artifact surfacing behavior",
      completed_at: "2026-07-07T12:17:00.000Z",
      updated_at: "2026-07-07T12:17:00.000Z",
      promote: 1,
      promotion_input_json: JSON.stringify({ repo: "/repo/id-agents", branch: "feat/surfacing", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({ required: true, completed: true, repos: [{ source_branch: "feat/surfacing" }] }),
      artifact_path: "/tmp/final.md",
    });

    for (let i = 0; i < 24; i++) {
      const minute = String(i).padStart(2, "0");
      const kind = i % 3 === 0 ? "verification" : i % 3 === 1 ? "promotion" : "closeout";
      await registerArtifact(adapter, {
        artifact_id: `art-flood-${i}`,
        basename: `2026-07-07-artifact-surfacing-${kind}-${i}.md`,
        agent: "substrate-api-codex",
        tag: "T-LOCALREAD",
        abs_path: `/tmp/flood/artifact-surfacing-${kind}-${i}.md`,
        title: `Artifact surfacing ${kind} ${i}`,
        produced_at: `2026-07-07T12:${minute}:00.000Z`,
        source: "manual",
      }, NOW);
    }
    await registerArtifact(adapter, {
      artifact_id: "art-domain",
      basename: "2026-07-07-cleveland-park-domain-action.md",
      agent: "cleveland-park",
      tag: "urgent",
      abs_path: "/Users/kilgore/Dropbox/Code/cleveland-park/output/2026-07-07-cleveland-park-domain-action.md",
      title: "Cleveland Park domain action",
      produced_at: "2026-07-07T12:20:00.000Z",
      source: "manual",
    }, NOW);
    await registerArtifact(adapter, {
      artifact_id: "art-decision",
      basename: "2026-07-07-needs-decision.md",
      agent: "maestra",
      tag: "needs-decision",
      abs_path: "/tmp/needs-decision.md",
      title: "Needs decision on flood policy",
      produced_at: "2026-07-07T12:21:00.000Z",
      source: "manual",
    }, NOW);

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    expect(model.rows.length).toBeLessThanOrEqual(7);
    expect(model.rows.map((r) => r.relevance_reason)).toEqual(expect.arrayContaining([
      "needs_decision",
      "blocked_or_stale",
      "final_user_facing_deliverable",
      "changed_product_behavior",
      "domain_action",
    ]));

    const floodGroup = model.rows.find((r) => r.work_item_ref?.includes("artifact-surfacing"));
    expect(floodGroup).toMatchObject({
      group_count: expect.any(Number),
      grouped_source_kinds: expect.arrayContaining(["verification", "promotion", "artifact"]),
    });
    expect(floodGroup!.group_count).toBeGreaterThan(1);
    expect(model.recent_flood.total_raw_count).toBeGreaterThan(25);
    expect(model.recent_flood.raw_rows).toHaveLength(model.recent_flood.total_raw_count);
    expect(model.recent_flood.suppressed_from_primary_count).toBeGreaterThan(0);
    expect(model.recent_flood.groups.some((g) => g.raw_count > 1 && g.work_item_ref.includes("artifact-surfacing"))).toBe(true);
  });
});
