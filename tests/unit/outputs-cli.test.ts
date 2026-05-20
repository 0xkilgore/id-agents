// Tests for the `id-agents outputs <agent>` CLI subcommand.
// Spec 102 §6 / Build plan step 8.

import { describe, it, expect } from "vitest";
import {
  parseOutputsArgs,
  buildListUrl,
  buildHistoryUrl,
  buildViewUrl,
  runOutputs,
  OutputsArgError,
  type OutputsArgs,
  type OutputsDeps,
} from "../../src/cli/outputs.js";

function captureDeps(overrides: Partial<OutputsDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: OutputsDeps = {
    baseUrl: "http://localhost:3000",
    fetchJson: async () => ({ ok: false, status: 0, error: "not mocked" }),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    noColor: true,
    ...overrides,
  };
  return { deps, out, err };
}

describe("parseOutputsArgs", () => {
  it("requires an agent name", () => {
    expect(() => parseOutputsArgs([])).toThrow(OutputsArgError);
  });

  it("parses minimal `<agent>`", () => {
    const r = parseOutputsArgs(["personal"]);
    expect(r.agent).toBe("personal");
    expect(r.limit).toBe(25);
    expect(r.page).toBe(1);
    expect(r.json).toBe(false);
    expect(r.open).toBeNull();
  });

  it("parses --json flag", () => {
    expect(parseOutputsArgs(["personal", "--json"]).json).toBe(true);
  });

  it("parses --limit / --page / --kind / --tag", () => {
    const r = parseOutputsArgs([
      "personal",
      "--limit", "10",
      "--page", "3",
      "--kind", "ANALYSIS",
      "--tag", "montreal",
    ]);
    expect(r.limit).toBe(10);
    expect(r.page).toBe(3);
    expect(r.kind).toBe("ANALYSIS");
    expect(r.tag).toBe("montreal");
  });

  it("validates --since requires ISO with offset", () => {
    expect(() => parseOutputsArgs(["personal", "--since", "2026-01-01"])).toThrow(/since must be ISO/);
    expect(parseOutputsArgs(["personal", "--since", "2026-05-19T00:00:00Z"]).since).toBe("2026-05-19T00:00:00Z");
    expect(parseOutputsArgs(["personal", "--since", "2026-05-19T00:00:00-05:00"]).since).toBe("2026-05-19T00:00:00-05:00");
  });

  it("validates --limit range", () => {
    expect(() => parseOutputsArgs(["personal", "--limit", "0"])).toThrow(/limit/);
    expect(() => parseOutputsArgs(["personal", "--limit", "101"])).toThrow(/limit/);
    expect(() => parseOutputsArgs(["personal", "--limit", "foo"])).toThrow(/limit/);
  });

  it("parses --open <phid>", () => {
    const r = parseOutputsArgs(["personal", "--open", "phid:abc"]);
    expect(r.open).toBe("phid:abc");
  });

  it("rejects unknown flags", () => {
    expect(() => parseOutputsArgs(["personal", "--banana"])).toThrow(/unknown flag/);
  });

  it("rejects extra positionals", () => {
    expect(() => parseOutputsArgs(["personal", "extra"])).toThrow(/unexpected positional/);
  });
});

