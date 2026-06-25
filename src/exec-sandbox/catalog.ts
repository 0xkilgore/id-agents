// RF1 — exec-sandbox provider catalog (the evaluated data).
//
// HONESTY NOTE: capabilities are from public docs as of `as_of` and carry a
// confidence. PRICING DRIFTS — every cost row is `verify_before_use: true` with
// a representative (not quoted) rate; the recommender's MATH is the durable
// artifact, the numbers are operator-replaceable inputs. Do not present any
// usd_* figure here as a committed quote without re-verifying the source_url.
//
// Two providers are evaluated per RF1 (E2B, Daytona) plus a local-process
// baseline as the "do nothing / status-quo" reference point the codebase
// actually has today (codex.ts spawns local `codex exec`).

import type { SandboxProvider } from "./types.js";

const EVAL_DATE = "2026-06-24";

export const E2B: SandboxProvider = {
  id: "e2b",
  name: "E2B",
  url: "https://e2b.dev",
  open_source: true,
  license: "Apache-2.0",
  capabilities: {
    persistent_fs: true,
    snapshots: true,
    network_egress: true,
    isolation: "microvm", // Firecracker microVMs
    startup_ms: 200,
    max_session_seconds: 24 * 3600,
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "per_second",
    usd_per_sandbox_hour: 0.10, // representative 1 vCPU / ~2GB — VERIFY
    free_tier_usd_per_month: 100, // trial/credit — VERIFY
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://e2b.dev/pricing",
      confidence: "low",
      verify_before_use: true,
      note: "Per-second usage billing (vCPU+RAM tiers). Rate normalized to a small sandbox; re-quote before committing.",
    },
  },
  self_host: {
    available: true,
    license: "Apache-2.0",
    setup_effort_person_days: 10, // Firecracker infra is non-trivial to operate
    ops_burden_person_days_per_month: 3,
    infra_usd_per_month: 300,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/e2b-dev/infra",
      confidence: "medium",
      verify_before_use: true,
      note: "Open-source infra repo exists; self-hosting Firecracker pools is real ops work. Estimates, not quotes.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://e2b.dev",
    confidence: "medium",
    note: "Firecracker-microVM sandboxes purpose-built for AI agent code execution; OSS core (Apache-2.0) → directly liftable per directive #77.",
  },
};

export const DAYTONA: SandboxProvider = {
  id: "daytona",
  name: "Daytona",
  url: "https://daytona.io",
  open_source: true,
  license: "Apache-2.0",
  capabilities: {
    persistent_fs: true,
    snapshots: true,
    network_egress: true,
    isolation: "container", // workspace/dev-environment oriented
    startup_ms: 300,
    max_session_seconds: 24 * 3600,
    sdk_languages: ["typescript", "python"],
  },
  hosted_cost: {
    billing_unit: "per_second",
    usd_per_sandbox_hour: 0.08, // representative — VERIFY
    free_tier_usd_per_month: 0, // VERIFY
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://www.daytona.io/pricing",
      confidence: "low",
      verify_before_use: true,
      note: "Usage-based sandbox billing. Rate normalized to a small sandbox; re-quote before committing.",
    },
  },
  self_host: {
    available: true,
    license: "Apache-2.0",
    setup_effort_person_days: 7, // dev-environment manager, container-based
    ops_burden_person_days_per_month: 2,
    infra_usd_per_month: 200,
    provenance: {
      as_of: EVAL_DATE,
      source_url: "https://github.com/daytonaio/daytona",
      confidence: "medium",
      verify_before_use: true,
      note: "OSS core (Apache-2.0), container-based → lower self-host effort than microVM but weaker isolation. Estimates, not quotes.",
    },
  },
  provenance: {
    as_of: EVAL_DATE,
    source_url: "https://daytona.io",
    confidence: "medium",
    note: "Originated as an OSS dev-environment manager, extended to agent sandboxes; container isolation. OSS core → liftable.",
  },
};

/** Status-quo baseline: the local-process execution the codebase has today
 *  (codex.ts spawns `codex exec`). No isolation, no cost, but disqualified for
 *  untrusted code — included so the recommender always has the honest "do
 *  nothing" reference to score against. */
export const LOCAL_PROCESS: SandboxProvider = {
  id: "local_process",
  name: "Local process (status quo)",
  url: "",
  open_source: true,
  capabilities: {
    persistent_fs: true,
    snapshots: false,
    network_egress: true,
    isolation: "process",
    startup_ms: 20,
    max_session_seconds: 24 * 3600,
    sdk_languages: ["typescript", "python", "shell"],
  },
  hosted_cost: {
    billing_unit: "subscription",
    usd_per_sandbox_hour: 0,
    free_tier_usd_per_month: 0,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Runs on existing hardware; no marginal cost." },
  },
  self_host: {
    available: true,
    setup_effort_person_days: 0,
    ops_burden_person_days_per_month: 0,
    infra_usd_per_month: 0,
    provenance: { as_of: EVAL_DATE, confidence: "high", note: "Already in place." },
  },
  provenance: {
    as_of: EVAL_DATE,
    confidence: "high",
    note: "Baseline only. Process isolation is unsafe for untrusted agent code — expect it to be gated out whenever min_isolation > process.",
  },
};

export const DEFAULT_CATALOG: SandboxProvider[] = [E2B, DAYTONA, LOCAL_PROCESS];
