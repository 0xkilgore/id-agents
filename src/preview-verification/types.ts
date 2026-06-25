// T-QA.3 / HC-15 — live-UI Vercel preview verification substrate (the types).
//
// roadmap-reset T-QA.3 / HC-15: "wire a Vercel preview token into the
// verification chain so Sentinel can hit a per-PR preview URL + run smoke checks
// against the live UI; no more 'flag for live-preview check'." Sequence:
// Chris (gets token) -> Roger (wires substrate, this module) -> Sentinel (adds
// the preview-URL smoke step). This module is Roger's narrow seam: the token
// gate + target gate + result shape. The token (Chris) and the smoke runner
// (Sentinel) are injected, never invented here.

/** The env var that carries the Vercel preview token (HC-15, Chris-supplied). */
export const PREVIEW_TOKEN_ENV = "VERCEL_PREVIEW_TOKEN" as const;

/** Resolved configuration for preview verification. Derived from the
 *  environment so the verifier itself stays pure (config injected). */
export interface PreviewVerificationConfig {
  /** Whether the Vercel preview token is present (non-blank). */
  token_present: boolean;
  /** The env var consulted (for diagnostics / a different deployment naming). */
  token_env_var: string;
}

/** What is being verified: a dispatch and the preview URL produced for it. */
export interface PreviewTarget {
  dispatch_id: string;
  /** The per-PR / per-deploy preview URL, or null if none was produced. */
  preview_url: string | null;
}

/** One smoke assertion run against the live preview (Sentinel-owned detail). */
export interface PreviewCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The outcome of running the smoke checks against a preview URL. Produced by
 *  Sentinel's runner; this module only orchestrates + gates it. */
export interface PreviewSmokeResult {
  passed: boolean;
  checks: PreviewCheck[];
}

/** The Sentinel seam: given a target + token, hit the preview URL and run smoke
 *  checks. Intentionally NOT implemented here — Sentinel owns the actual hit. */
export type PreviewSmokeRunner = (
  target: PreviewTarget,
  token: string,
) => Promise<PreviewSmokeResult>;

/** Injected dependencies for verifyPreview. */
export interface PreviewVerifyDeps {
  /** The Sentinel smoke runner. Absent until Sentinel wires its step. */
  runSmoke?: PreviewSmokeRunner;
  /** The token value (for the runner). Defaults to reading the env at call
   *  time only when a runner is present; tests inject it implicitly via config. */
  token?: string;
}

export type PreviewVerificationStatus =
  | "skipped_no_token" // HC-15 pending — no token (current "flag for manual check")
  | "skipped_no_target" // token present but no preview URL was produced
  | "skipped_no_runner" // token + target present but Sentinel's runner not wired
  | "verified" // smoke checks passed against the live preview
  | "failed"; // smoke checks failed (or the runner threw)

export interface PreviewVerificationResult {
  schema_version: "preview-verification.v1";
  dispatch_id: string;
  status: PreviewVerificationStatus;
  verified: boolean;
  reason: string;
  preview_url: string | null;
  checks?: PreviewCheck[];
}