describe("URL builders", () => {
  const args: OutputsArgs = {
    agent: "personal",
    limit: 25,
    page: 1,
    kind: null,
    tag: null,
    since: null,
    json: false,
    open: null,
  };

  it("buildListUrl includes author/limit/page", () => {
    const url = new URL(buildListUrl("http://localhost:3000", args));
    expect(url.pathname).toBe("/api/artifacts/by-author");
    expect(url.searchParams.get("author")).toBe("personal");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("buildListUrl threads kind + since", () => {
    const url = new URL(
      buildListUrl("http://localhost:3000", {
        ...args,
        kind: "ANALYSIS",
        since: "2026-05-19T00:00:00Z",
      }),
    );
    expect(url.searchParams.get("kind")).toBe("ANALYSIS");
    expect(url.searchParams.get("since")).toBe("2026-05-19T00:00:00Z");
  });

  it("buildHistoryUrl encodes comma-separated ids", () => {
    const url = new URL(buildHistoryUrl("http://localhost:3000", ["phid:a", "phid:b"]));
    expect(url.searchParams.get("ids")).toBe("phid:a,phid:b");
  });

  it("buildViewUrl URL-encodes the phid", () => {
    expect(buildViewUrl("http://localhost:3000", "phid:abc")).toContain("/api/artifacts/phid%3Aabc");
  });
});

describe("runOutputs — list mode", () => {
  it("prints `<agent> outputs` header and one row per artifact", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/by-author")) {
          return {
            ok: true,
            value: {
              artifacts: [
                {
                  artifact_phid: "phid:a",
                  slug: "s",
                  title: "First",
                  summary: "One liner",
                  body_excerpt: null,
                  kind: "ANALYSIS",
                  status: "FINAL",
                  author: "personal",
                  author_kind: "AGENT",
                  tags: ["montreal"],
                  created_at: "",
                  updated_at: "",
                  finalized_at: null,
                  archived_at: null,
                  superseded_by: null,
                },
              ],
              page: 1,
              limit: 25,
              total: 1,
              has_next: false,
            },
          };
        }
        if (url.includes("/last-edited")) {
          return {
            ok: true,
            value: {
              history: {
                "phid:a": {
                  doc_id: "phid:a",
                  op_index: 0,
                  op_type: "REGISTER_ARTIFACT",
                  actor: { kind: "agent", id: "personal", label: "personal", source: "manager" },
                  timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
                  payload_summary: null,
                  scope: "metadata",
                },
              },
            },
          };
        }
        return { ok: false, status: 0, error: "unexpected" };
      },
    });
    const args = parseOutputsArgs(["personal"]);
    const code = await runOutputs(args, deps);
    expect(code).toBe(0);
    const joined = out.join("");
    expect(joined).toContain("personal outputs");
    expect(joined).toContain("First");
    expect(joined).toContain("One liner");
    expect(joined).toContain("phid:a");
    expect(joined).toContain("[ANALYSIS]");
    expect(joined).toContain("by personal");
  });

  it("emits parseable JSON with --json", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/by-author")) {
          return {
            ok: true,
            value: {
              artifacts: [
                {
                  artifact_phid: "phid:a",
                  slug: "s",
                  title: "T",
                  summary: null,
                  body_excerpt: null,
                  kind: "ANALYSIS",
                  status: "FINAL",
                  author: "cto",
                  author_kind: "AGENT",
                  tags: [],
                  created_at: "",
                  updated_at: "",
                  finalized_at: null,
                  archived_at: null,
                  superseded_by: null,
                },
              ],
              page: 1,
              limit: 25,
              total: 1,
              has_next: false,
            },
          };
        }
        return { ok: true, value: { history: {} } };
      },
    });
    const args = parseOutputsArgs(["cto", "--json"]);
    const code = await runOutputs(args, deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].artifact_phid).toBe("phid:a");
    expect(parsed.page).toBe(1);
    expect(parsed.has_next).toBe(false);
  });

  it("falls back to 'last edited unknown · by unknown' when history is missing", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/by-author")) {
          return {
            ok: true,
            value: {
              artifacts: [{
                artifact_phid: "phid:none", slug: "n", title: "N",
                summary: null, body_excerpt: null, kind: "PLAN", status: "DRAFT",
                author: "cto", author_kind: "AGENT", tags: [],
                created_at: "", updated_at: "", finalized_at: null, archived_at: null, superseded_by: null,
              }],
              page: 1, limit: 25, total: 1, has_next: false,
            },
          };
        }
        return { ok: true, value: { history: {} } };
      },
    });
    const args = parseOutputsArgs(["cto"]);
    await runOutputs(args, deps);
    expect(out.join("")).toContain("last edited unknown · by unknown");
  });

  it("non-zero exit + stderr message when list fetch fails", async () => {
    const { deps, err } = captureDeps({
      fetchJson: async () => ({ ok: false, status: 502, error: "reactor unreachable" }),
    });
    const code = await runOutputs(parseOutputsArgs(["cto"]), deps);
    expect(code).toBe(1);
    expect(err.join("")).toContain("reactor unreachable");
  });

  it("--tag filter narrows to matching tag (client-side v1)", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/by-author")) {
          return {
            ok: true,
            value: {
              artifacts: [
                {
                  artifact_phid: "phid:a", slug: "a", title: "A",
                  summary: null, body_excerpt: null, kind: "ANALYSIS", status: "FINAL",
                  author: "personal", author_kind: "AGENT", tags: ["montreal"],
                  created_at: "", updated_at: "", finalized_at: null, archived_at: null, superseded_by: null,
                },
                {
                  artifact_phid: "phid:b", slug: "b", title: "B",
                  summary: null, body_excerpt: null, kind: "ANALYSIS", status: "FINAL",
                  author: "personal", author_kind: "AGENT", tags: ["other"],
                  created_at: "", updated_at: "", finalized_at: null, archived_at: null, superseded_by: null,
                },
              ],
              page: 1, limit: 25, total: 2, has_next: false,
            },
          };
        }
        return { ok: true, value: { history: {} } };
      },
    });
    await runOutputs(parseOutputsArgs(["personal", "--tag", "montreal"]), deps);
    const joined = out.join("");
    expect(joined).toContain("phid:a");
    expect(joined).not.toContain("phid:b");
  });
});

