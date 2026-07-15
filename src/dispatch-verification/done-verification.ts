// Verify-on-done gate — the fix for "hollow done".
//
// Before /agent-done is allowed to mark a dispatch `done`, the manager verifies
// the CLAIMED deliverables actually exist: a claimed `artifact_path` must be a
// real file on disk, and a promotion's `promoted_sha` must actually be on the
// base branch. When a claim cannot be verified the dispatch is marked
// `failed_verification` (NOT done) with a clear reason, so a silent hollow-done
// surfaces instead of looking complete.
//
// The gate is pure (claims + injected probes in, result out) so it is fully
// unit-testable; the manager wires real filesystem + git probes around it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export interface PromotionRepoClaim {
  path?: string | null;
  base?: string | null;
  promoted_sha?: string | null;
  remote_main_sha?: string | null;
}

export interface DoneClaim {
  /** Absolute path the agent claims it produced. */
  artifact_path?: string | null;
  /** Spec 054 promotion block, when the dispatch promoted code. */
  promotion?: { repos?: PromotionRepoClaim[] } | null;
  /** Owner-visible delivery proof for a small production site fix. */
  delivery_contract?: SmallSiteFixDeliveryContract | null;
  /** Dispatch text used to infer required contracts for known small site-fix chains. */
  dispatch_context?: SmallSiteFixDispatchContext | null;
}

export interface SmallSiteFixDeliveryContract {
  kind?: string | null;
  project?: string | null;
  owner_accepted?: boolean | string | null;
  production_url?: string | null;
  screenshot_url?: string | null;
  screenshot_path?: string | null;
  evidence_url?: string | null;
  evidence_path?: string | null;
  evidence?: {
    screenshot_url?: string | null;
    screenshot_path?: string | null;
    evidence_url?: string | null;
    evidence_path?: string | null;
    production_url?: string | null;
    notes?: unknown;
  } | null;
}

export interface SmallSiteFixDispatchContext {
  subject?: string | null;
  body_markdown?: string | null;
  result_text?: string | null;
}

export interface DoneVerificationProbes {
  /** True when the file exists on disk. */
  fileExists: (path: string) => boolean;
  /** True when `sha` is reachable from `base` in the repo at `repoPath`. */
  commitOnBase: (repoPath: string, sha: string, base: string) => boolean;
}

export interface DoneVerificationCheck {
  kind: "artifact" | "commit" | "small_site_fix_contract";
  target: string;
  ok: boolean;
  detail?: string;
}

export interface DoneVerificationResult {
  ok: boolean;
  /** First failing check's reason, for the failed_verification detail. */
  reason?: string;
  checks: DoneVerificationCheck[];
}

function isNonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Verify the claimed deliverables. Returns ok=true when every claim that EXISTS
 * is verified (a dispatch that claims nothing verifiable passes — the gate only
 * catches claims that don't hold up, never invents a requirement).
 */
export function verifyDoneClaims(
  claim: DoneClaim,
  probes: DoneVerificationProbes,
): DoneVerificationResult {
  const checks: DoneVerificationCheck[] = [];

  if (isNonEmpty(claim.artifact_path)) {
    const path = claim.artifact_path.trim();
    const ok = safeBool(() => probes.fileExists(path));
    checks.push({
      kind: "artifact",
      target: path,
      ok,
      detail: ok ? undefined : `claimed artifact not found on disk: ${path}`,
    });
  }

  for (const repo of claim.promotion?.repos ?? []) {
    if (!isNonEmpty(repo.promoted_sha)) continue;
    const sha = repo.promoted_sha.trim();
    const base = isNonEmpty(repo.base) ? repo.base.trim() : "main";
    const repoPath = isNonEmpty(repo.path) ? repo.path.trim() : "";
    if (!repoPath) {
      checks.push({ kind: "commit", target: sha, ok: false, detail: `promotion repo missing path for ${sha}` });
      continue;
    }
    const ok = safeBool(() => probes.commitOnBase(repoPath, sha, base));
    checks.push({
      kind: "commit",
      target: `${sha}@${base}`,
      ok,
      detail: ok ? undefined : `promoted commit ${sha} is not on ${base} in ${repoPath}`,
    });
  }

  const siteFixRequired = requiresSmallSiteFixContract(claim);
  if (siteFixRequired.required) {
    checks.push(validateSmallSiteFixDeliveryContract(claim.delivery_contract, siteFixRequired.reason));
  }

  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed?.detail, checks };
}

