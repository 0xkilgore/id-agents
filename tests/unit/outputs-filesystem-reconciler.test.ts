import express, { type Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  artifactIdFromPath,
  getArtifact,
  getArtifactBodyCache,
  listArtifactSourceEvidence,
  listInboxItems,
  migrateOutputsTables,
  registerArtifact,
} from "../../src/outputs/storage.js";
import {
  reconcileFilesystemArtifacts,
  validateConsoleArtifactRelativePath,
} from "../../src/outputs/filesystem-reconciler.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";

const tmpRoots: string[] = [];

async function setup() {
  const adapter = new SqliteAdapter(":memory:");
  await migrateOutputsTables(adapter);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "id-agents-fs-artifacts-"));
  tmpRoots.push(workDir);
  return { adapter, workDir };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeArtifact(workDir: string, relPath: string, content = "# draft\n") {
  const abs = path.join(workDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function request(app: Express) {
  return {
    async get(urlPath: string): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          try {
            const response = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`);
            const body = await response.json();
            server.close(() => resolve({ status: response.status, body }));
          } catch (err) {
            server.close(() => reject(err));
          }
        });
      });
    },
    async getRaw(urlPath: string): Promise<{ status: number; text: string; headers: Headers }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          try {
            const response = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`);
            const text = await response.text();
            server.close(() => resolve({ status: response.status, text, headers: response.headers }));
          } catch (err) {
            server.close(() => reject(err));
          }
        });
      });
    },
  };
}

