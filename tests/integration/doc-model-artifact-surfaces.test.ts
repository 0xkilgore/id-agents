// Doc-model substrate slice 2 — the console's five surfaces (Now / Inbox /
// Activity / Projects / Reports), stamped via Maestra's audience/kind
// convention and projected purely from the artifact-document op log.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  admitsNowSurface,
  admitsReportsSurface,
  admitsSystemSurface,
} from "../../src/doc-model/artifact-surfaces.js";
import {
  authorArtifactDocument,
  appendArtifactComment,
  appendArtifactReceipt,
} from "../../src/doc-model/artifact-document.js";
import { mountArtifactSurfaceRoutes } from "../../src/doc-model/artifact-surface-routes.js";
import type { EntryStampKind } from "../../src/outputs/entry.js";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

async function callAppRequest(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const text = await r.text();
        server.close(() => resolve({ status: r.status, body: JSON.parse(text) }));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function mountApp(adapter: SqliteAdapter): Express {
  const app = express();
  mountArtifactSurfaceRoutes(app, adapter);
  return app;
}

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = await freshDb();
});

async function author(overrides: {
  documentId: string;
  title: string;
  audience: "operator" | "system";
  kind: EntryStampKind;
  project?: string | null;
  now?: string;
}) {
  await authorArtifactDocument(adapter, {
    teamId: "default",
    documentId: overrides.documentId,
    ownerAgent: "rams",
    actor: "rams",
    title: overrides.title,
    tag: "ux-research-weekly",
    content: `# ${overrides.title}`,
    sourceLink: null,
    availability: "present",
    audience: overrides.audience,
    kind: overrides.kind,
    project: overrides.project ?? null,
    now: overrides.now,
  });
}

