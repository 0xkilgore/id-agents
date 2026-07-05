import { describe, expect, it } from "vitest";
import { extractRegisterIds } from "../../src/continuous-orchestration/register-id-extraction.js";

describe("extractRegisterIds", () => {
  it("extracts an arf: register ID from prose", () => {
    expect(extractRegisterIds("ARF4-01: arf:v4:reader-3col-rebalance is LIVE")).toEqual([
      "arf:v4:reader-3col-rebalance",
    ]);
  });

  it("extracts a t-ckpt: register ID", () => {
    expect(extractRegisterIds("backlog key t-ckpt:ui-needs-attention-inbox-filter")).toEqual([
      "t-ckpt:ui-needs-attention-inbox-filter",
    ]);
  });

  it("extracts a kfb:v3: register ID", () => {
    expect(extractRegisterIds("kfb:v3:artifact-split-layout-right-rail")).toEqual([
      "kfb:v3:artifact-split-layout-right-rail",
    ]);
  });

  it("extracts multiple distinct IDs from the same text", () => {
    const ids = extractRegisterIds("references both arf:v4:reader-3col-rebalance and t-ckpt:ui-comment-box-needs-chips");
    expect(ids).toEqual(["arf:v4:reader-3col-rebalance", "t-ckpt:ui-comment-box-needs-chips"]);
  });

  it("dedupes a repeated ID within the same text", () => {
    const ids = extractRegisterIds("kfb:v3:foo appears twice: kfb:v3:foo");
    expect(ids).toEqual(["kfb:v3:foo"]);
  });

  it("is case-insensitive and normalizes to lowercase", () => {
    expect(extractRegisterIds("ARF:V4:Reader-3Col-Rebalance")).toEqual(["arf:v4:reader-3col-rebalance"]);
  });

  it("excludes this repo's OWN roadmap: scheme (already deduped elsewhere)", () => {
    expect(extractRegisterIds("roadmap:t-orch:some-title")).toEqual([]);
  });

  it("excludes http(s) URLs (same colon-delimited shape as a register ID)", () => {
    expect(extractRegisterIds("see https://example.com/path for context")).toEqual([]);
  });

  it("returns [] for text with no colon-delimited token", () => {
    expect(extractRegisterIds("just a plain title with no id")).toEqual([]);
  });

  it("returns [] for null/undefined/empty text", () => {
    expect(extractRegisterIds(null)).toEqual([]);
    expect(extractRegisterIds(undefined)).toEqual([]);
    expect(extractRegisterIds("")).toEqual([]);
  });
});
