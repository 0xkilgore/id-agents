import { execFile } from "node:child_process";
import * as http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SMOKE_SCRIPT = path.resolve(__dirname, "../../scripts/orchestration-http-smoke.mjs");

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${addr.port}`;
}

describe("orchestration HTTP smoke", () => {
  it("passes quickly when status and backlog respond", async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === "/orchestration/status" || req.url === "/orchestration/backlog") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, items: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const { stdout } = await execFileAsync(process.execPath, [SMOKE_SCRIPT], {
      env: { ...process.env, MANAGER_URL: baseUrl, ORCHESTRATION_HTTP_SMOKE_TIMEOUT_MS: "200" },
    });

    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.endpoint)).toEqual(["/orchestration/status", "/orchestration/backlog"]);
    expect(lines.every((line) => line.ok === true && typeof line.elapsed_ms === "number")).toBe(true);
  });

  it("fails fast with endpoint, elapsed time, and bounded follow-up when backlog hangs", async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === "/orchestration/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/orchestration/backlog") {
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const startedAt = Date.now();
    await expect(
      execFileAsync(process.execPath, [SMOKE_SCRIPT], {
        env: { ...process.env, MANAGER_URL: baseUrl, ORCHESTRATION_HTTP_SMOKE_TIMEOUT_MS: "75" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("/orchestration/backlog"),
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);

    try {
      await execFileAsync(process.execPath, [SMOKE_SCRIPT], {
        env: { ...process.env, MANAGER_URL: baseUrl, ORCHESTRATION_HTTP_SMOKE_TIMEOUT_MS: "75" },
      });
      throw new Error("expected smoke script to fail");
    } catch (err: any) {
      const failure = JSON.parse(String(err.stderr).trim());
      expect(failure).toMatchObject({
        ok: false,
        endpoint: "/orchestration/backlog",
        status: null,
        suggested_bounded_query_follow_up: expect.stringContaining("/orchestration/backlog?state=needs_review"),
      });
      expect(failure.elapsed_ms).toBeGreaterThanOrEqual(50);
      expect(failure.elapsed_ms).toBeLessThan(1000);
      expect(failure.error).toContain("timed out");
    }
  });
});
