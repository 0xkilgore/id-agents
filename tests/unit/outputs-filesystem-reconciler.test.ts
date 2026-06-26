import express, { type Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  artifactIdFromPath,
  getArtifact,
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
