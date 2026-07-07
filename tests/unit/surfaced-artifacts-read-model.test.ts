import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { appendOperation, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import {
  artifactIdForSurfacingPath,
  buildSurfacedArtifacts,
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
  };
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
        body_markdown, provider, runtime, priority, status, not_before_at,
        completed_at, updated_at, result_json, artifact_path)
     VALUES (?, 'default', ?, ?, 'cto', 'build', ?, ?, 'codex', 'codex', 5,
             ?, ?, ?, ?, ?, ?)`,
    [row.dispatch_phid, row.query_id, row.to_agent, row.subject, row.body_markdown, row.status, row.updated_at, row.completed_at, row.updated_at, row.result_json, row.artifact_path],
  );
  return row;
}

describe("surfaced artifacts title guard", () => {
  it("rejects raw PHIDs, paths, artifact tokens, and base64-like labels", () => {
    expect(isRawPrimaryTitle("phid:disp-abc123")).toBe(true);
    expect(isRawPrimaryTitle("/Users/kilgore/Dropbox/Code/x/output/a.md")).toBe(true);
    expect(isRawPrimaryTitle("artifact:v4:abc123")).toBe(true);
    expect(isRawPrimaryTitle("b3RyYW5nZXJhbmRvbXRva2VuZm9ydGVzdA==")).toBe(true);
    expect(isRawPrimaryTitle("Safe Haven call addendum")).toBe(false);
  });

  it("derives title by frontmatter, H1, dispatch/task, basename, fallback", () => {
    expect(humanTitleFromParts({ frontmatterTitle: "Frontmatter title", firstH1: "H1" })).toBe("Frontmatter title");
    expect(humanTitleFromParts({ firstH1: "H1 title" })).toBe("H1 title");
    expect(humanTitleFromParts({ dispatchTitle: "Dispatch title" })).toBe("Dispatch title");
    expect(humanTitleFromParts({ basename: "2026-07-07-zach-meeting-prep.md" })).toBe("Zach meeting prep");
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
    expect(rows[0]).toMatchObject({
      id: `artifact:${artifactIdForSurfacingPath(criticalPath)}`,
      title: "Zach meeting - scan-before-you-walk-in prep",
      status: "unread",
      relevance_reason: "latest_project_critical",
      needs: "read",
      source_kind: "artifact",
      visibility_proof: { discovered_by: "delivery_log", artifact_path_present: true, body_renderable: true },
    });
    expect(rows.find((r) => r.dispatch_ref === "phid:disp-missing")?.relevance_reason).toBe("done_without_visible_deliverable");
  });

  it("surfaces done dispatches with null, missing, empty, and renderable artifact paths", async () => {
    await seedDone(adapter, { dispatch_phid: "phid:disp-null", subject: "Null artifact path" });
    await seedDone(adapter, { dispatch_phid: "phid:disp-missing-path", subject: "Missing artifact path", artifact_path: "/tmp/vanished.md" });
    files.set("/tmp/empty.md", "   ");
    await seedDone(adapter, { dispatch_phid: "phid:disp-empty-path", subject: "Empty artifact path", artifact_path: "/tmp/empty.md" });
    files.set("/tmp/readable.md", "# Renderable closeout\n\nDone.");
    await seedDone(adapter, { dispatch_phid: "phid:disp-readable", subject: "Renderable deliverable", artifact_path: "/tmp/readable.md" });
    const rows = await buildSurfacedArtifacts(adapter, { readFile });
    expect(rows.filter((r) => r.relevance_reason === "done_without_visible_deliverable").map((r) => r.dispatch_ref).sort())
      .toEqual(["phid:disp-empty-path", "phid:disp-missing-path", "phid:disp-null"]);
    expect(rows.find((r) => r.dispatch_ref === "phid:disp-readable")).toMatchObject({
      relevance_reason: "requested_task_deliverable",
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
    const comments = (await buildSurfacedArtifacts(adapter, { readFile })).filter((r) => r.relevance_reason === "comment_needs_routing");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ title: "Route comment on Comment target", needs: "route", source_kind: "comment" });
  });
});
