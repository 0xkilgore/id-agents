// T-QA.3 / HC-15 — live-UI Vercel preview verification substrate.
//
// Roger's assigned "wire substrate" step: a token-ready seam that gates live-UI
// preview verification on (a) the Vercel preview token (HC-15, Chris-supplied
// env) and (b) a preview-URL smoke runner (Sentinel's downstream step, injected
// here as a seam). Until both are present it returns a STRUCTURED skip — the
// same "flag for live-preview check" outcome as today, just typed — so the
// substrate is additive + reversible and activates the moment the token + runner
// land. These tests pin both the skip paths and the active paths.

import { describe, it, expect } from "vitest";
import {
  loadPreviewConfig,
  verifyPreview,
  PREVIEW_TOKEN_ENV,
  type PreviewSmokeRunner,
  type PreviewTarget,
} from "../../src/preview-verification/index.js";

const TARGET: PreviewTarget = {
  dispatch_id: "phid:disp-x",
  preview_url: "https://kapelle-git-pr-123.vercel.app",
};

const PASS_RUNNER: PreviewSmokeRunner = async () => ({ passed: true, checks: [] });
const FAIL_RUNNER: PreviewSmokeRunner = async () => ({
  passed: false,
  checks: [{ name: "console-errors", passed: false, detail: "ReferenceError on load" }],
});

describe("loadPreviewConfig", () => {
  it("reports the token absent when the env var is unset (HC-15 pending)", () => {
    const cfg = loadPreviewConfig({});
    expect(cfg.token_present).toBe(false);
    expect(cfg.token_env_var).toBe(PREVIEW_TOKEN_ENV);
  });

  it("reports the token present when the env var is set", () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok_live_123" });
    expect(cfg.token_present).toBe(true);
  });

  it("treats a whitespace-only token as absent", () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "   " });
    expect(cfg.token_present).toBe(false);
  });
});

describe("verifyPreview", () => {
  it("skips with a structured no-token result when HC-15 is pending", async () => {
    const cfg = loadPreviewConfig({});
    const r = await verifyPreview(TARGET, cfg, { runSmoke: PASS_RUNNER });
    expect(r.status).toBe("skipped_no_token");
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/token/i);
    expect(r.reason).toMatch(/HC-15|manual/i);
  });

  it("skips when no preview URL is available for the dispatch", async () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok" });
    const r = await verifyPreview({ dispatch_id: "d", preview_url: null }, cfg, { runSmoke: PASS_RUNNER });
    expect(r.status).toBe("skipped_no_target");
    expect(r.verified).toBe(false);
  });

  it("skips when the Sentinel smoke runner is not wired yet", async () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok" });
    const r = await verifyPreview(TARGET, cfg, {});
    expect(r.status).toBe("skipped_no_runner");
    expect(r.verified).toBe(false);
  });

  it("verifies when token + target + a passing smoke runner are all present", async () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok" });
    const r = await verifyPreview(TARGET, cfg, { runSmoke: PASS_RUNNER });
    expect(r.status).toBe("verified");
    expect(r.verified).toBe(true);
  });

  it("fails (carrying the failing checks) when the smoke runner reports a failure", async () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok" });
    const r = await verifyPreview(TARGET, cfg, { runSmoke: FAIL_RUNNER });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.checks?.some((c) => !c.passed)).toBe(true);
  });

  it("never throws if the smoke runner throws — surfaces it as a failed result", async () => {
    const cfg = loadPreviewConfig({ [PREVIEW_TOKEN_ENV]: "tok" });
    const boom: PreviewSmokeRunner = async () => {
      throw new Error("network down");
    };
    const r = await verifyPreview(TARGET, cfg, { runSmoke: boom });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/network down/);
  });
});
