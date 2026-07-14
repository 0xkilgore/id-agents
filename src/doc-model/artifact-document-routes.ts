// Doc-model substrate slice 1 — read/write surface for artifact documents.
//
// GET returns the projection replayed purely from doc_model_document_op; it
// never touches the filesystem. POST .../comments appends a comment op and
// the next GET reflects it — the minimal loop the console needs to stop
// grepping markdown-on-disk for artifact content.

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { appendArtifactComment, projectArtifactDocument } from "./artifact-document.js";

function documentIdParam(req: Request): string {
  const raw = req.params.document_id;
  return Array.isArray(raw) ? raw[0] ?? "" : raw;
}

export function mountArtifactDocumentRoutes(app: Application, adapter: DbAdapter): void {
  app.get("/doc-model/artifacts/:document_id", async (req: Request, res: Response) => {
    try {
      const documentId = documentIdParam(req);
      const projection = await projectArtifactDocument(adapter, documentId);
      if (!projection) {
        res.status(404).json({ ok: false, error: `unknown doc-model document: ${documentId}` });
        return;
      }
      res.json({ ok: true, document: projection });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/doc-model/artifacts/:document_id/comments", async (req: Request, res: Response) => {
    try {
      const documentId = documentIdParam(req);
      const body = req.body ?? {};
      const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : null;
      const text = typeof body.body === "string" && body.body.trim() ? body.body.trim() : null;
      if (!actor || !text) {
        res.status(400).json({ ok: false, error: "actor and body are required" });
        return;
      }
      await appendArtifactComment(adapter, { documentId, actor, body: text });
      const projection = await projectArtifactDocument(adapter, documentId);
      res.json({ ok: true, document: projection });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("unknown doc-model document")) {
        res.status(404).json({ ok: false, error: err.message });
        return;
      }
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
