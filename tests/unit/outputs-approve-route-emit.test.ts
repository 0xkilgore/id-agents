// Kapelle P3 (2026-06-09) — route integration test for the
// manager-side approval emit target. Boots a tiny express app with the
// outputs routes mounted + the tasks repo + team resolver injected,
// then POSTs to /artifacts/:id/approve and asserts that the response
// carries the structured task.
//
// Smoke command in the closeout shows the same call via curl.

import express, { type Express } from "express";
import { describe, it, expect } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteTasksRepo } from "../../src/db/repos/sqlite/tasks-repo.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import { parseApprovalPayload } from "../../src/outputs/approval-emit.js";

async function bootApp(opts: { withEmit: boolean }) {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  const tasks = new SqliteTasksRepo(adapter);
  const teamsRepo = new SqliteTeamsRepo(adapter);
  const teamId = await teamsRepo.getOrCreateTeamId("default");
  const app = express();
  app.use(express.json());
  mountOutputsRoutes(
    app,
    adapter,
    opts.withEmit ? { tasks, resolveTeamId: async () => teamId } : {},
  );
  return { app, adapter, tasks, teamId };
}

function request(app: Express) {
  return {
    async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            server.close();
            reject(new Error("no address"));
            return;
          }
          try {
            const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const text = await r.text();
            let parsed: any;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
            server.close(() => resolve({ status: r.status, body: parsed }));
          } catch (e) {
            server.close(() => reject(e));
          }
        });
      });
    },
  };
}

describe("Kapelle P3 — POST /artifacts/:id/approve emits a manager task", () => {
  it("returns 200 with the created task + idempotent: false on first approve", async () => {
    const { app, teamId } = await bootApp({ withEmit: true });
    const artifactId = "art:regina:digest.md";
    const res = await request(app).post(`/artifacts/${artifactId}/approve`, {
      approver: "human:chris",
      note: "ship it",
      source_surface: "/ops/artifacts/art:regina:digest.md",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.task_emitted).toBe(true);
    expect(res.body.task_idempotent).toBe(false);
    expect(res.body.receipt).toMatchObject({
      approval: { state: "approved", label: "Approved", op_id: res.body.op_id, idempotent: false },
      comment: { state: "skipped", label: "No approval comment", op_id: null },
      task: { state: "queued", label: "Approval task queued" },
    });
    expect(res.body.receipt.task.task_id).toBe(res.body.task.id);
    expect(res.body.task).toBeTruthy();
    expect(res.body.task.name).toMatch(/^artifact-approval-[a-f0-9]{12}$/);
    expect(res.body.task.team_id).toBe(teamId);
    expect(res.body.task.status).toBe("todo");
    const payload = parseApprovalPayload(res.body.task.description ?? "");
    expect(payload?.artifact_id).toBe(artifactId);
    expect(payload?.reviewer.id).toBe("chris");
    expect(payload?.reviewer.kind).toBe("human");
    expect(payload?.source_surface).toBe("/ops/artifacts/art:regina:digest.md");
    expect(payload?.approval_state).toBe("approved");
  });

  it("returns a legible receipt when approve includes a comment", async () => {
    const { app } = await bootApp({ withEmit: true });
    const artifactId = "art:regina:commented.md";
    const res = await request(app).post(`/artifacts/${artifactId}/approve`, {
      approver: "human:liz",
      comment: "Approved with the typo fix noted.",
      source_surface: "/ops/artifacts/art:regina:commented.md",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.comment.body).toBe("Approved with the typo fix noted.");
    expect(res.body.receipt).toMatchObject({
      approval: { state: "approved", label: "Approved", op_id: res.body.op_id, idempotent: false },
      comment: { state: "applied", label: "Comment applied", op_id: res.body.comment_op_id },
      task: { state: "queued", label: "Approval task queued", task_id: res.body.task.id },
    });
  });

  it("returns task_idempotent: true on a second approve of the same artifact", async () => {
    const { app } = await bootApp({ withEmit: true });
    const artifactId = "art:regina:digest.md";
    const a = await request(app).post(`/artifacts/${artifactId}/approve`, {
      approver: "human:chris",
      source_surface: "/ops",
    });
    expect(a.body.task_idempotent).toBe(false);
    const b = await request(app).post(`/artifacts/${artifactId}/approve`, {
      approver: "human:chris",
      source_surface: "/ops",
    });
    expect(b.status).toBe(200);
    expect(b.body.task_idempotent).toBe(true);
    expect(b.body.task.id).toBe(a.body.task.id);
  });

  it("returns task_emit_skipped when no tasks seam is wired (legacy mount)", async () => {
    const { app } = await bootApp({ withEmit: false });
    const res = await request(app).post(`/artifacts/art:x:y.md/approve`, {
      approver: "human:chris",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.task).toBeNull();
    expect(res.body.task_emitted).toBe(false);
    expect(res.body.task_emit_skipped).toBe("manager_emit_target_not_configured");
  });

  it("surfaces task_emit_error with retry_with when the team resolver throws", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateOutputsTables(adapter);
    const tasks = new SqliteTasksRepo(adapter);
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, {
      tasks,
      resolveTeamId: async () => {
        throw new Error("team lookup down");
      },
    });

    const res = await request(app).post(`/artifacts/art:x:y.md/approve`, {
      approver: "human:chris",
      source_surface: "/ops",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.task_emitted).toBe(false);
    expect(res.body.task_emit_error.kind).toBe("team_resolution");
    expect(res.body.task_emit_error.message).toContain("team lookup down");
    expect(res.body.task_emit_error.retry_with.url).toBe("/artifacts/art:x:y.md/approve");
    expect(res.body.task_emit_error.retry_with.body.approver).toBe("human:chris");
  });
});