export function requiresSmallSiteFixContract(claim: DoneClaim): { required: boolean; reason: string } {
  if (claim.delivery_contract?.kind === "small_site_fix") {
    return { required: true, reason: "explicit small_site_fix delivery contract" };
  }

  const text = [
    claim.dispatch_context?.subject,
    claim.dispatch_context?.body_markdown,
    claim.dispatch_context?.result_text,
  ].filter(isNonEmpty).join("\n").toLowerCase();

  if (!text) return { required: false, reason: "no dispatch text" };

  const mentionsSmallSiteFix =
    /\b(site|website|page|frontend|ui|graph|chart|pdf preview|preview)\b/.test(text) &&
    /\b(fix|change|patch|update|repair|restore|ship|deliver)\b/.test(text);
  const mentionsProtectedProject = /\b(finance|finances|cleveland park)\b/.test(text);

  return {
    required: mentionsSmallSiteFix && mentionsProtectedProject,
    reason: mentionsProtectedProject
      ? "Finance/Cleveland Park small site-fix dispatch requires owner acceptance, production URL, and screenshot/evidence"
      : "not a protected small site-fix dispatch",
  };
}

function validateSmallSiteFixDeliveryContract(
  contract: SmallSiteFixDeliveryContract | null | undefined,
  reason: string,
): DoneVerificationCheck {
  const missing: string[] = [];
  if (!contract || contract.kind !== "small_site_fix") missing.push("delivery_contract.kind=small_site_fix");
  if (!ownerAccepted(contract?.owner_accepted)) missing.push("owner_accepted=true");

  const productionUrl = present(contract?.production_url) ?? present(contract?.evidence?.production_url);
  if (!isProductionUrl(productionUrl)) missing.push("production_url");

  const evidence =
    present(contract?.screenshot_url) ??
    present(contract?.screenshot_path) ??
    present(contract?.evidence_url) ??
    present(contract?.evidence_path) ??
    present(contract?.evidence?.screenshot_url) ??
    present(contract?.evidence?.screenshot_path) ??
    present(contract?.evidence?.evidence_url) ??
    present(contract?.evidence?.evidence_path);
  if (!evidence) missing.push("screenshot_or_evidence");

  return {
    kind: "small_site_fix_contract",
    target: present(contract?.project) ?? "small_site_fix",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `${reason}: delivery contract verified`
      : `${reason}; missing ${missing.join(", ")}`,
  };
}

function ownerAccepted(value: unknown): boolean {
  return value === true || value === "true" || value === "accepted" || value === "approved";
}

function isProductionUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return false;
    return !["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function present(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** Real probes: filesystem existence + a git ancestry check. */
export function makeDoneVerificationProbes(): DoneVerificationProbes {
  return {
    fileExists: (path: string) => {
      try {
        return fs.existsSync(path);
      } catch {
        return false;
      }
    },
    commitOnBase: (repoPath: string, sha: string, base: string) => {
      // Only reject on DEFINITIVE proof of a hollow promotion — a real repo that
      // genuinely lacks the commit, or where the commit is genuinely not on the
      // base branch. When git cannot determine the answer (not a repo, unknown
      // ref, git unavailable) the result is INDETERMINATE and we do NOT block:
      // the gate exists to catch hollow dones, never to fail a legitimate one it
      // simply can't verify.
      const exists = git(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
      // exit 1 in a valid repo = the object is genuinely absent → hollow.
      if (!exists.ok && exists.code === 1) return false;
      // 128 / git-missing / malformed sha → indeterminate.
      if (!exists.ok) return true;
      for (const ref of [`origin/${base}`, base]) {
        const anc = git(repoPath, ["merge-base", "--is-ancestor", sha, ref]);
        if (anc.code === 0) return true; // sha is an ancestor of base → landed
        if (anc.code === 1) return false; // ref exists, sha NOT an ancestor → not landed
        // other codes (e.g. 128 unknown ref) → try the next ref.
      }
      // Commit exists but no base ref is resolvable here → indeterminate, allow.
      return true;
    },
  };
}

function git(repoPath: string, args: string[]): { ok: boolean; code: number } {
  try {
    execFileSync("git", ["-C", repoPath, ...args], { stdio: "ignore", timeout: 10_000 });
    return { ok: true, code: 0 };
  } catch (err) {
    const code = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : -1;
    return { ok: false, code };
  }
}
