import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { approveArtifact, viewArtifact } from "../../src/outputs/ops.js";
import { appendOperation, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import {
  artifactIdForSurfacingPath,
  buildSurfacedArtifacts,
  buildSurfacedArtifactsReadModel,
  executeSurfacedArtifactsSavedView,
  humanTitleFromParts,
  isRawPrimaryTitle,
  SURFACED_ARTIFACTS_SAVED_VIEW,
  validateSavedViewField,
  validateSavedViewPredicateFields,
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

  it("publishes the canonical dotted saved-view field registry and maps raw row keys without accepting them as predicates", () => {
    expect(SURFACED_ARTIFACTS_SAVED_VIEW).toMatchObject({
      id: "surfaced-artifacts.v1.primary",
      execution: "saved_view_backed",
      field_ids: expect.arrayContaining([
        "artifact.projectRef",
        "artifact.agentName",
        "artifact.relevanceReason",
        "dispatch.id",
        "loop.nextRunAt",
        "user_task.title",
      ]),
      raw_row_key_mapping: expect.objectContaining({
        project_ref: "artifact.projectRef",
        agent_name: "artifact.agentName",
        relevance_reason: "artifact.relevanceReason",
      }),
    });
    expect(SURFACED_ARTIFACTS_SAVED_VIEW.field_ids).not.toContain("project_ref");
    expect(validateSavedViewField("artifact.projectRef")).toBeNull();
    expect(validateSavedViewPredicateFields({ op: "eq", field: "project_ref", value: "kapelle" })).toEqual([
      {
        code: "unsupported_field",
        field: "project_ref",
        canonical_field: "artifact.projectRef",
        message: 'Raw SurfacedArtifactRow key "project_ref" is not a saved-view field id; use "artifact.projectRef".',
      },
    ]);
  });

  it("executes saved views against canonical dotted field ids", async () => {
    await registerArtifact(adapter, {
      artifact_id: "art-kapelle",
      basename: "2026-07-07-kapelle-task.md",
      agent: "substrate-api-codex",
      tag: "KG-03",
      abs_path: "/tmp/kapelle-task.md",
      title: "Kapelle task output",
      produced_at: NOW,
      source: "delivery-log",
    }, NOW);
    await registerArtifact(adapter, {
      artifact_id: "art-finance",
      basename: "2026-07-07-finances-task.md",
      agent: "finances",
      tag: "KG-06",
      abs_path: "/Users/kilgore/Dropbox/Code/finances/output/2026-07-07-finances-task.md",
      title: "Finance task output",
      produced_at: NOW,
      source: "delivery-log",
    }, NOW);

    const rows = await buildSurfacedArtifacts(adapter, { limit: 7, readFile });
    const result = executeSurfacedArtifactsSavedView(rows, {
      and: [
        { op: "eq", field: "artifact.projectRef", value: "finances" },
        { op: "eq", field: "artifact.agentName", value: "finances" },
      ],
    }, NOW);

    expect(result).toMatchObject({
      ok: true,
      count: 1,
      errors: [],
      rows: [expect.objectContaining({
        id: "artifact:art-finance",
        project_ref: "finances",
        agent_name: "finances",
      })],
    });
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
      delivery: expect.objectContaining({
        stable_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/detail`,
        copy_text_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/copy-text`,
        download_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/download`,
        freshness: "current",
      }),
    });
    expect(rows.find((r) => r.dispatch_ref === "phid:disp-missing")?.relevance_reason).toBe("blocked_or_stale");
  });

  it("projects cached artifact bodies as renderable when the source path is unavailable", async () => {
    const artifactId = "art-cache-fallback";
    await registerArtifact(adapter, {
      artifact_id: artifactId,
      basename: "2026-07-07-cache-fallback.md",
      agent: "substrate-api-codex",
      tag: "T-RELY",
      abs_path: "/tmp/cache-fallback.md",
      title: null,
      produced_at: NOW,
      source: "agent-done",
      media_type: "text/markdown",
      content_hash: "hash-current",
      source_mtime: "2026-07-07T11:59:00.000Z",
    }, NOW);
    await adapter.query(
      `INSERT INTO artifact_bodies
         (artifact_id, media_type, content_hash, source_mtime, source_size,
          body_text, body_truncated, body_error, cached_at, updated_at)
       VALUES (?, 'text/markdown', 'hash-current', '2026-07-07T11:59:00.000Z',
               37, '# Cache-backed artifact\n\nReadable.', 0, NULL, ?, ?)`,
      [artifactId, NOW, NOW],
    );

    const row = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile }))
      .find((r) => r.id === `artifact:${artifactId}`);
    expect(row).toMatchObject({
      title: "Cache-backed artifact",
      visibility_proof: {
        discovered_by: "agent_done",
        artifact_path_present: true,
        body_renderable: true,
      },
      delivery: expect.objectContaining({
        freshness: "current",
        body_cached: true,
        body_preview: "# Cache-backed artifact\n\nReadable.",
      }),
    });
  });

  it("projects stale freshness when cached artifact body evidence no longer matches the catalog", async () => {
    const artifactId = "art-stale-cache";
    await registerArtifact(adapter, {
      artifact_id: artifactId,
      basename: "2026-07-07-stale-cache.md",
      agent: "substrate-api-codex",
      tag: "T-RELY",
      abs_path: "/tmp/stale-cache.md",
      title: "Stale cache",
      produced_at: NOW,
      source: "agent-done",
      media_type: "text/markdown",
      content_hash: "hash-new",
      source_mtime: "2026-07-07T12:00:00.000Z",
    }, NOW);
    await adapter.query(
      `INSERT INTO artifact_bodies
         (artifact_id, media_type, content_hash, source_mtime, source_size,
          body_text, body_truncated, body_error, cached_at, updated_at)
       VALUES (?, 'text/markdown', 'hash-old', '2026-07-07T11:00:00.000Z',
               22, '# Older cache body', 0, NULL, ?, ?)`,
      [artifactId, NOW, NOW],
    );

    const row = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile }))
      .find((r) => r.id === `artifact:${artifactId}`);
    expect(row).toMatchObject({
      visibility_proof: { body_renderable: true },
      delivery: expect.objectContaining({
        freshness: "stale",
        body_cached: true,
        content_hash: "hash-new",
      }),
    });
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

  it("normalizes the KG-04 local-path closeout to a stable full-view artifact id", async () => {
    const kg04Path = "/Users/kilgore/Dropbox/Code/cane/id-agents-kg04-worktree/output/kg-04-task-doc-backend-fix-closeout.md";
    files.set(kg04Path, "# KG-04 Task Doc Backend Fix Closeout\n\nDispatch: `phid:disp-f207819b3d1db8cf`");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-kg04",
      subject: "KG-04 Task Doc Backend Fix Closeout",
      artifact_path: kg04Path,
    });

    const stableId = artifactIdForSurfacingPath(kg04Path);
    const row = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile }))
      .find((candidate) => candidate.dispatch_ref === "phid:disp-kg04");

    expect(row).toMatchObject({
      title: "KG-04 Task Doc Backend Fix Closeout",
      artifact_ref: stableId,
      visibility_proof: {
        artifact_path_present: true,
        body_renderable: true,
      },
      delivery: expect.objectContaining({
        artifact_id: stableId,
        source_path: kg04Path,
        stable_url: `/artifacts/${stableId}/detail`,
        freshness: "current",
      }),
    });
    expect(row?.artifact_ref).not.toBe(kg04Path);
  });

  it("emits fail-loud health events for unreadable bodies and rows missing from the primary surface", async () => {
    files.set("/tmp/current.md", "# Current surfaced artifact\n\nReadable.");
    files.set("/tmp/suppressed.md", "# Suppressed readable artifact\n\nReadable but outside the cap.");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-current",
      subject: "Current surfaced artifact",
      completed_at: "2026-07-07T12:10:00.000Z",
      updated_at: "2026-07-07T12:10:00.000Z",
      artifact_path: "/tmp/current.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-unreadable",
      subject: "Unreadable registered artifact",
      completed_at: "2026-07-07T12:09:00.000Z",
      updated_at: "2026-07-07T12:09:00.000Z",
      artifact_path: "/tmp/vanished.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-suppressed",
      subject: "Suppressed readable artifact",
      completed_at: "2026-07-07T12:08:00.000Z",
      updated_at: "2026-07-07T12:08:00.000Z",
      artifact_path: "/tmp/suppressed.md",
    });

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 1, readFile });
    expect(model.health.ok).toBe(false);
    expect(model.health.surface).toBe("ops.surfaced-artifacts.health");
    expect(model.health.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        topic: "artifact.surfacing.body_unavailable",
        severity: "error",
        subject_kind: "dispatch",
        subject_id: "phid:disp-unreadable",
        data: expect.objectContaining({
          dispatch_ref: "phid:disp-unreadable",
          artifact_ref: artifactIdForSurfacingPath("/tmp/vanished.md"),
          discovered_by: "agent_done",
          body_renderable: false,
        }),
      }),
      expect.objectContaining({
        topic: "artifact.surfacing.missing_from_primary",
        severity: "warning",
        subject_kind: "dispatch",
        subject_id: "phid:disp-suppressed",
        data: expect.objectContaining({
          dispatch_ref: "phid:disp-suppressed",
          artifact_ref: artifactIdForSurfacingPath("/tmp/suppressed.md"),
          discovered_by: "agent_done",
          body_renderable: true,
        }),
      }),
    ]));
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

  it("emits read, commented, routed, and approved statuses deterministically", async () => {
    for (const id of ["art-read", "art-commented", "art-routed", "art-approved"]) {
      await registerArtifact(adapter, {
        artifact_id: id,
        basename: `${id}.md`,
        agent: "maestra",
        abs_path: `/tmp/${id}.md`,
        title: id,
        produced_at: NOW,
        source: "manual",
      }, NOW);
    }
    await viewArtifact(adapter, "art-read", { viewer: "human:chris" }, () => new Date(NOW));
    await appendOperation(adapter, "art-commented", "comment_recorded", "human:chris", NOW, JSON.stringify({ body: "Needs a reply" }), null, null);
    await appendOperation(adapter, "art-routed", "comment_routed", "manager", NOW, JSON.stringify({ to: "maestra" }), null, null);
    await approveArtifact(adapter, "art-approved", { approver: "human:chris" }, () => new Date(NOW));

    const byId = new Map((await buildSurfacedArtifacts(adapter, { limit: 7, readFile })).map((r) => [r.id, r.status]));
    expect(byId.get("artifact:art-read")).toBe("read");
    expect(byId.get("artifact:art-commented")).toBe("commented");
    expect(byId.get("artifact:art-routed")).toBe("routed");
    expect(byId.get("artifact:art-approved")).toBe("approved");
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
    expect(model.recent_flood.source_data).toMatchObject({
      raw_limit: 250,
      primary_limit: 7,
      raw_row_count: model.recent_flood.total_raw_count,
      primary_row_count: model.rows.length,
      capped: true,
    });
    expect(model.recent_flood.raw_rows).toHaveLength(model.recent_flood.total_raw_count);
    expect(model.recent_flood.suppressed_from_primary_count).toBeGreaterThan(0);
    expect(model.recent_flood.groups.some((g) => g.raw_count > 1 && g.work_item_ref.includes("artifact-surfacing"))).toBe(true);
  });

  it("keeps the Artifact Desk first viewport focused and leaves raw closeout floods in diagnostics", async () => {
    files.set("/tmp/action-final.md", [
      "---",
      "project: kapelle",
      "track: T-QA",
      "---",
      "# Operator verification handoff",
      "",
      "A focused deliverable for the operator.",
    ].join("\n"));
    files.set("/tmp/product-change.md", "# Artifact Desk product behavior change");

    await seedDone(adapter, {
      dispatch_phid: "phid:disp-action-final",
      subject: "Final Artifact Desk verification handoff",
      body_markdown: "[project: kapelle][T-QA] Final deliverable",
      completed_at: "2026-07-07T12:10:00.000Z",
      updated_at: "2026-07-07T12:10:00.000Z",
      artifact_path: "/tmp/action-final.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-product-change",
      subject: "Promote Artifact Desk first viewport behavior",
      body_markdown: "[project: kapelle][T-QA] changed product behavior",
      completed_at: "2026-07-07T12:09:00.000Z",
      updated_at: "2026-07-07T12:09:00.000Z",
      artifact_path: "/tmp/product-change.md",
      promote: 1,
      promotion_input_json: JSON.stringify({ repo: "/repo/id-agents", branch: "artifact-desk-smoke", base: "main", remote: "origin" }),
    });
    await registerArtifact(adapter, {
      artifact_id: "art-needs-decision",
      basename: "2026-07-07-needs-decision-artifact-desk-density.md",
      agent: "maestra",
      tag: "needs-decision",
      abs_path: "/tmp/needs-decision-artifact-desk-density.md",
      title: "Needs decision on Artifact Desk row density",
      produced_at: "2026-07-07T12:08:00.000Z",
      source: "manual",
    }, NOW);
    await registerArtifact(adapter, {
      artifact_id: "art-domain-action",
      basename: "2026-07-07-cleveland-park-domain-action.md",
      agent: "cleveland-park",
      tag: "urgent",
      abs_path: "/Users/kilgore/Dropbox/Code/cleveland-park/output/2026-07-07-cleveland-park-domain-action.md",
      title: "Cleveland Park domain action",
      produced_at: "2026-07-07T12:07:00.000Z",
      source: "manual",
    }, NOW);

    for (let i = 0; i < 18; i++) {
      await seedDone(adapter, {
        dispatch_phid: `phid:disp-closeout-spam-${i}`,
        subject: `phid:disp-closeout-spam-${i}`,
        body_markdown: "raw closeout heartbeat",
        completed_at: `2026-07-07T12:${String(30 + i).padStart(2, "0")}:00.000Z`,
        updated_at: `2026-07-07T12:${String(30 + i).padStart(2, "0")}:00.000Z`,
      });
    }

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    const rawCloseoutSpam = model.recent_flood.raw_rows.filter((row) => row.dispatch_ref?.includes("closeout-spam"));

    expect(model.rows.length).toBeLessThanOrEqual(7);
    expect(model.rows.length).toBeGreaterThanOrEqual(4);
    expect(model.rows.every((row) => row.status && row.relevance_reason && row.needs)).toBe(true);
    expect(model.rows.some((row) => row.title === "Operator verification handoff")).toBe(true);
    expect(model.rows.some((row) => row.relevance_reason === "needs_decision")).toBe(true);
    expect(model.rows.some((row) => row.relevance_reason === "changed_product_behavior")).toBe(true);
    expect(model.rows.some((row) => row.relevance_reason === "domain_action")).toBe(true);
    expect(model.rows.some((row) => row.dispatch_ref?.includes("closeout-spam"))).toBe(false);
    expect(model.rows.some((row) => row.title.startsWith("Untitled artifact from "))).toBe(false);
    expect(rawCloseoutSpam).toHaveLength(18);
    expect(model.recent_flood.source_data).toMatchObject({
      primary_limit: 7,
      primary_row_count: model.rows.length,
      raw_row_count: model.recent_flood.total_raw_count,
      capped: true,
    });
    expect(SURFACED_ARTIFACTS_SAVED_VIEW.diagnostic_field_ids).toEqual(expect.arrayContaining([
      "surfaced_artifacts.recent_flood.source_data",
      "surfaced_artifacts.recent_flood.raw_rows",
    ]));

    const screenshots = await writeArtifactDeskSmokeScreenshots(model.rows, model.recent_flood.total_raw_count);
    expect(screenshots.desktop.boxes.every((box, index, boxes) => boxes.slice(index + 1).every((next) => !boxesOverlap(box, next)))).toBe(true);
    expect(screenshots.mobile.boxes.every((box, index, boxes) => boxes.slice(index + 1).every((next) => !boxesOverlap(box, next)))).toBe(true);
  });

  it("discovers the local-first handoff by human title, project, program, track, and dispatch", async () => {
    const handoffPath = "/tmp/local-first-handoff.md";
    files.set(handoffPath, `---
project: kapelle
track:
  - T-LOCALREAD
source_dispatch: phid:disp-local-first
---

# Local-First Project/Artifact Surfacing Integration Handoff

This program should be queued as the Local-First Project/Artifact Surfacing program.
`);
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-local-first",
      query_id: "query_local_first",
      subject: "artifact:v4:raw-token-should-not-win",
      body_markdown: "[project: kapelle][T-LOCALREAD] Local-first artifact surfacing handoff",
      completed_at: "2026-07-07T12:30:00.000Z",
      updated_at: "2026-07-07T12:30:00.000Z",
      artifact_path: handoffPath,
    });

    const row = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile }))
      .find((r) => r.dispatch_ref === "phid:disp-local-first");
    expect(row).toMatchObject({
      title: "Local-First Project/Artifact Surfacing Integration Handoff",
      project_ref: "kapelle",
      program_ref: "local-first-project-artifact-surfacing",
      track_ref: "T-LOCALREAD",
      dispatch_ref: "phid:disp-local-first",
      source_kind: "dispatch_done",
    });
  });

  it("groups repeated dispatch, task, branch, and project artifacts behind one primary row", async () => {
    files.set("/tmp/task-closeout.md", [
      "---",
      "project: kapelle",
      "task: kg03-read-this-next-saved-views-backend",
      "---",
      "# Read This Next closeout",
    ].join("\n"));
    files.set("/tmp/task-verification.md", [
      "---",
      "project: kapelle",
      "task: kg03-read-this-next-saved-views-backend",
      "---",
      "# Read This Next verification",
    ].join("\n"));
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-task-closeout",
      subject: "Read This Next closeout",
      body_markdown: "Task: kg03-read-this-next-saved-views-backend",
      artifact_path: "/tmp/task-closeout.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-task-verification",
      subject: "Read This Next verification",
      body_markdown: "Task: kg03-read-this-next-saved-views-backend",
      artifact_path: "/tmp/task-verification.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-branch-promo-a",
      subject: "Promotion record A",
      promote: 1,
      promotion_input_json: JSON.stringify({ repo: "/repo/id-agents", branch: "feat/read-this-next", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({ completed: true }),
      artifact_path: "/tmp/task-closeout.md",
    });
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-branch-promo-b",
      subject: "Promotion record B",
      promote: 1,
      promotion_input_json: JSON.stringify({ repo: "/repo/id-agents", branch: "feat/read-this-next", base: "main", remote: "origin" }),
      promotion_result_json: JSON.stringify({ completed: true }),
      artifact_path: "/tmp/task-verification.md",
    });

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    const taskGroup = model.rows.find((row) => row.work_item_ref === "task:kg03-read-this-next-saved-views-backend");
    const branchGroup = model.rows.find((row) => row.work_item_ref === "branch:feat/read-this-next");

    expect(taskGroup).toMatchObject({
      id: "group:task:kg03-read-this-next-saved-views-backend",
      task_ref: "kg03-read-this-next-saved-views-backend",
      project_ref: "kapelle",
      group_count: 2,
      grouped_source_kinds: expect.arrayContaining(["dispatch_done", "verification"]),
    });
    expect(branchGroup).toMatchObject({
      id: "group:branch:feat/read-this-next",
      group_count: 2,
      grouped_source_kinds: expect.arrayContaining(["promotion"]),
    });
    expect(model.recent_flood.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        work_item_ref: "task:kg03-read-this-next-saved-views-backend",
        raw_count: 2,
        project_ref: "kapelle",
      }),
      expect.objectContaining({
        work_item_ref: "branch:feat/read-this-next",
        raw_count: 2,
      }),
    ]));
  });

  it("registers canonical saved-view ids for surfaced row fields", () => {
    expect(SURFACED_ARTIFACTS_SAVED_VIEW).toMatchObject({
      id: "surfaced-artifacts.v1.primary",
      field_ids: expect.arrayContaining([
        "artifact.title",
        "artifact.status",
        "artifact.relevanceReason",
        "artifact.projectRef",
        "artifact.programRef",
        "artifact.trackRef",
        "artifact.dispatchRef",
        "artifact.delivery.copyTextUrl",
      ]),
      diagnostic_field_ids: expect.arrayContaining([
        "surfaced_artifacts.recent_flood.source_data",
        "surfaced_artifacts.recent_flood.raw_rows",
      ]),
    });
    expect(SURFACED_ARTIFACTS_SAVED_VIEW.field_ids).not.toContain("surfaced_artifacts.row.project_ref");
  });
});

interface SmokeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function writeArtifactDeskSmokeScreenshots(rows: Array<{
  title: string;
  status: string;
  relevance_reason: string;
  needs?: string;
  source_kind: string;
}>, rawCount: number): Promise<{ desktop: { path: string; boxes: SmokeBox[] }; mobile: { path: string; boxes: SmokeBox[] } }> {
  const outDir = resolve(process.env.ARTIFACT_DESK_SMOKE_OUTPUT_DIR ?? "output");
  await mkdir(outDir, { recursive: true });
  const desktop = renderArtifactDeskSmokeSvg(rows, rawCount, { width: 1280, rowHeight: 68, titleLimit: 62 });
  const mobile = renderArtifactDeskSmokeSvg(rows, rawCount, { width: 390, rowHeight: 86, titleLimit: 34 });
  const desktopPath = resolve(outDir, "artifact-desk-first-viewport-desktop.svg");
  const mobilePath = resolve(outDir, "artifact-desk-first-viewport-mobile.svg");
  await Promise.all([
    writeFile(desktopPath, desktop.svg, "utf8"),
    writeFile(mobilePath, mobile.svg, "utf8"),
  ]);
  return {
    desktop: { path: desktopPath, boxes: desktop.boxes },
    mobile: { path: mobilePath, boxes: mobile.boxes },
  };
}

function renderArtifactDeskSmokeSvg(
  rows: Array<{ title: string; status: string; relevance_reason: string; needs?: string; source_kind: string }>,
  rawCount: number,
  opts: { width: number; rowHeight: number; titleLimit: number },
): { svg: string; boxes: SmokeBox[] } {
  const margin = 24;
  const headerHeight = 58;
  const gap = 10;
  const rowsHeight = rows.length * opts.rowHeight + Math.max(0, rows.length - 1) * gap;
  const height = headerHeight + rowsHeight + 76;
  const boxes = rows.map((_, index) => ({
    x: margin,
    y: headerHeight + index * (opts.rowHeight + gap),
    width: opts.width - margin * 2,
    height: opts.rowHeight,
  }));
  const rowSvg = rows.map((row, index) => {
    const box = boxes[index];
    const title = escapeSvg(truncateForSvg(row.title, opts.titleLimit));
    const meta = escapeSvg(`${row.relevance_reason} / ${row.needs ?? "inspect"} / ${row.status}`);
    const kind = escapeSvg(row.source_kind);
    return [
      `<g data-row="${index + 1}">`,
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="6" fill="#ffffff" stroke="#b7bec8"/>`,
      `<text x="${box.x + 14}" y="${box.y + 26}" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#17202a">${title}</text>`,
      `<text x="${box.x + 14}" y="${box.y + 50}" font-family="Arial, sans-serif" font-size="12" fill="#495563">${meta}</text>`,
      `<text x="${box.x + box.width - 132}" y="${box.y + 50}" font-family="Arial, sans-serif" font-size="12" fill="#495563">${kind}</text>`,
      "</g>",
    ].join("");
  }).join("");
  const diagnosticY = headerHeight + rowsHeight + 34;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${height}" viewBox="0 0 ${opts.width} ${height}">`,
    `<rect width="${opts.width}" height="${height}" fill="#f6f8fb"/>`,
    `<text x="${margin}" y="34" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#17202a">Artifact Desk</text>`,
    `<text x="${opts.width - margin - 230}" y="34" font-family="Arial, sans-serif" font-size="13" fill="#495563">Primary rows: ${rows.length} / 7</text>`,
    rowSvg,
    `<text x="${margin}" y="${diagnosticY}" font-family="Arial, sans-serif" font-size="13" fill="#495563">Recent Flood diagnostics kept secondary: ${rawCount} raw rows</text>`,
    "</svg>",
  ].join("");
  return { svg, boxes };
}

function boxesOverlap(a: SmokeBox, b: SmokeBox): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function escapeSvg(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncateForSvg(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