describe("doc-model artifact surfaces — Now", () => {
  it("shows only open (unreceipted) operator/action-needed documents", async () => {
    await author({ documentId: "doc:open", title: "Open action item", audience: "operator", kind: "action-needed" });
    await author({ documentId: "doc:closed", title: "Closed action item", audience: "operator", kind: "action-needed" });
    await appendArtifactReceipt(adapter, { documentId: "doc:closed", actor: "chris", kind: "approve" });
    await author({ documentId: "doc:system", title: "System action item", audience: "system", kind: "action-needed" });
    await author({ documentId: "doc:report", title: "A report", audience: "operator", kind: "report" });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/now");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => e.phid)).toEqual(["doc:open"]);
    expect(res.body.items[0].stamp).toEqual({ audience: "operator", kind: "action-needed" });
    expect(res.body.items[0].now_state).toMatchObject({
      blocker_kind: "artifact_action",
      route_state: "action_open",
      receipt_state: "unreceipted",
      source_link_state: "missing",
    });
    expect(res.body.admission).toEqual({
      source: "comment_thread",
      audience: "operator",
      kinds: ["action-needed", "direction-brief"],
      reason: "operator action-needed/direction-brief rows with no receipt, plus Chris feedback comments awaiting a later receipt",
    });
  });

  it("admits operator direction briefs without title/path heuristics", async () => {
    await author({
      documentId: "doc:direction",
      title: "Neutral title",
      audience: "operator",
      kind: "direction-brief",
      now: "2026-07-14T08:00:00.000Z",
    });
    await author({
      documentId: "doc:system-direction",
      title: "Operator-sounding action",
      audience: "system",
      kind: "direction-brief",
      now: "2026-07-14T09:00:00.000Z",
    });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/now");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => e.phid)).toEqual(["doc:direction"]);
  });

  it("fronts Chris feedback blockers with source-link and receipt state, not system receipts", async () => {
    await author({
      documentId: "doc:feedback",
      title: "Kapelle feedback blocker",
      audience: "operator",
      kind: "document",
      now: "2026-07-14T08:00:00.000Z",
    });
    await adapter.query(
      `UPDATE doc_model_document_op
          SET payload_json = json_set(payload_json, '$.source_link', 'manager:/artifacts/art-kapelle-feedback/comments#op-7')
        WHERE document_id = $1 AND op_type = 'artifact_authored'`,
      ["doc:feedback"],
    );
    await appendArtifactComment(adapter, {
      documentId: "doc:feedback",
      actor: "human:chris",
      body: "This needs a source-linked receipt before sign-off.",
      now: "2026-07-14T09:00:00.000Z",
    });

    await author({
      documentId: "doc:answered",
      title: "Already answered feedback",
      audience: "operator",
      kind: "document",
      now: "2026-07-14T08:30:00.000Z",
    });
    await appendArtifactComment(adapter, {
      documentId: "doc:answered",
      actor: "chris",
      body: "Looks blocked.",
      now: "2026-07-14T09:30:00.000Z",
    });
    await appendArtifactReceipt(adapter, {
      documentId: "doc:answered",
      actor: "rams",
      kind: "ship_blocked",
      note: "routed to owner",
      now: "2026-07-14T10:00:00.000Z",
    });

    await author({
      documentId: "doc:system-receipt",
      title: "System receipt flood row",
      audience: "system",
      kind: "receipt",
      now: "2026-07-14T11:00:00.000Z",
    });
    await appendArtifactReceipt(adapter, {
      documentId: "doc:system-receipt",
      actor: "monitor",
      kind: "ship_attempted",
      note: "internal receipt",
      now: "2026-07-14T11:01:00.000Z",
    });

    const app = mountApp(adapter);
    const [now, system] = await Promise.all([
      callAppRequest(app, "/doc-model/surfaces/now"),
      callAppRequest(app, "/doc-model/surfaces/system"),
    ]);

    expect(now.status).toBe(200);
    expect(now.body.items.map((e: any) => e.phid)).toEqual(["doc:feedback"]);
    expect(now.body.items[0].now_state).toEqual({
      blocker_kind: "feedback_blocker",
      source_link: "manager:/artifacts/art-kapelle-feedback/comments#op-7",
      source_link_state: "present",
      route_state: "awaiting_response",
      receipt_state: "unreceipted",
      latest_comment: {
        op_id: expect.any(Number),
        actor: "human:chris",
        ts: "2026-07-14T09:00:00.000Z",
        body: "This needs a source-linked receipt before sign-off.",
      },
      latest_receipt: null,
    });
    expect(system.body.items.map((e: any) => e.phid)).toEqual(["doc:system-receipt"]);
  });
});

describe("doc-model artifact surfaces — Inbox", () => {
  it("shows documents awaiting a response after the latest comment, not ones already receipted", async () => {
    await author({ documentId: "doc:awaiting", title: "Awaiting response", audience: "operator", kind: "document" });
    await appendArtifactComment(adapter, { documentId: "doc:awaiting", actor: "chris", body: "Can you clarify?" });

    await author({ documentId: "doc:resolved", title: "Resolved thread", audience: "operator", kind: "document" });
    await appendArtifactComment(adapter, { documentId: "doc:resolved", actor: "chris", body: "Ship it" });
    await appendArtifactReceipt(adapter, { documentId: "doc:resolved", actor: "rams", kind: "ship_attempted" });

    await author({ documentId: "doc:no-comments", title: "No comments yet", audience: "operator", kind: "document" });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/inbox");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].entry.phid).toBe("doc:awaiting");
    expect(res.body.items[0].disposition).toBe("awaiting_response");
    expect(res.body.items[0].latest_comment.body).toBe("Can you clarify?");
    expect(res.body.admission).toEqual({
      source: "comment_thread",
      audience: "operator",
      kinds: "any",
      reason: "operator audience document whose latest comment has no later receipt",
    });
  });

  it("admits operator comments to Inbox and excludes system comments", async () => {
    await author({ documentId: "doc:operator-comment", title: "Operator comment", audience: "operator", kind: "document" });
    await appendArtifactComment(adapter, { documentId: "doc:operator-comment", actor: "chris", body: "Needs reply" });

    await author({ documentId: "doc:system-comment", title: "System comment", audience: "system", kind: "diagnostics" });
    await appendArtifactComment(adapter, { documentId: "doc:system-comment", actor: "monitor", body: "Internal signal" });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/inbox");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => e.entry.phid)).toEqual(["doc:operator-comment"]);
  });
});