describe("filesystem artifact reconciler", () => {
  it("surfaces disk-only Cleveland Park drafts as never_viewed catalog artifacts", async () => {
    const { adapter, workDir } = await setup();
    const abs = writeArtifact(
      workDir,
      "output/cleveland-park/drafts/2026-06-16-dez-crane-parks-alcohol-application-email.md",
      "Draft email",
    );

    const result = await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "cto", workingDirectory: workDir }],
      now: () => new Date("2026-06-16T18:00:00.000Z"),
    });

    expect(result.inserted).toBe(1);
    const item = (await listInboxItems(adapter, { includeNeverViewed: true }, 20, 0))[0];
    expect(item.artifact_id).toBe(artifactIdFromPath(abs));
    expect(item.status).toBe("never_viewed");
    expect(item.agent).toBe("cto");
    expect(item.tag).toBe("output");
    expect(item.basename).toBe("2026-06-16-dez-crane-parks-alcohol-application-email.md");
    expect(item.availability).toBe("present");
  });

  it("preserves /agent-done provenance while recording filesystem evidence separately", async () => {
    const { adapter, workDir } = await setup();
    const abs = writeArtifact(workDir, "output/report.md", "report");
    await registerArtifact(adapter, {
      basename: "report.md",
      agent: "cto",
      abs_path: abs,
      produced_at: "2026-06-16T17:00:00.000Z",
      source: "agent-done",
    }, "2026-06-16T17:00:00.000Z");

    await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "cto", workingDirectory: workDir }],
      now: () => new Date("2026-06-16T18:00:00.000Z"),
    });

    const row = await getArtifact(adapter, artifactIdFromPath(abs));
    expect(row?.source).toBe("agent-done");
    const evidence = await listArtifactSourceEvidence(adapter, artifactIdFromPath(abs));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source).toBe("filesystem");
    expect(evidence[0].source_ref).toBe(`filesystem:${abs}`);
    expect(evidence[0].metadata_json).toContain('"catalog_source_before":"agent-done"');
    expect(evidence[0].metadata_json).toContain('"content_hash"');
  });

  it("backfills the two finance outputs with cached bodies for stable detail/copy/download after source loss", async () => {
    const { adapter, workDir: tmpRoot } = await setup();
    const financesDir = path.join(tmpRoot, "Code", "finances");
    const htmlPath = writeArtifact(
      financesDir,
      "output/2026-07-08-coming-month-cash-flow-preview.html",
      "<h1>Coming Month Cash-Flow Preview</h1><p>Readable without Dropbox sync.</p>",
    );
    const mdPath = writeArtifact(
      financesDir,
      "output/2026-07-08-cash-flow-cobra-boxx-addendum.md",
      "# Cash-Flow Preview Correction Addendum\n\nCOBRA + BOXX LT Lots detail.\n",
    );

    const result = await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "finances", workingDirectory: financesDir }],
      now: () => new Date("2026-07-08T13:00:00.000Z"),
    });

    expect(result.inserted).toBe(2);
    const htmlId = artifactIdFromPath(htmlPath);
    const mdId = artifactIdFromPath(mdPath);
    expect(await getArtifact(adapter, htmlId)).toMatchObject({
      artifact_id: htmlId,
      title: "Coming Month Cash-Flow Preview",
      agent: "finances",
      tag: "output",
      source: "filesystem",
      media_type: "text/html",
      project_ref: "finances",
      availability: "present",
    });
    expect(await getArtifact(adapter, mdId)).toMatchObject({
      artifact_id: mdId,
      title: "Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots",
      media_type: "text/markdown",
      project_ref: "finances",
    });
    expect((await getArtifact(adapter, htmlId))?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await getArtifact(adapter, mdId))?.source_mtime).toBeTruthy();
    expect(await getArtifactBodyCache(adapter, htmlId)).toMatchObject({
      artifact_id: htmlId,
      media_type: "text/html",
      body_error: null,
    });
    expect(await getArtifactBodyCache(adapter, mdId)).toMatchObject({
      artifact_id: mdId,
      media_type: "text/markdown",
      body_error: null,
    });

    fs.unlinkSync(htmlPath);
    fs.unlinkSync(mdPath);
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, { autoIngest: false });
    const client = request(app);

    const htmlDetail = await client.get(`/artifacts/${htmlId}/detail`);
    expect(htmlDetail.status).toBe(200);
    expect(htmlDetail.body).toMatchObject({
      artifact_id: htmlId,
      displayTitle: "Coming Month Cash-Flow Preview",
      stableUrl: `/artifacts/${htmlId}/detail`,
      copyTextUrl: `/artifacts/${htmlId}/copy-text`,
      downloadUrl: `/artifacts/${htmlId}/download`,
      metadata: {
        abs_path: htmlPath,
        media_type: "text/html",
        project_ref: "finances",
        source: "filesystem",
      },
      body: {
        kind: "html",
        source: "artifact_body_cache",
      },
      delivery: {
        sourcePath: htmlPath,
        bodyRenderable: true,
        bodyUnavailable: false,
        discoveredBy: "filesystem_reconcile",
        freshness: "current",
      },
    });
    expect(htmlDetail.body.body.text).toContain("Readable without Dropbox sync.");

    const mdDetail = await client.get(`/artifacts/${mdId}/detail`);
    expect(mdDetail.status).toBe(200);
    expect(mdDetail.body).toMatchObject({
      displayTitle: "Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots",
      body: { kind: "markdown", source: "artifact_body_cache" },
      delivery: { bodyRenderable: true, discoveredBy: "filesystem_reconcile" },
    });
    expect(mdDetail.body.body.text).toContain("COBRA + BOXX LT Lots detail.");

    const copy = await client.getRaw(`/artifacts/${mdId}/copy-text`);
    expect(copy.status).toBe(200);
    expect(copy.text).toContain("COBRA + BOXX LT Lots detail.");

    const download = await client.getRaw(`/artifacts/${htmlId}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("2026-07-08-coming-month-cash-flow-preview.html");
    expect(download.text).toContain("Coming Month Cash-Flow Preview");

    const htmlEvidence = await listArtifactSourceEvidence(adapter, htmlId);
    expect(htmlEvidence[0]).toMatchObject({
      source: "filesystem",
      source_ref: `filesystem:${htmlPath}`,
    });
    expect(htmlEvidence[0].metadata_json).toContain('"content_hash"');
  });

  it("supports startup-style full reconciliation and opportunistic /outputs/inbox recent reconciliation", async () => {
    const { adapter, workDir } = await setup();
    const oldAbs = writeArtifact(workDir, "reports/old-brief.md", "old");
    const oldTime = new Date("2026-06-15T12:00:00.000Z");
    fs.utimesSync(oldAbs, oldTime, oldTime);

    await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "cto", workingDirectory: workDir }],
      now: () => new Date("2026-06-16T18:00:00.000Z"),
    });
    expect(await getArtifact(adapter, artifactIdFromPath(oldAbs))).toMatchObject({
      source: "filesystem",
      tag: "reports",
    });

    const freshAbs = writeArtifact(workDir, "drafts/fresh-brief.md", "fresh");
    // The /outputs/inbox opportunistic reconcile uses a real-clock recent window
    // (Date.now() - filesystemReconcileRecentMs), so the "fresh" file must be
    // genuinely recent relative to wall-clock — a fixed past timestamp would fall
    // outside the window whenever the suite runs later than it.
    const freshTime = new Date();
    fs.utimesSync(freshAbs, freshTime, freshTime);
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, {
      filesystemArtifactRoots: async () => [{ agent: "cto", workingDirectory: workDir }],
      filesystemReconcileRecentMs: 60 * 60 * 1000,
    });

    const res = await request(app).get("/outputs/inbox?limit=20");
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: any) => item.abs_path)).toContain(freshAbs);
  });

  it("uses the substrate catalog for /outputs/inbox under ARTIFACTS_USE_DOCUMENT_MODEL", async () => {
    const { adapter, workDir } = await setup();
    const catalogAbs = path.join(workDir, "output/cataloged.md");
    const freshAbs = writeArtifact(workDir, "output/fresh-disk-only.md", "fresh");
    const now = "2026-06-26T01:00:00.000Z";

    await registerArtifact(adapter, {
      basename: "cataloged.md",
      agent: "cto",
      tag: "output",
      abs_path: catalogAbs,
      title: "Cataloged",
      produced_at: now,
      source: "agent-done",
    }, now);

    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, {
      filesystemArtifactRoots: async () => [{ agent: "cto", workingDirectory: workDir }],
      filesystemReconcileRecentMs: 60 * 60 * 1000,
      env: { ARTIFACTS_USE_DOCUMENT_MODEL: "true" },
    });

    const entries = await request(app).get("/artifacts/entries?limit=20");
    const inbox = await request(app).get("/outputs/inbox?limit=20");

    expect(entries.status).toBe(200);
    expect(inbox.status).toBe(200);
    expect(entries.body.source).toEqual({ read_path: "substrate", projection: "artifact_entries" });
    expect(inbox.body.items.map((item: any) => item.artifact_id)).toEqual(
      entries.body.items.map((item: any) => item.phid),
    );
    expect(inbox.body.items.map((item: any) => item.abs_path)).toEqual([catalogAbs]);
    expect(inbox.body.items.map((item: any) => item.abs_path)).not.toContain(freshAbs);
    expect(await getArtifact(adapter, artifactIdFromPath(freshAbs))).toBeNull();
  });

  it("keeps console path safety and skips symlink escapes", async () => {
    const { adapter, workDir } = await setup();
    expect(validateConsoleArtifactRelativePath("../secrets.txt")).toEqual({
      ok: false,
      error: "Invalid path: directory traversal not allowed",
    });
    expect(validateConsoleArtifactRelativePath("/etc/passwd")).toEqual({
      ok: false,
      error: "Invalid path: directory traversal not allowed",
    });
    expect(validateConsoleArtifactRelativePath("nested/report.md")).toEqual({ ok: true });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "id-agents-outside-"));
    tmpRoots.push(outside);
    const outsideFile = path.join(outside, "secret.md");
    fs.writeFileSync(outsideFile, "secret");
    fs.mkdirSync(path.join(workDir, "output"), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(workDir, "output", "linked-secret.md"));

    const result = await reconcileFilesystemArtifacts(adapter, {
      roots: [
        { agent: "cto", workingDirectory: workDir, roots: ["output", "../outside"] },
      ],
    });
    expect(result.inserted).toBe(0);
    expect(await getArtifact(adapter, artifactIdFromPath(outsideFile))).toBeNull();
  });
});
