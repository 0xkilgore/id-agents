import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchArtifactComments,
  fetchArtifactDesk,
  postArtifactComment,
} from "../../src/tui/api/manager.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tui artifact desk client", () => {
  it("preserves duplicate surfaced artifact rows for the desk to render independently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {
      ok: true,
      schema_version: "surfaced-artifacts.v1",
      count: 2,
      rows: [
        { id: "artifact:dup", title: "First", status: "unread" },
        { id: "artifact:dup", title: "Second", status: "commented" },
      ],
    })));

    const desk = await fetchArtifactDesk("http://manager", new AbortController().signal);

    expect(desk.rows).toHaveLength(2);
    expect(desk.rows.map((row) => row.title)).toEqual(["First", "Second"]);
  });

  it("maps missing comment threads to an empty state instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { ok: false, error: "missing" })));

    const comments = await fetchArtifactComments("http://manager", "artifact-missing", new AbortController().signal);

    expect(comments).toMatchObject({
      ok: false,
      artifact_id: "artifact-missing",
      comments: [],
      count: 0,
    });
  });

  it("returns failed comment receipts so the review box can keep the console usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {
      ok: false,
      code: "route_failed",
      error: "dispatch enqueue failed",
    })));

    const receipt = await postArtifactComment("http://manager", "artifact-one", "please revise");

    expect(receipt).toMatchObject({
      ok: false,
      status: "failed",
      code: "route_failed",
      error: "dispatch enqueue failed",
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status >= 500 ? "Server Error" : "OK",
    json: async () => body,
  } as Response;
}