describe("doc-model artifact surfaces — Activity", () => {
  it("lists receipt ops across documents, newest first", async () => {
    await author({ documentId: "doc:a", title: "A", audience: "operator", kind: "document" });
    await author({ documentId: "doc:b", title: "B", audience: "operator", kind: "document" });
    await appendArtifactReceipt(adapter, {
      documentId: "doc:a",
      actor: "chris",
      kind: "approve",
      now: "2026-07-14T10:00:00.000Z",
    });
    await appendArtifactReceipt(adapter, {
      documentId: "doc:b",
      actor: "chris",
      kind: "reject",
      note: "needs rework",
      now: "2026-07-14T11:00:00.000Z",
    });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/activity");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => ({ document_id: e.document_id, receipt_kind: e.receipt_kind }))).toEqual([
      { document_id: "doc:b", receipt_kind: "reject" },
      { document_id: "doc:a", receipt_kind: "approve" },
    ]);
    expect(res.body.items[0].note).toBe("needs rework");
  });
});

describe("doc-model artifact surfaces — Projects", () => {
  it("groups operator-facing documents by project, newest first, with an (unassigned) bucket", async () => {
    await author({
      documentId: "doc:kap-digest-old",
      title: "Kap recurring digest 1",
      audience: "operator",
      kind: "report",
      project: "kapelle",
      now: "2026-07-14T08:00:00.000Z",
    });
    await author({
      documentId: "doc:kap-final",
      title: "Kap final package",
      audience: "operator",
      kind: "final-document",
      project: "kapelle",
      now: "2026-07-14T10:00:00.000Z",
    });
    await author({
      documentId: "doc:kap-digest-new",
      title: "Kap recurring digest 2",
      audience: "operator",
      kind: "report",
      project: "kapelle",
      now: "2026-07-14T12:00:00.000Z",
    });
    await author({
      documentId: "doc:kap-diagnostics",
      title: "Kap orchestration diagnostics",
      audience: "system",
      kind: "diagnostics",
      project: "kapelle",
      now: "2026-07-14T13:00:00.000Z",
    });
    await author({
      documentId: "doc:ops-receipt",
      title: "Pool builder receipt",
      audience: "system",
      kind: "receipt",
      project: "kapelle",
      now: "2026-07-14T14:00:00.000Z",
    });
    await author({
      documentId: "doc:none",
      title: "Unassigned operator memo",
      audience: "operator",
      kind: "document",
      project: null,
      now: "2026-07-14T09:00:00.000Z",
    });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/projects");

    expect(res.status).toBe(200);
    expect(res.body.items.map((g: any) => g.project)).toEqual(["(unassigned)", "kapelle"]);
    expect(res.body.admission).toEqual({
      source: "project_group",
      audience: "operator",
      kinds: "any",
      reason: "operator-facing artifact documents grouped by project metadata; system rows remain on System unless include_system=true",
    });
    const kapelle = res.body.items.find((g: any) => g.project === "kapelle");
    expect(kapelle.documents.map((d: any) => d.document_id)).toEqual([
      "doc:kap-digest-new",
      "doc:kap-final",
      "doc:kap-digest-old",
    ]);
    expect(kapelle.documents.map((d: any) => d.kind)).toEqual(["report", "final-document", "report"]);
  });

  it("includes system diagnostics and receipts only when include_system=true", async () => {
    await author({
      documentId: "doc:kap-report",
      title: "Kap report",
      audience: "operator",
      kind: "report",
      project: "kapelle",
      now: "2026-07-14T10:00:00.000Z",
    });
    await author({
      documentId: "doc:kap-diagnostics",
      title: "Kap diagnostics",
      audience: "system",
      kind: "diagnostics",
      project: "kapelle",
      now: "2026-07-14T11:00:00.000Z",
    });
    await author({
      documentId: "doc:kap-receipt",
      title: "Kap receipt",
      audience: "system",
      kind: "receipt",
      project: "kapelle",
      now: "2026-07-14T12:00:00.000Z",
    });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/projects?include_system=true");

    expect(res.status).toBe(200);
    expect(res.body.admission).toEqual({
      source: "project_group",
      audience: "any",
      kinds: "any",
      reason: "artifact documents grouped by project metadata",
    });
    expect(res.body.items[0].documents.map((d: any) => ({ document_id: d.document_id, kind: d.kind }))).toEqual([
      { document_id: "doc:kap-receipt", kind: "receipt" },
      { document_id: "doc:kap-diagnostics", kind: "diagnostics" },
      { document_id: "doc:kap-report", kind: "report" },
    ]);
  });
});

