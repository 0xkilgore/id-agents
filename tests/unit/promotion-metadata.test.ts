// Spec 054 v2 Part 2 Step 8 — promotion-metadata pure-function tests.
//
// Covers:
//   - applyPromotionDefaults: build-vs-non-build defaults
//   - isBuildDispatch: detection
//   - validatePromotionMetadata: warn vs enforce branches
//   - parsePromotionEnforcement: env parsing

import { describe, it, expect } from "vitest";
import {
  applyPromotionDefaults,
  canonicalizePromotionInput,
  isBuildDispatch,
  validatePromotionMetadata,
  validateEnqueueSkipReason,
  parsePromotionEnforcement,
  type DispatchDoc,
  type EnqueueInput,
  type PromotionAgentDone,
} from "../../src/dispatch-scheduler/types.js";

const baseEnqueue: EnqueueInput = {
  query_id: "q",
  to_agent: "roger",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

function makeDoc(overrides: Partial<DispatchDoc> = {}): DispatchDoc {
  // Minimal DispatchDoc for validation tests — only the promotion-relevant
  // fields matter; rest is unused by validatePromotionMetadata.
  return {
    dispatch_phid: "phid:disp-x",
    query_id: "q",
    to_agent: "roger",
    from_actor: "manager",
    channel: "dispatch",
    subject: "subj",
    body_markdown: "body",
    provider: "anthropic",
    runtime: "claude-code-cli",
    priority: 5,
    status: "in_flight",
    not_before_at: "2026-05-23T00:00:00Z",
    attempt_count: 1,
    bounce_count: 0,
    last_bounce: null,
    bounce_history: [],
    started_at: "2026-05-23T00:00:00Z",
    completed_at: null,
    updated_at: "2026-05-23T00:00:00Z",
    agent_query_id: null,
    usage_policy_snapshot: null,
    failure_kind: null,
    failure_detail: null,
    clarification_id: null,
    active_clarification: null,
    clarification_history: [],
    resume_delivery_status: "none",
    promote: false,
    promotion_strategy: "auto",
    promotion_required_reason: null,
    promotion_result: null,
    promotion_input: null,
    ...overrides,
  };
}

describe("isBuildDispatch", () => {
  it("true when both repo + branch are set", () => {
    expect(
      isBuildDispatch({
        promotion_input: { repo: "/r", branch: "b", base: "main", remote: "origin" },
      }),
    ).toBe(true);
  });
  it("false when promotion_input is null", () => {
    expect(isBuildDispatch({ promotion_input: null })).toBe(false);
  });
  it("false when promotion_input lacks repo or branch", () => {
    expect(
      isBuildDispatch({
        promotion_input: { repo: "", branch: "b", base: "main", remote: "origin" },
      }),
    ).toBe(false);
  });
});

describe("applyPromotionDefaults", () => {
  it("non-build dispatch: promote defaults to false", () => {
    const out = applyPromotionDefaults({ ...baseEnqueue });
    expect(out.promote).toBe(false);
    expect(out.promotion_strategy).toBe("auto");
  });
  it("build dispatch: promote defaults to true; base + remote default to main + origin", () => {
    const out = applyPromotionDefaults({
      ...baseEnqueue,
      promotion_input: { repo: "/r", branch: "feat", base: "", remote: "" },
    });
    expect(out.promote).toBe(true);
    expect(out.promotion_input?.base).toBe("main");
    expect(out.promotion_input?.remote).toBe("origin");
  });
  it("build dispatch: metadata alias repos are canonicalized to protected roots", () => {
    const out = applyPromotionDefaults({
      ...baseEnqueue,
      promotion_input: {
        repo: "/Users/kilgore/Dropbox/Code/substrate-api-codex",
        branch: "routing-lifecycle-hygiene",
        base: "",
        remote: "",
      },
    });
    expect(out.promotion_input).toMatchObject({
      repo: "/Users/kilgore/Dropbox/Code/cane/id-agents",
      base: "main",
      remote: "origin",
    });
  });
  it("explicit promote=false on build dispatch is respected", () => {
    const out = applyPromotionDefaults({
      ...baseEnqueue,
      promote: false,
      promotion_input: { repo: "/r", branch: "feat", base: "main", remote: "origin" },
    });
    expect(out.promote).toBe(false);
  });
  it("explicit promotion_strategy survives", () => {
    const out = applyPromotionDefaults({
      ...baseEnqueue,
      promotion_strategy: "squash",
    });
    expect(out.promotion_strategy).toBe("squash");
  });
});

describe("canonicalizePromotionInput", () => {
  it("maps Kapelle frontend alias roots to kapelle-site", () => {
    expect(
      canonicalizePromotionInput({
        repo: "/Users/kilgore/Dropbox/Code/kapelle-site-codex",
        branch: "feat",
        base: "",
        remote: "",
      }),
    ).toMatchObject({
      repo: "/Users/kilgore/Dropbox/Code/kapelle-site",
      branch: "feat",
      base: "main",
      remote: "origin",
    });
  });

  it("leaves canonical repo roots intact", () => {
    expect(
      canonicalizePromotionInput({
        repo: "/Users/kilgore/Dropbox/Code/cane/id-agents",
        branch: "feat",
        base: "main",
        remote: "origin",
      }).repo,
    ).toBe("/Users/kilgore/Dropbox/Code/cane/id-agents");
  });
});

describe("validateEnqueueSkipReason — Spec 054 v2 Part 2 review-fix 2026-05-24", () => {
  it("non-build dispatch (no repo+branch) is always ok, regardless of promote/skip", () => {
    expect(validateEnqueueSkipReason({})).toBeNull();
    expect(validateEnqueueSkipReason({ promote: false })).toBeNull();
    expect(validateEnqueueSkipReason({ promote: true })).toBeNull();
    expect(validateEnqueueSkipReason({ repo: "/r" })).toBeNull(); // missing branch
    expect(validateEnqueueSkipReason({ branch: "b" })).toBeNull(); // missing repo
  });

  it("build dispatch with promote=true (or undefined / default) is ok regardless of skip", () => {
    expect(validateEnqueueSkipReason({ repo: "/r", branch: "b" })).toBeNull();
    expect(validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: true })).toBeNull();
    expect(validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: true, promotion_skip_reason: "ignored" })).toBeNull();
  });

  it("build dispatch + promote=false + no skip reason is REJECTED", () => {
    const err = validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: false });
    expect(err).not.toBeNull();
    expect(err).toMatch(/non-empty promotion_skip_reason/);
  });

  it("build dispatch + promote=false + empty string skip reason is REJECTED", () => {
    const err = validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: false, promotion_skip_reason: "" });
    expect(err).not.toBeNull();
  });

  it("build dispatch + promote=false + whitespace-only skip reason is REJECTED", () => {
    const err = validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: false, promotion_skip_reason: "   \t\n  " });
    expect(err).not.toBeNull();
  });

  it("build dispatch + promote=false + null skip reason is REJECTED", () => {
    const err = validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: false, promotion_skip_reason: null });
    expect(err).not.toBeNull();
  });

  it("build dispatch + promote=false + non-empty skip reason is ACCEPTED", () => {
    expect(
      validateEnqueueSkipReason({
        repo: "/r", branch: "b", promote: false,
        promotion_skip_reason: "WIP — revisit when smoke spec is final",
      }),
    ).toBeNull();
  });

  it("error message references the Spec 054 v2 Part 2 audit-trigger rule", () => {
    const err = validateEnqueueSkipReason({ repo: "/r", branch: "b", promote: false });
    expect(err).toMatch(/Spec 054 v2 Part 2/);
    expect(err).toMatch(/revisit trigger/);
  });
});

