import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { approveArtifact, viewArtifact } from "../../src/outputs/ops.js";
import { appendOperation, migrateOutputsTables, registerArtifact as registerArtifactRaw } from "../../src/outputs/storage.js";
import {
  artifactIdForSurfacingPath,
  buildSurfacedArtifacts,
  buildSurfacedArtifactsReadModel,
  executeSeededSurfacedArtifactsSavedView,
  humanTitleFromParts,
  isRawPrimaryTitle,
  SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS,
  SURFACED_ARTIFACTS_SAVED_VIEW,
  validateSavedViewField,
  validateSavedViewPredicateFields,
} from "../../src/surfaced-artifacts/read-model.js";
import type { SurfacedArtifactRow } from "../../src/surfaced-artifacts/types.js";

const NOW = "2026-07-07T12:00:00.000Z";
const C0_ON = { C0_FEEDBACK_REACTIONS: "1" } as NodeJS.ProcessEnv;

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  return adapter;
}

async function registerArtifact(
  adapter: SqliteAdapter,
  req: Parameters<typeof registerArtifactRaw>[1],
  nowIso: string,
) {
  return registerArtifactRaw(adapter, {
    project_ref: inferFixtureProject(req.abs_path),
    ...req,
  }, nowIso);
}

function inferFixtureProject(path: string): string {
  const match = path.match(/\/Code\/([^/]+)\//);
  return match?.[1] ?? "kapelle";
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
    expect(isRawPrimaryTitle("query_1783603546849_56slpvk")).toBe(true);
    expect(isRawPrimaryTitle("dispatch-phid-disp-0e69020874071c73")).toBe(true);
    expect(isRawPrimaryTitle("task:implement-read-next-surfaced-contract")).toBe(true);
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
    expect(humanTitleFromParts({ dispatchTitle: "query_1783603546849_56slpvk", basename: "2026-07-07-readable-closeout.md" })).toBe("Readable closeout");
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
        "artifact.sourceType",
        "artifact.sourcePath",
        "artifact.sourceProof",
        "artifact.delivery.bodyAvailable",
        "artifact.delivery.bodySource",
        "artifact.delivery.openUrl",
        "artifact.relevanceReason",
        "dispatch.id",
        "loop.nextRunAt",
        "user_task.title",
      ]),
      raw_row_key_mapping: expect.objectContaining({
        project_ref: "artifact.projectRef",
        agent_name: "artifact.agentName",
        source_type: "artifact.sourceType",
        source_path: "artifact.sourcePath",
        source_proof: "artifact.sourceProof",
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
    expect(validateSavedViewPredicateFields({ op: "eq", field: "source_type", value: "artifact" })).toEqual([
      {
        code: "unsupported_field",
        field: "source_type",
        canonical_field: "artifact.sourceType",
        message: 'Raw SurfacedArtifactRow key "source_type" is not a saved-view field id; use "artifact.sourceType".',
      },
    ]);
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
      source_type: "artifact",
      source_path: criticalPath,
      source_proof: `delivery-log:${criticalPath}`,
      rank_score: expect.any(Number),
      group_count: 1,
      visibility_proof: { discovered_by: "delivery_log", artifact_path_present: true, body_renderable: true },
      delivery: expect.objectContaining({
        stable_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/detail`,
        copy_text_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/copy-text`,
        download_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/download`,
        freshness: "current",
        body_available: true,
        body_source: "filesystem",
        open_url: `/artifacts/${encodeURIComponent(artifactIdForSurfacingPath(criticalPath))}/detail`,
      }),
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
      source_type: "artifact",
      source_path: "/tmp/readable.md",
      source_proof: "agent-done:/tmp/readable.md",
      title: "Renderable closeout",
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: true, body_renderable: true },
      delivery: expect.objectContaining({
        body_available: true,
        body_source: "filesystem",
      }),
    });
  });

  it("coalesces filesystem, agent-done, manual, and delivery-log rows by stable path artifact id", async () => {
    const sharedPath = "/Users/kilgore/Dropbox/Code/kapelle/output/2026-07-07-stable-artifact-id.md";
    const stableArtifactId = artifactIdForSurfacingPath(sharedPath);
    files.set(sharedPath, `---
project: kapelle
---

# Stable Artifact ID

One local file observed through multiple local-first sources.
`);

    for (const source of ["manual", "delivery-log", "filesystem", "agent-done"] as const) {
      await registerArtifact(adapter, {
        artifact_id: `legacy-${source}`,
        basename: "2026-07-07-stable-artifact-id.md",
        agent: "substrate-api-codex",
        tag: "T-LOCALREAD",
        abs_path: sharedPath,
        title: `${source} observation`,
        produced_at: "2026-07-07T12:05:00.000Z",
        source,
      }, NOW);
    }
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-stable-artifact-id",
      subject: "Agent done stable artifact id",
      completed_at: "2026-07-07T12:06:00.000Z",
      updated_at: "2026-07-07T12:06:00.000Z",
      artifact_path: sharedPath,
    });

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    const row = model.rows.find((r) => r.id === `artifact:${stableArtifactId}`);
    expect(row).toMatchObject({
      id: `artifact:${stableArtifactId}`,
      artifact_ref: sharedPath,
      project_ref: "kapelle",
      group_count: 5,
      grouped_source_kinds: expect.arrayContaining(["artifact", "dispatch_done", "filesystem_reconcile"]),
      delivery: expect.objectContaining({
        stable_url: `/artifacts/${stableArtifactId}/detail`,
        copy_text_url: `/artifacts/${stableArtifactId}/copy-text`,
        download_url: `/artifacts/${stableArtifactId}/download`,
      }),
    });
    expect(model.recent_flood.groups.find((g) => g.work_item_ref === `artifact:${stableArtifactId}`))
      .toMatchObject({ raw_count: 5, project_ref: "kapelle" });
    expect(model.recent_flood.raw_rows.filter((r) => r.id === `artifact:${stableArtifactId}`)).toHaveLength(5);
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
          artifact_ref: "/tmp/vanished.md",
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
          artifact_ref: "/tmp/suppressed.md",
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
    const comments = (await buildSurfacedArtifacts(adapter, { readFile, env: C0_ON })).filter((r) => r.needs === "route");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ title: "Route comment on Comment target", relevance_reason: "blocked_or_stale", needs: "route", source_kind: "comment" });
  });

  it("does not surface disabled feedback comments as stale route work", async () => {
    await registerArtifact(adapter, {
      artifact_id: "art-disabled-comment",
      basename: "2026-07-07-disabled-comment.md",
      agent: "maestra",
      tag: "feedback",
      abs_path: "/tmp/disabled-comment.md",
      title: "Disabled comment target",
      produced_at: NOW,
      source: "manual",
    }, NOW);
    await appendOperation(adapter, "art-disabled-comment", "comment_recorded", "user:chris", NOW, JSON.stringify({ body: "Old feedback before flag rollback" }), null, null);

    const rows = await buildSurfacedArtifacts(adapter, { limit: 7, readFile, env: {} as NodeJS.ProcessEnv });
    expect(rows.some((r) => r.id.startsWith("comment:art-disabled-comment:"))).toBe(false);
    expect(rows.find((r) => r.id === `artifact:${artifactIdForSurfacingPath("/tmp/disabled-comment.md")}`)?.status).toBe("unread");
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

    const byId = new Map((await buildSurfacedArtifacts(adapter, { limit: 7, readFile, env: C0_ON })).map((r) => [r.id, r.status]));
    expect(byId.get(`artifact:${artifactIdForSurfacingPath("/tmp/art-read.md")}`)).toBe("read");
    expect(byId.get(`artifact:${artifactIdForSurfacingPath("/tmp/art-commented.md")}`)).toBe("commented");
    expect(byId.get(`artifact:${artifactIdForSurfacingPath("/tmp/art-routed.md")}`)).toBe("routed");
    expect(byId.get(`artifact:${artifactIdForSurfacingPath("/tmp/art-approved.md")}`)).toBe("approved");
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
    files.set("/tmp/product.md", "# Product behavior change");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-product",
      subject: "Promote changed product behavior",
      completed_at: "2026-07-07T12:03:00.000Z",
      updated_at: "2026-07-07T12:03:00.000Z",
      artifact_path: "/tmp/product.md",
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
    files.set("/tmp/promoted.md", "# Promoted artifact surfacing behavior");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-final",
      subject: "Final user deliverable",
      completed_at: "2026-07-07T12:15:00.000Z",
      updated_at: "2026-07-07T12:15:00.000Z",
      artifact_path: "/tmp/promoted.md",
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
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: true, body_renderable: true },
      delivery: expect.objectContaining({
        body_available: true,
        body_source: "filesystem",
        freshness: "current",
      }),
    });
    expect(isRawPrimaryTitle(row!.title)).toBe(false);
  });

  it("classifies legacy artifacts for audience, kind, project, and track with bounded provenance", async () => {
    const finalPath = "/Users/kilgore/Dropbox/Code/kapelle/output/2026-07-07-final-project-document.md";
    files.set(finalPath, "# Final Kapelle Project Document\n\nFinal handoff for [T-LOCALREAD].");
    await registerArtifact(adapter, {
      artifact_id: "art-final-project-document",
      basename: "2026-07-07-final-project-document.md",
      agent: "substrate-api-codex",
      tag: null,
      abs_path: finalPath,
      title: "Final project document",
      produced_at: "2026-07-07T12:35:00.000Z",
      source: "manual",
    }, NOW);

    await registerArtifact(adapter, {
      artifact_id: "art-qa-receipt",
      basename: "2026-07-07-qa-receipt.md",
      agent: "substrate-api-codex",
      tag: "T-LOCALREAD",
      abs_path: "/tmp/qa-receipt.md",
      title: "QA receipt - smoke tests green",
      produced_at: "2026-07-07T12:36:00.000Z",
      source: "manual",
    }, NOW);

    await seedDone(adapter, {
      dispatch_phid: "phid:disp-system-closeout",
      subject: "System closeout receipt promoted and verified",
      body_markdown: "[project: kapelle][T-LOCALREAD] agent-done closeout receipt completed.",
      completed_at: "2026-07-07T12:37:00.000Z",
      updated_at: "2026-07-07T12:37:00.000Z",
      artifact_path: null,
    });

    await seedDone(adapter, {
      dispatch_phid: "phid:disp-operator-action",
      subject: "Operator action required",
      body_markdown: "[project: kapelle][T-LOCALREAD] Please approve the final document before routing.",
      completed_at: "2026-07-07T12:38:00.000Z",
      updated_at: "2026-07-07T12:38:00.000Z",
      artifact_path: null,
    });

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    const byDispatch = new Map(model.recent_flood.raw_rows.map((row) => [row.dispatch_ref, row]));
    const byArtifact = new Map(model.recent_flood.raw_rows.map((row) => [row.artifact_ref, row]));

    expect(byDispatch.get("phid:disp-operator-action")).toMatchObject({
      project_ref: "kapelle",
      track_ref: "T-LOCALREAD",
      legacy_classification: {
        audience: "operator",
        kind: "operator_action",
        project_ref: "kapelle",
        track_ref: "T-LOCALREAD",
        confidence: 0.9,
        reason: "operator-action-keyword",
        source_fields: expect.arrayContaining([
          expect.objectContaining({ field: "title", value: "Operator action required" }),
          expect.objectContaining({ field: "dispatch_body", value: "[project: kapelle][T-LOCALREAD] Please approve the final document before routing." }),
        ]),
      },
    });
    expect(byDispatch.get("phid:disp-system-closeout")).toMatchObject({
      legacy_classification: {
        audience: "system",
        kind: "system_receipt",
        confidence: 0.82,
        reason: "system-receipt-keyword",
      },
    });
    expect(byArtifact.get("/tmp/qa-receipt.md")).toMatchObject({
      track_ref: "T-LOCALREAD",
      legacy_classification: {
        audience: "system",
        kind: "qa_receipt",
        track_ref: "T-LOCALREAD",
        confidence: 0.86,
        reason: "qa-receipt-keyword",
      },
    });
    expect(byArtifact.get(finalPath)).toMatchObject({
      project_ref: "kapelle",
      track_ref: "T-LOCALREAD",
      legacy_classification: {
        audience: "reader",
        kind: "final_document",
        project_ref: "kapelle",
        track_ref: "T-LOCALREAD",
        confidence: 0.84,
        reason: "final-document-keyword",
      },
    });

    const operatorRows = executeSeededSurfacedArtifactsSavedView(model.recent_flood.raw_rows, "workQueue", {
      field: "artifact.legacy.audience",
      op: "eq",
      value: "operator",
    }, NOW);
    expect(operatorRows.rows.map((row) => row.dispatch_ref)).toEqual(["phid:disp-operator-action"]);
    expect(model.recent_flood.raw_rows.every((row) => (row.legacy_classification?.source_fields.length ?? 0) <= 10)).toBe(true);
  });

  it("keeps a Cleveland Park same-morning artifact visible as a domain action after grouping", async () => {
    for (let i = 0; i < 10; i++) {
      await registerArtifact(adapter, {
        artifact_id: `art-localread-spam-${i}`,
        basename: `2026-07-07-localread-${i % 2 === 0 ? "verification" : "promotion"}-${i}.md`,
        agent: "substrate-api-codex",
        tag: "T-LOCALREAD",
        abs_path: `/tmp/localread/${i % 2 === 0 ? "verification" : "promotion"}-${i}.md`,
        title: `Localread ${i % 2 === 0 ? "verification" : "promotion"} ${i}`,
        produced_at: `2026-07-07T08:${String(i).padStart(2, "0")}:00.000Z`,
        source: "manual",
      }, NOW);
    }
    const sameMorningPath = "/Users/kilgore/Dropbox/Code/cleveland-park/output/2026-07-07-same-morning-fall-fest-rundown.md";
    files.set(sameMorningPath, `---
project: cleveland-park
---

# Same Morning Fall Fest Rundown

Vendor staging and volunteer assignments for this morning.
`);
    await registerArtifact(adapter, {
      artifact_id: "art-cleveland-park-same-morning",
      basename: "2026-07-07-same-morning-fall-fest-rundown.md",
      agent: "cleveland-park",
      tag: "newsletter",
      abs_path: sameMorningPath,
      title: "artifact:v4:raw-cleveland-token",
      produced_at: "2026-07-07T08:35:00.000Z",
      source: "delivery-log",
    }, NOW);

    const model = await buildSurfacedArtifactsReadModel(adapter, { limit: 7, readFile });
    const cleveland = model.rows.find((r) => r.artifact_ref === sameMorningPath);
    expect(cleveland).toMatchObject({
      title: "Same Morning Fall Fest Rundown",
      project_ref: "cleveland-park",
      relevance_reason: "domain_action",
      needs: "read",
      source_kind: "artifact",
      source_type: "artifact",
      visibility_proof: { discovered_by: "delivery_log", artifact_path_present: true, body_renderable: true },
      delivery: expect.objectContaining({
        body_available: true,
        body_source: "filesystem",
        freshness: "current",
      }),
    });
    expect(model.recent_flood.groups.some((g) => g.work_item_ref.includes("localread") && g.raw_count > 1)).toBe(true);
    expect(model.rows.length).toBeLessThanOrEqual(7);
    expect(isRawPrimaryTitle(cleveland!.title)).toBe(false);
  });

  it("rejects raw ids as surfaced row titles and falls back to human derivation", async () => {
    const rawPath = "/tmp/2026-07-07-human-readable-closeout.md";
    files.set(rawPath, "No heading in this artifact body.");
    await seedDone(adapter, {
      dispatch_phid: "phid:disp-raw-title",
      query_id: "query_1783603546849_56slpvk",
      subject: "query_1783603546849_56slpvk",
      body_markdown: "Done.",
      completed_at: "2026-07-07T12:45:00.000Z",
      updated_at: "2026-07-07T12:45:00.000Z",
      artifact_path: rawPath,
    });

    const row = (await buildSurfacedArtifacts(adapter, { limit: 7, readFile }))
      .find((r) => r.dispatch_ref === "phid:disp-raw-title");
    expect(row).toMatchObject({
      title: "Human readable closeout",
      source_path: rawPath,
      visibility_proof: { discovered_by: "agent_done", artifact_path_present: true, body_renderable: true },
    });
    expect(row!.title).not.toBe("query_1783603546849_56slpvk");
    expect(isRawPrimaryTitle(row!.title)).toBe(false);
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

  it("seeds artifactDesk, personalTasks, and workQueue through the same saved-view executor", () => {
    const rows: SurfacedArtifactRow[] = [
      fixtureRow({
        id: "artifact:a",
        title: "Artifact desk row",
        artifact_ref: "/tmp/a.md",
        task_ref: undefined,
        dispatch_ref: undefined,
        project_ref: "kapelle",
        needs: "read",
        rank_score: 50,
      }),
      fixtureRow({
        id: "artifact:t",
        title: "Personal task row",
        task_ref: "task:personal",
        project_ref: "personal",
        needs: "comment",
        rank_score: 70,
      }),
      fixtureRow({
        id: "artifact:w",
        title: "Work queue dispatch",
        dispatch_ref: "phid:disp-work",
        project_ref: "kapelle",
        needs: "inspect_closeout",
        rank_score: 90,
      }),
    ];

    expect(Object.keys(SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS).sort()).toEqual([
      "artifactDesk",
      "personalTasks",
      "workQueue",
    ]);
    expect(SEEDED_SURFACED_ARTIFACTS_SAVED_VIEWS.personalTasks.field_ids).toEqual(
      expect.arrayContaining(["user_task.id", "user_task.title", "user_task.owner", "user_task.updatedAt"]),
    );

    const artifactDesk = executeSeededSurfacedArtifactsSavedView(rows, "artifactDesk", {
      field: "artifact.projectRef",
      op: "eq",
      value: "kapelle",
    }, NOW);
    const personalTasks = executeSeededSurfacedArtifactsSavedView(rows, "personalTasks", {
      field: "user_task.projectRef",
      op: "eq",
      value: "personal",
    }, NOW);
    const workQueue = executeSeededSurfacedArtifactsSavedView(rows, "workQueue", {
      field: "work_item.rank",
      op: "gte",
      value: 80,
    }, NOW);

    expect(artifactDesk).toMatchObject({
      ok: true,
      view_id: "surfaced-artifacts.v1.artifactDesk",
      rows: [{ id: "artifact:a" }, { id: "artifact:w" }],
      count: 2,
    });
    expect(personalTasks).toMatchObject({
      ok: true,
      view_id: "surfaced-artifacts.v1.personalTasks",
      rows: [{ id: "artifact:t" }],
      count: 1,
    });
    expect(workQueue).toMatchObject({
      ok: true,
      view_id: "surfaced-artifacts.v1.workQueue",
      rows: [{ id: "artifact:w" }],
      count: 1,
    });

    expect(executeSeededSurfacedArtifactsSavedView(rows, "workQueue", {
      field: "rank_score",
      op: "gte",
      value: 80,
    }, NOW).errors).toEqual([
      expect.objectContaining({
        code: "unsupported_field",
        field: "rank_score",
        canonical_field: "artifact.rankScore",
      }),
    ]);
  });
});

function fixtureRow(overrides: Partial<SurfacedArtifactRow>): SurfacedArtifactRow {
  return {
    id: "artifact:fixture",
    title: "Fixture row",
    subtitle: "Fixture subtitle",
    rank_score: 10,
    status: "unread",
    relevance_reason: "final_user_facing_deliverable",
    needs: "read",
    artifact_ref: "/tmp/fixture.md",
    dispatch_ref: "phid:disp-fixture",
    task_ref: "task:fixture",
    project_ref: "kapelle",
    agent_name: "roger",
    created_at: NOW,
    updated_at: NOW,
    source_kind: "artifact",
    source_type: "artifact",
    source_label: "Fixture",
    source_path: "/tmp/fixture.md",
    source_proof: "fixture",
    visibility_proof: {
      discovered_by: "manual_fixture",
      artifact_path_present: true,
      body_renderable: true,
    },
    delivery: {
      stable_url: "/artifacts/fixture/detail",
      copy_text_url: "/artifacts/fixture/copy-text",
      download_url: "/artifacts/fixture/download",
      media_type: "text/markdown",
      freshness: "current",
      body_cached: false,
      body_available: true,
      body_source: "filesystem",
      open_url: "/artifacts/fixture/detail",
    },
    ...overrides,
  };
}