describe("doc-model artifact surfaces — Reports", () => {
  it("shows only operator/report documents, reverse-chron", async () => {
    await author({
      documentId: "doc:report-old",
      title: "Older report",
      audience: "operator",
      kind: "report",
      now: "2026-07-13T09:00:00.000Z",
    });
    await author({
      documentId: "doc:report-new",
      title: "Newer report",
      audience: "operator",
      kind: "report",
      now: "2026-07-14T09:00:00.000Z",
    });
    await author({ documentId: "doc:action", title: "Not a report", audience: "operator", kind: "action-needed" });
    await author({ documentId: "doc:system-report", title: "System report", audience: "system", kind: "report" });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/reports");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => e.phid)).toEqual(["doc:report-new", "doc:report-old"]);
    expect(res.body.admission).toEqual({
      source: "stamp",
      audience: "operator",
      kinds: ["report", "final-document", "closeout", "qa-evidence"],
      reason: "operator audience with report, final-document, closeout, or qa-evidence kind",
    });
  });

  it("admits only operator report/final documents from mixed receipt and diagnostics fixture", async () => {
    await author({
      documentId: "doc:system-receipt",
      title: "Weekly report receipt",
      audience: "system",
      kind: "receipt",
      now: "2026-07-14T08:00:00.000Z",
    });
    await author({
      documentId: "doc:orchestration-diagnostic",
      title: "Recurring digest orchestration diagnostic",
      audience: "system",
      kind: "diagnostics",
      now: "2026-07-14T09:00:00.000Z",
    });
    await author({
      documentId: "doc:weekly-report",
      title: "Kapelle weekly operator report",
      audience: "operator",
      kind: "report",
      now: "2026-07-14T10:00:00.000Z",
    });
    await author({
      documentId: "doc:final-operator-report",
      title: "Kapelle final operator report",
      audience: "operator",
      kind: "final-document",
      now: "2026-07-14T11:00:00.000Z",
    });

    const app = mountApp(adapter);
    const [reports, system] = await Promise.all([
      callAppRequest(app, "/doc-model/surfaces/reports"),
      callAppRequest(app, "/doc-model/surfaces/system"),
    ]);

    expect(reports.status).toBe(200);
    expect(reports.body.items.map((e: any) => e.phid)).toEqual([
      "doc:final-operator-report",
      "doc:weekly-report",
    ]);
    expect(reports.body.items.map((e: any) => e.stamp)).toEqual([
      { audience: "operator", kind: "final-document" },
      { audience: "operator", kind: "report" },
    ]);

    expect(system.status).toBe(200);
    expect(system.body.items.map((e: any) => e.phid)).toEqual([
      "doc:orchestration-diagnostic",
      "doc:system-receipt",
    ]);
    expect(system.body.items.map((e: any) => e.stamp)).toEqual([
      { audience: "system", kind: "diagnostics" },
      { audience: "system", kind: "receipt" },
    ]);
  });

  it("admits operator closeout and QA evidence artifacts without title/path heuristics", async () => {
    await author({
      documentId: "doc:closeout",
      title: "Neutral completion",
      audience: "operator",
      kind: "closeout",
      now: "2026-07-14T10:00:00.000Z",
    });
    await author({
      documentId: "doc:qa",
      title: "Verification packet",
      audience: "operator",
      kind: "qa-evidence",
      now: "2026-07-14T11:00:00.000Z",
    });
    await author({
      documentId: "doc:system-closeout",
      title: "Closeout",
      audience: "system",
      kind: "closeout",
      now: "2026-07-14T12:00:00.000Z",
    });

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/reports");

    expect(res.status).toBe(200);
    expect(res.body.items.map((e: any) => e.phid)).toEqual(["doc:qa", "doc:closeout"]);
  });
});

