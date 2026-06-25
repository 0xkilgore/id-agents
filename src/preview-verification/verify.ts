// T-QA.3 / HC-15 — the preview verification gate (token-ready, no-op until wired).
//
// loadPreviewConfig reads the token presence from the environment. verifyPreview
// is otherwise pure (config injected) and NEVER throws: every missing
// prerequisite (token / preview URL / Sentinel runner) yields a structured skip,
// and a throwing runner is surfaced as a `failed` result. The no-token path is
// the typed replacement for today's ad-hoc "flag for live-preview check".

import {
  PREVIEW_TOKEN_ENV,
  type PreviewSmokeResult,
  type PreviewTarget,
  type PreviewVerificationConfig,
  type PreviewVerificationResult,
  type PreviewVerifyDeps,
} from "./types.js";

/** Derive config from an environment map (defaults to process.env). */
export function loadPreviewConfig(
  env: Record<string, string | undefined> = process.env,
): PreviewVerificationConfig {
  const raw = env[PREVIEW_TOKEN_ENV];
  const token_present = typeof raw === "string" && raw.trim().length > 0;
  return { token_present, token_env_var: PREVIEW_TOKEN_ENV };
}

export async function verifyPreview(
  target: PreviewTarget,
  config: PreviewVerificationConfig,
  deps: PreviewVerifyDeps = {},
): Promise<PreviewVerificationResult> {
  const base = {
    schema_version: "preview-verification.v1" as const,
    dispatch_id: target.dispatch_id,
    verified: false,
    preview_url: target.preview_url,
  };

  if (!config.token_present) {
    return {
      ...base,
      status: "skipped_no_token",
      reason: `${config.token_env_var} not set (HC-15 pending) — live-UI preview verification skipped; flagged for manual check.`,
    };
  }

  if (!target.preview_url) {
    return {
      ...base,
      status: "skipped_no_target",
      reason: "No preview URL was produced for this dispatch — nothing to verify.",
    };
  }

  if (!deps.runSmoke) {
    return {
      ...base,
      status: "skipped_no_runner",
      reason: "Vercel preview token present but the Sentinel smoke runner is not wired yet.",
    };
  }

  const token = deps.token ?? process.env[PREVIEW_TOKEN_ENV] ?? "";
  let result: PreviewSmokeResult;
  try {
    result = await deps.runSmoke(target, token);
  } catch (err) {
    return {
      ...base,
      status: "failed",
      reason: `Preview smoke runner threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.passed) {
    return {
      ...base,
      status: "verified",
      verified: true,
      reason: `Live-UI preview verified at ${target.preview_url} (${result.checks.length} check(s) passed).`,
      checks: result.checks,
    };
  }

  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
  return {
    ...base,
    status: "failed",
    reason: `Live-UI preview verification failed at ${target.preview_url}: ${failed.join(", ") || "smoke checks did not pass"}.`,
    checks: result.checks,
  };
}
