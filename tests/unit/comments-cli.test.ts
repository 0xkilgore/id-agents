// Tests for `id-agents comments <agent>` (Build plan step 8) and the
// pollUnreadArtifactCommentsForSelf SDK helper.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseCommentsArgs,
  buildUnreadUrl,
  buildAckUrl,
  runComments,
  pollUnreadArtifactCommentsForSelf,
  CommentsArgError,
  type CommentsArgs,
  type CommentsDeps,
  type CliArtifactCommentSummary,
} from "../../src/cli/comments.js";

function captureDeps(overrides: Partial<CommentsDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CommentsDeps = {
    baseUrl: "http://localhost:3000",
    fetchJson: async () => ({ ok: false, status: 0, error: "not mocked" }),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    noColor: true,
    ...overrides,
  };
  return { deps, out, err };
}

function sampleSummary(
  overrides: Partial<CliArtifactCommentSummary> = {},
): CliArtifactCommentSummary {
  return {
    artifact_phid: "phid:art-1",
    slug: "spec",
    title: "Spec review",
    author_agent_id: "rams",
    comment_id: "comment_x",
    comment_op_id: "op_x",
    actor: { type: "human", id: "chris", displayName: "Chris" },
    body_excerpt: "Looks good — one nit.",
    anchor_json: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    read_by_author_at: null,
    addressed_at: null,
    ...overrides,
  };
}

describe("parseCommentsArgs", () => {
  it("requires an agent name", () => {
    expect(() => parseCommentsArgs([])).toThrow(CommentsArgError);
  });

  it("parses minimal `<agent>`", () => {
    const r = parseCommentsArgs(["rams"]);
    expect(r.agent).toBe("rams");
    expect(r.limit).toBe(100);
    expect(r.json).toBe(false);
    expect(r.ack).toBeNull();
  });

  it("parses --limit, --json", () => {
    const r = parseCommentsArgs(["rams", "--limit", "20", "--json"]);
    expect(r.limit).toBe(20);
    expect(r.json).toBe(true);
  });

  it("validates --limit range", () => {
    expect(() => parseCommentsArgs(["rams", "--limit", "0"])).toThrow(/limit/);
    expect(() => parseCommentsArgs(["rams", "--limit", "101"])).toThrow(/limit/);
  });

  it("parses --ack <artifact> <comment>", () => {
    const r = parseCommentsArgs(["rams", "--ack", "phid:art-1", "comment_x"]);
    expect(r.ack).toEqual({
      artifactPhid: "phid:art-1",
      commentId: "comment_x",
    });
  });

  it("rejects --ack without both args", () => {
    expect(() => parseCommentsArgs(["rams", "--ack", "phid:art-1"])).toThrow();
  });

  it("rejects unknown flags", () => {
    expect(() => parseCommentsArgs(["rams", "--banana"])).toThrow(/unknown flag/);
  });
});

describe("buildUnreadUrl + buildAckUrl", () => {
  it("buildUnreadUrl includes agent path + limit", () => {
    const args: CommentsArgs = { agent: "rams", limit: 50, json: false, ack: null };
    const url = buildUnreadUrl("http://localhost:3000", args);
    expect(url).toBe(
      "http://localhost:3000/api/agents/rams/artifact-comments/unread?limit=50",
    );
  });

  it("buildAckUrl includes both ids encoded", () => {
    expect(buildAckUrl("http://localhost:3000", "phid:art-1", "comment_x")).toBe(
      "http://localhost:3000/api/artifacts/phid%3Aart-1/comments/comment_x/ack",
    );
  });
});

describe("runComments — list mode", () => {
  it("prints empty-state when no comments", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async () => ({ ok: true, value: { comments: [] } }),
    });
    const code = await runComments(
      { agent: "rams", limit: 100, json: false, ack: null },
      deps,
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("(no unread artifact comments)");
  });

  it("--json emits parseable JSON without ANSI", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async () => ({
        ok: true,
        value: { comments: [sampleSummary()] },
      }),
    });
    await runComments(
      { agent: "rams", limit: 100, json: true, ack: null },
      deps,
    );
    const parsed = JSON.parse(out.join(""));
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].comment_id).toBe("comment_x");
    expect(out.join("")).not.toContain("\x1b[");
  });

  it("returns non-zero on reactor unreachable", async () => {
    const { deps, err } = captureDeps({
      fetchJson: async () => ({ ok: false, status: 502, error: "reactor unreachable" }),
    });
    const code = await runComments(
      { agent: "rams", limit: 100, json: false, ack: null },
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("reactor unreachable");
  });
});

describe("runComments — ack mode", () => {
  it("POSTs to /ack and reports the acked id", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { deps, out } = captureDeps({
      fetchJson: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          value: { comment: { comment_id: "comment_x" } },
        };
      },
    });
    const code = await runComments(
      {
        agent: "rams",
        limit: 100,
        json: false,
        ack: { artifactPhid: "phid:art-1", commentId: "comment_x" },
      },
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0].url).toContain("/api/artifacts/phid%3Aart-1/comments/comment_x/ack");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ agentId: "rams" });
    expect(out.join("")).toContain("acked comment_x");
  });

  it("returns 1 when ack fails", async () => {
    const { deps, err } = captureDeps({
      fetchJson: async () => ({ ok: false, status: 500, error: "ack failed" }),
    });
    const code = await runComments(
      {
        agent: "rams",
        limit: 100,
        json: false,
        ack: { artifactPhid: "phid:art-1", commentId: "comment_x" },
      },
      deps,
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("ack failed");
  });
});

describe("pollUnreadArtifactCommentsForSelf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_NAME;
  });

  it("throws clear error when no agent id is available", async () => {
    await expect(pollUnreadArtifactCommentsForSelf()).rejects.toThrow(/agentId/);
  });

  it("derives agentId from AGENT_NAME env", async () => {
    process.env.AGENT_NAME = "rams";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ comments: [sampleSummary()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await pollUnreadArtifactCommentsForSelf();
    expect(result).toHaveLength(1);
    expect(result[0].comment_id).toBe("comment_x");
  });
});
