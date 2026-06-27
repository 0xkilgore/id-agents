// Task 4 — DispatchVerification job. Periodically reads queue rows from the
// scheduler reactor, adapts each into a VerifierDispatchRow, runs the pure
// verifyDispatch classifier, and upserts the resulting projection rows into
// DispatchVerificationStorage. The Agents endpoints read that projection and
// never stat files on request.
//
// The class is fully injectable (reactor, storage, statArtifact, now) so it
// stays unit-testable. A separate factory (jobConfigFromEnv) reads env.

import { validatePromotionMetadata } from "../dispatch-scheduler/types.js";
import type {
  DispatchVerificationSourceRow,
  PromotionAgentDone,
} from "../dispatch-scheduler/types.js";
import { verifyDispatch } from "./verifier.js";
import type { DispatchVerificationStorage } from "./storage.js";
import type {
  ArtifactStat,
  DispatchVerification,
  VerifierDispatchRow,
} from "./types.js";

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_INTERVAL_MS = 300_000;
const DAY_MS = 86_400_000;

export interface DispatchVerificationJobOptions {
  teamId: string;
  reactor: {
    listForVerification(o: { sinceIso: string }): Promise<DispatchVerificationSourceRow[]>;
  };
  storage: DispatchVerificationStorage;
  statArtifact: (path: string) => ArtifactStat;
  now: () => string;
  lookbackDays?: number;
  expiredAfterMs?: number;
  intervalMs?: number;
  enabled?: boolean;
}

export class DispatchVerificationJob {
  private readonly teamId: string;
  private readonly reactor: DispatchVerificationJobOptions["reactor"];
  private readonly storage: DispatchVerificationStorage;
  private readonly statArtifact: (path: string) => ArtifactStat;
  private readonly now: () => string;
  private readonly lookbackDays: number;
  private readonly expiredAfterMs?: number;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DispatchVerificationJobOptions) {
    this.teamId = opts.teamId;
    this.reactor = opts.reactor;
    this.storage = opts.storage;
    this.statArtifact = opts.statArtifact;
    this.now = opts.now;
    this.lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    this.expiredAfterMs = opts.expiredAfterMs;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.enabled = opts.enabled ?? true;
  }

  async runOnce(): Promise<{ checked: number; verified: number; upserted: number }> {
    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);
    const anchorMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
    const sinceIso = new Date(anchorMs - this.lookbackDays * DAY_MS).toISOString();

    const sourceRows = await this.reactor.listForVerification({ sinceIso });
    const results: DispatchVerification[] = [];
    for (const row of sourceRows) {
      const verifierRow = this.toVerifierRow(row);
      const result = verifyDispatch(verifierRow, {
        statArtifact: this.statArtifact,
        now: nowIso,
        expiredAfterMs: this.expiredAfterMs,
      });
      results.push(result);
    }

    await this.storage.upsertMany(results);

    const verified = results.reduce((n, r) => (r.verified ? n + 1 : n), 0);
    return { checked: sourceRows.length, verified, upserted: results.length };
  }

  async runOnceSafe(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      console.warn("[dispatch-verification-job] runOnce failed:", err);
    }
  }

  start(): void {
    if (!this.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnceSafe();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private toVerifierRow(row: DispatchVerificationSourceRow): VerifierDispatchRow {
    const parsed = parseResult(row.result_json);
    const resultSuccess =
      parsed && parsed.success === true
        ? true
        : parsed && parsed.success === false
          ? false
          : null;
    const tlDr = parsed && typeof parsed.tl_dr === "string" ? parsed.tl_dr : null;

    const pv = validatePromotionMetadata(
      { promote: row.promote, promotion_input: null, promotion_strategy: "auto" },
      row.promotion_result as PromotionAgentDone | null,
      "enforce",
    );
    const promotionVerified = row.promote ? pv.ok : null;
    const promotionFailureDetail = row.promote && !pv.ok ? pv.error : null;

    const resultHasArtifact =
      parsed && typeof parsed.artifact_path === "string" && parsed.artifact_path.length > 0;
    const artifactPathSource: VerifierDispatchRow["artifact_path_source"] = row.artifact_path
      ? "artifact_path"
      : resultHasArtifact
        ? "result_json"
        : "none";

    return {
      team_id: this.teamId,
      dispatch_id: row.dispatch_phid,
      query_id: row.query_id ?? null,
      agent_name: row.to_agent,
      provider: row.provider,
      status: row.status,
      artifact_path: row.artifact_path,
      result_success: resultSuccess,
      tl_dr: tlDr,
      failure_kind: row.failure_kind,
      failure_detail: row.failure_detail,
      created_at: row.not_before_at ?? row.updated_at,
      started_at: row.started_at,
      not_before_at: row.not_before_at,
      completed_at: row.completed_at,
      promotion_required: row.promote === true,
      promotion_verified: promotionVerified,
      promotion_failure_detail: promotionFailureDetail,
      artifact_path_source: artifactPathSource,
    };
  }
}

interface ParsedResult {
  success?: unknown;
  tl_dr?: unknown;
  artifact_path?: unknown;
}

function parseResult(raw: string | null): ParsedResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ParsedResult;
  } catch {
    return null;
  }
}

/** Read job config from process env. Pure parse; no side effects. */
export function jobConfigFromEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  intervalMs: number;
  lookbackDays: number;
} {
  const rawEnabled = (env.DISPATCH_VERIFICATION_ENABLED ?? "true").trim().toLowerCase();
  const enabled = !(rawEnabled === "false" || rawEnabled === "0" || rawEnabled === "no");

  const intervalMs = parsePositiveInt(
    env.DISPATCH_VERIFICATION_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  const lookbackDays = parsePositiveInt(
    env.DISPATCH_VERIFICATION_LOOKBACK_DAYS,
    DEFAULT_LOOKBACK_DAYS,
  );
  return { enabled, intervalMs, lookbackDays };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