describe("doc-model artifact surfaces — System", () => {
  it("routes system diagnostics to System and keeps them out of operator-first surfaces", async () => {
    await author({
      documentId: "doc:diagnostics",
      title: "Diagnostics",
      audience: "system",
      kind: "diagnostics",
      now: "2026-07-14T12:00:00.000Z",
    });
    await author({
      documentId: "doc:operator-report",
      title: "Operator report",
      audience: "operator",
      kind: "report",
      now: "2026-07-14T13:00:00.000Z",
    });
    await appendArtifactComment(adapter, { documentId: "doc:diagnostics", actor: "monitor", body: "Internal only" });

    const app = mountApp(adapter);
    const [system, now, inbox, reports] = await Promise.all([
      callAppRequest(app, "/doc-model/surfaces/system"),
      callAppRequest(app, "/doc-model/surfaces/now"),
      callAppRequest(app, "/doc-model/surfaces/inbox"),
      callAppRequest(app, "/doc-model/surfaces/reports"),
    ]);

    expect(system.status).toBe(200);
    expect(system.body.items.map((e: any) => e.phid)).toEqual(["doc:diagnostics"]);
    expect(system.body.admission).toEqual({
      source: "stamp",
      audience: "system",
      kinds: "any",
      reason: "system audience with a non-empty kind",
    });
    expect(now.body.items.map((e: any) => e.phid)).toEqual([]);
    expect(inbox.body.items.map((e: any) => e.entry.phid)).toEqual([]);
    expect(reports.body.items.map((e: any) => e.phid)).toEqual(["doc:operator-report"]);
  });
});

describe("doc-model artifact surface admission predicates", () => {
  it("rejects missing audience/kind stamps from operator-first and System surfaces", () => {
    expect(admitsNowSurface(null)).toBe(false);
    expect(admitsReportsSurface(null)).toBe(false);
    expect(admitsSystemSurface(null)).toBe(false);
    expect(admitsNowSurface({ audience: "operator" } as any)).toBe(false);
    expect(admitsReportsSurface({ kind: "closeout" } as any)).toBe(false);
    expect(admitsSystemSurface({ audience: "system", kind: "" } as any)).toBe(false);
  });

  it("does not leak unknown stamp kinds into Now even when title sounds actionable", async () => {
    const now = "2026-07-14T14:00:00.000Z";
    await adapter.query(
      `INSERT INTO doc_model_document (document_id, team_id, doc_type, owner_agent, revision, audience, kind, project, created_at, updated_at)
       VALUES ($1, 'default', 'artifact', 'rams', 1, 'operator', 'unknown-kind', null, $2, $3)`,
      ["doc:unknown-kind", now, now],
    );
    await adapter.query(
      `INSERT INTO doc_model_document_op (document_id, revision, op_type, actor, ts, payload_json)
       VALUES ($1, 1, 'artifact_authored', 'rams', $2, $3)`,
      [
        "doc:unknown-kind",
        now,
        JSON.stringify({
          title: "Urgent action report",
          tag: "action-needed",
          content: "# Urgent action report",
          source_link: "/output/action-needed-report.md",
          availability: "present",
          audience: "operator",
          kind: "unknown-kind",
          project: null,
        }),
      ],
    );

    const app = mountApp(adapter);
    const res = await callAppRequest(app, "/doc-model/surfaces/now");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
