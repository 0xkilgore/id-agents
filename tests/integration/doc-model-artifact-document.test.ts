// Doc-model substrate slice 1 — artifacts as documents.
//
// Pilot: rams' UX Research Loop output flowing through the op-log +
// projection end-to-end. Nothing here writes or reads a markdown file —
// content lives only as `doc_model_document_op` rows.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  authorArtifactDocument,
  appendArtifactComment,
  appendArtifactReceipt,
  projectArtifactDocument,
} from "../../src/doc-model/artifact-document.js";
import { mountArtifactDocumentRoutes } from "../../src/doc-model/artifact-document-routes.js";

async function freshDb() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  return adapter;
}

async function callAppRequest(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method,
          headers: method === "POST" ? { "content-type": "application/json" } : undefined,
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        });
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
  app.use(express.json());
  mountArtifactDocumentRoutes(app, adapter);
  return app;
}

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = await freshDb();
});

describe("doc-model artifact documents — storage", () => {
  it("authors a document once (idempotent on document_id) and projects content + frontmatter from ops alone", async () => {
    const first = await authorArtifactDocument(adapter, {
      teamId: "default",
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      ownerAgent: "rams",
      actor: "rams",
      title: "UX Research Weekly — 2026-07-14",
      tag: "ux-research-weekly",
      content: "# Findings\n\n1. Console artifact reader reads markdown-on-disk.",
      sourceLink: "https://manager.local/artifacts/docart:rams:ux-research-weekly:2026-07-14",
      availability: "present",
    });
    expect(first.inserted).toBe(true);

    const retry = await authorArtifactDocument(adapter, {
      teamId: "default",
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      ownerAgent: "rams",
      actor: "rams",
      title: "duplicate author attempt",
      tag: null,
      content: "should not overwrite",
      sourceLink: null,
      availability: "present",
    });
    expect(retry.inserted).toBe(false);

    const projection = await projectArtifactDocument(adapter, "docart:rams:ux-research-weekly:2026-07-14");
    expect(projection).toMatchObject({
      schema_version: "doc_model.artifact_document.v1",
      document_id: "docart:rams:ux-research-weekly:2026-07-14",
      doc_type: "artifact",
      owner_agent: "rams",
      revision: 1,
      frontmatter: {
        title: "UX Research Weekly — 2026-07-14",
        tag: "ux-research-weekly",
        authored_by: "rams",
      },
      content: "# Findings\n\n1. Console artifact reader reads markdown-on-disk.",
      comments: [],
      receipts: [],
      op_count: 1,
    });
  });

  it("appends comment and receipt ops that show up in the next projection", async () => {
    await authorArtifactDocument(adapter, {
      teamId: "default",
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      ownerAgent: "rams",
      actor: "rams",
      title: "UX Research Weekly — 2026-07-14",
      tag: "ux-research-weekly",
      content: "# Findings",
      sourceLink: null,
      availability: "present",
    });

    const commentResult = await appendArtifactComment(adapter, {
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      actor: "chris",
      body: "Good find on the reader, ship it.",
    });
    expect(commentResult.revision).toBe(2);

    const receiptResult = await appendArtifactReceipt(adapter, {
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      actor: "chris",
      kind: "approve",
      note: "approved after review",
    });
    expect(receiptResult.revision).toBe(3);

    const projection = await projectArtifactDocument(adapter, "docart:rams:ux-research-weekly:2026-07-14");
    expect(projection?.revision).toBe(3);
    expect(projection?.op_count).toBe(3);
    expect(projection?.comments).toEqual([
      expect.objectContaining({ actor: "chris", body: "Good find on the reader, ship it." }),
    ]);
    expect(projection?.receipts).toEqual([
      expect.objectContaining({ actor: "chris", kind: "approve", note: "approved after review" }),
    ]);
  });

  it("rejects appending to an unauthored document", async () => {
    await expect(
      appendArtifactComment(adapter, { documentId: "docart:missing", actor: "chris", body: "x" }),
    ).rejects.toThrow(/unknown doc-model document/);
  });

  it("returns null when projecting an unknown document", async () => {
    const projection = await projectArtifactDocument(adapter, "docart:missing");
    expect(projection).toBeNull();
  });
});

describe("doc-model artifact documents — /doc-model/artifacts route (rams pilot, end-to-end)", () => {
  it("an agent's output flows through as document ops, is readable via the projection route without touching disk, and a comment updates it", async () => {
    // Simulate rams' UX Research Loop writing its weekly output as document
    // ops instead of a markdown file — the write side of the pilot.
    await authorArtifactDocument(adapter, {
      teamId: "default",
      documentId: "docart:rams:ux-research-weekly:2026-07-14",
      ownerAgent: "rams",
      actor: "rams",
      title: "UX Research Weekly — 2026-07-14",
      tag: "ux-research-weekly",
      content: "# Findings\n\n1. Console artifact reader reads markdown-on-disk.\n2. Kill the grep pattern.",
      sourceLink: "https://manager.local/artifacts/docart:rams:ux-research-weekly:2026-07-14",
      availability: "present",
    });

    const app = mountApp(adapter);

    // The read side: a console/projection consumer fetches the document over
    // HTTP. The route only ever queries doc_model_document(_op) — it has no
    // filesystem access in its implementation at all.
    const before = await callAppRequest(app, "GET", "/doc-model/artifacts/docart:rams:ux-research-weekly:2026-07-14");
    expect(before.status).toBe(200);
    expect(before.body.document).toMatchObject({
      owner_agent: "rams",
      revision: 1,
      frontmatter: { title: "UX Research Weekly — 2026-07-14", tag: "ux-research-weekly" },
      content: "# Findings\n\n1. Console artifact reader reads markdown-on-disk.\n2. Kill the grep pattern.",
      comments: [],
      op_count: 1,
    });

    // A comment appends an op...
    const commentRes = await callAppRequest(
      app,
      "POST",
      "/doc-model/artifacts/docart:rams:ux-research-weekly:2026-07-14/comments",
      { actor: "chris", body: "Great pilot, this is the pattern." },
    );
    expect(commentRes.status).toBe(200);
    expect(commentRes.body.document.revision).toBe(2);

    // ...and the projection updates on the very next read.
    const after = await callAppRequest(app, "GET", "/doc-model/artifacts/docart:rams:ux-research-weekly:2026-07-14");
    expect(after.status).toBe(200);
    expect(after.body.document.revision).toBe(2);
    expect(after.body.document.op_count).toBe(2);
    expect(after.body.document.comments).toEqual([
      expect.objectContaining({ actor: "chris", body: "Great pilot, this is the pattern." }),
    ]);
    // Content and frontmatter are untouched by the comment op.
    expect(after.body.document.content).toBe(before.body.document.content);
  });

  it("404s a document that was never authored", async () => {
    const app = mountApp(adapter);
    const res = await callAppRequest(app, "GET", "/doc-model/artifacts/docart:nope");
    expect(res.status).toBe(404);
  });

  it("400s a comment missing actor or body, 404s a comment on an unauthored document", async () => {
    const app = mountApp(adapter);
    const missingFields = await callAppRequest(app, "POST", "/doc-model/artifacts/docart:rams:x/comments", { actor: "chris" });
    expect(missingFields.status).toBe(400);

    const unauthored = await callAppRequest(app, "POST", "/doc-model/artifacts/docart:rams:x/comments", {
      actor: "chris",
      body: "hello",
    });
    expect(unauthored.status).toBe(404);
  });
});