describe("parsePromotionEnforcement", () => {
  it("defaults to warn", () => {
    expect(parsePromotionEnforcement(undefined)).toBe("warn");
    expect(parsePromotionEnforcement("")).toBe("warn");
    expect(parsePromotionEnforcement("garbage")).toBe("warn");
  });
  it("recognises enforce (case-insensitive)", () => {
    expect(parsePromotionEnforcement("enforce")).toBe("enforce");
    expect(parsePromotionEnforcement("ENFORCE")).toBe("enforce");
    expect(parsePromotionEnforcement("  Enforce  ")).toBe("enforce");
  });
  it("warn is the explicit lowercase value too", () => {
    expect(parsePromotionEnforcement("warn")).toBe("warn");
  });
});

describe("validatePromotionMetadata", () => {
  const validRepo = {
    path: "/r",
    base: "main",
    source_branch: "feat",
    strategy: "fast_forward" as const,
    promoted_sha: "abc123",
    remote_main_sha: "abc123",
    pushed: true,
    verified: true,
  };
  const validPromotion: PromotionAgentDone = {
    required: true,
    completed: true,
    repos: [validRepo],
  };
  const buildDoc = makeDoc({
    promote: true,
    promotion_input: { repo: "/r", branch: "feat", base: "main", remote: "origin" },
  });

  it("non-build dispatch passes regardless of payload (warn)", () => {
    const r = validatePromotionMetadata(makeDoc({ promote: false }), null, "warn");
    expect(r.ok).toBe(true);
  });

  it("non-build dispatch passes regardless of payload (enforce)", () => {
    const r = validatePromotionMetadata(makeDoc({ promote: false }), null, "enforce");
    expect(r.ok).toBe(true);
  });

  it("build dispatch, no promotion payload, warn => ok with warning", () => {
    const r = validatePromotionMetadata(buildDoc, null, "warn");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/missing promotion metadata/);
  });

  it("build dispatch, no promotion payload, enforce => error", () => {
    const r = validatePromotionMetadata(buildDoc, null, "enforce");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing promotion metadata/);
  });

  it("build dispatch, completed != true, enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, completed: false },
      "enforce",
    );
    expect(r.ok).toBe(false);
  });

  it("build dispatch, empty repos[], enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, repos: [] },
      "enforce",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/repos\[\] is empty/);
  });

  it("build dispatch, repo missing path, enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, repos: [{ ...validRepo, path: "" }] },
      "enforce",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing required fields/);
  });

  it("build dispatch, pushed=false, enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, repos: [{ ...validRepo, pushed: false }] },
      "enforce",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pushed=false/);
  });

  it("build dispatch, verified=false, enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, repos: [{ ...validRepo, verified: false }] },
      "enforce",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/verified=false/);
  });

  it("build dispatch with enqueued repo path mismatch, enforce => error", () => {
    const r = validatePromotionMetadata(
      buildDoc,
      { ...validPromotion, repos: [{ ...validRepo, path: "/wrong" }] },
      "enforce",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not include the enqueued repo/);
  });

  it("build dispatch with full valid promotion payload passes (enforce)", () => {
    const r = validatePromotionMetadata(buildDoc, validPromotion, "enforce");
    expect(r.ok).toBe(true);
  });
});