describe("runOutputs — --open mode", () => {
  it("prints title, last-edited line, kind/tags/status, body", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/api/artifacts/last-edited")) {
          return {
            ok: true,
            value: {
              history: {
                "phid:open": {
                  doc_id: "phid:open",
                  op_index: 0,
                  op_type: "REGISTER_ARTIFACT",
                  actor: { kind: "agent", id: "cto", label: "cto", source: "manager" },
                  timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
                  payload_summary: null,
                  scope: "metadata",
                },
              },
            },
          };
        }
        if (url.includes("/api/artifacts/")) {
          return {
            ok: true,
            value: {
              artifact: {
                artifact_phid: "phid:open",
                slug: "open",
                title: "Opened Artifact",
                body_markdown: "# Hello\n\nBody.",
                summary: null,
                body_excerpt: null,
                kind: "ANALYSIS",
                status: "FINAL",
                author: "cto",
                author_kind: "AGENT",
                tags: ["spec"],
                created_at: "",
                updated_at: "",
                finalized_at: null,
                archived_at: null,
                superseded_by: null,
              },
            },
          };
        }
        return { ok: false, status: 0, error: "unexpected" };
      },
    });
    const args = parseOutputsArgs(["cto", "--open", "phid:open"]);
    const code = await runOutputs(args, deps);
    expect(code).toBe(0);
    const joined = out.join("");
    expect(joined).toContain("Opened Artifact");
    expect(joined).toContain("by cto");
    expect(joined).toContain("kind: ANALYSIS");
    expect(joined).toContain("tags: spec");
    expect(joined).toContain("status: FINAL");
    expect(joined).toContain("# Hello");
  });

  it("returns exit code 2 when the artifact is 404", async () => {
    const { deps, err } = captureDeps({
      fetchJson: async () => ({ ok: false, status: 404, error: "not found" }),
    });
    const code = await runOutputs(parseOutputsArgs(["cto", "--open", "phid:missing"]), deps);
    expect(code).toBe(2);
    expect(err.join("")).toContain("not found");
  });

  it("--json --open emits the artifact + history JSON", async () => {
    const { deps, out } = captureDeps({
      fetchJson: async (url) => {
        if (url.includes("/api/artifacts/last-edited")) {
          return { ok: true, value: { history: {} } };
        }
        return {
          ok: true,
          value: {
            artifact: {
              artifact_phid: "phid:open",
              slug: "open",
              title: "Open",
              body_markdown: "# Body",
              summary: null,
              body_excerpt: null,
              kind: "PLAN",
              status: "DRAFT",
              author: "cto",
              author_kind: "AGENT",
              tags: [],
              created_at: "",
              updated_at: "",
              finalized_at: null,
              archived_at: null,
              superseded_by: null,
            },
          },
        };
      },
    });
    const code = await runOutputs(parseOutputsArgs(["cto", "--open", "phid:open", "--json"]), deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.artifact.title).toBe("Open");
    expect(parsed.history).toBeNull();
  });
});
