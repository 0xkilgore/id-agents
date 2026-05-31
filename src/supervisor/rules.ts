// Supervisor v0 — Deterministic rule functions.
// Each rule evaluates a source snapshot and returns zero or more findings.
// Rules are pure functions: no IO, no side effects, no intervention.

import type {
  RuleFinding,
  SourceSnapshot,
  ActiveDispatch,
  TerminalDispatch,
  AgentStatus,
  NewsEntry,
} from './types.js';
import type { SupervisorWatchConfig } from './config.js';
import { getEffectiveStuckQuerySeconds, getEffectiveAgentDownSeconds, isAgentWatched } from './config.js';

// Terminal dispatch statuses that should not trigger stuck alerts.
const SUPPRESSED_STATUSES = new Set([
  'done', 'failed', 'cancelled', 'needs_clarification',
]);

export function evaluateStuckQueries(
  snapshot: SourceSnapshot,
  config: SupervisorWatchConfig,
  now: number,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const d of snapshot.active_dispatches) {
    if (!isAgentWatched(config, d.to_agent)) continue;
    if (SUPPRESSED_STATUSES.has(d.status)) continue;

    const startedAt = d.started_at ? new Date(d.started_at).getTime() : new Date(d.updated_at).getTime();
    const ageSeconds = (now - startedAt) / 1000;
    const threshold = getEffectiveStuckQuerySeconds(config, d.to_agent);

    if (ageSeconds < threshold) continue;

    // Check for progress via news
    const agentNews = snapshot.recent_news.filter(n => n.agent_id === d.to_agent);
    const latestNewsTs = agentNews.length > 0
      ? Math.max(...agentNews.map(n => new Date(n.ts).getTime()))
      : 0;
    const noProgressAge = latestNewsTs > 0 ? (now - latestNewsTs) / 1000 : ageSeconds;
    const noProgress = noProgressAge >= config.noProgressSeconds;

    const isCritical = ageSeconds >= threshold * 2 && noProgress;

    findings.push({
      dedupe_key: `stuck_query:${d.query_id}`,
      kind: 'stuck_query',
      severity: isCritical ? 'critical' : 'warning',
      confidence: noProgress ? 'high' : 'medium',
      title: `Stuck query ${d.query_id} assigned to ${d.to_agent}`,
      summary: `Dispatch ${d.dispatch_phid} has been in "${d.status}" for ${Math.round(ageSeconds)}s (threshold: ${threshold}s). ${noProgress ? `No progress in ${Math.round(noProgressAge)}s.` : 'Recent news activity detected.'}`,
      evidence: [
        {
          source: 'dispatch',
          ref: d.dispatch_phid,
          observed_at: snapshot.collected_at,
          detail: `status=${d.status}, started_at=${d.started_at}, age=${Math.round(ageSeconds)}s`,
        },
        ...(noProgress ? [{
          source: 'news' as const,
          observed_at: snapshot.collected_at,
          detail: `No news activity for ${Math.round(noProgressAge)}s`,
        }] : []),
      ],
      counters: { age_seconds: Math.round(ageSeconds), no_progress_seconds: Math.round(noProgressAge) },
      agent_id: d.to_agent,
      query_id: d.query_id,
      dispatch_id: d.dispatch_phid,
    });
  }

  return findings;
}

export function evaluateAgentDown(
  snapshot: SourceSnapshot,
  config: SupervisorWatchConfig,
  now: number,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const agent of snapshot.watched_agents) {
    if (!isAgentWatched(config, agent.agent_id)) continue;

    const threshold = getEffectiveAgentDownSeconds(config, agent.agent_id);

    if (!agent.last_seen_at) {
      // No heartbeat data at all — only alert if agent has active work
      if (agent.active_dispatches > 0) {
        findings.push({
          dedupe_key: `agent_down:${agent.agent_id}`,
          kind: 'agent_down',
          severity: 'critical',
          confidence: 'medium',
          title: `Agent ${agent.agent_id} has no heartbeat and active dispatches`,
          summary: `Agent ${agent.agent_id} has ${agent.active_dispatches} active dispatch(es) but no heartbeat data available.`,
          evidence: [{
            source: 'metrics',
            observed_at: snapshot.collected_at,
            detail: `No last_seen_at, active_dispatches=${agent.active_dispatches}`,
          }],
          agent_id: agent.agent_id,
        });
      }
      continue;
    }

    const lastSeenMs = new Date(agent.last_seen_at).getTime();
    const staleSeconds = (now - lastSeenMs) / 1000;

    if (staleSeconds < threshold) continue;

    const hasActiveWork = agent.active_dispatches > 0;

    findings.push({
      dedupe_key: `agent_down:${agent.agent_id}`,
      kind: 'agent_down',
      severity: hasActiveWork ? 'critical' : 'warning',
      confidence: 'high',
      title: `Agent ${agent.agent_id} appears down`,
      summary: `No heartbeat for ${Math.round(staleSeconds)}s (threshold: ${threshold}s). ${hasActiveWork ? `Has ${agent.active_dispatches} active dispatch(es).` : 'No active work assigned.'}`,
      evidence: [{
        source: 'metrics',
        ref: agent.agent_id,
        observed_at: snapshot.collected_at,
        detail: `last_seen_at=${agent.last_seen_at}, stale=${Math.round(staleSeconds)}s, active_dispatches=${agent.active_dispatches}`,
      }],
      counters: { stale_seconds: Math.round(staleSeconds) },
      agent_id: agent.agent_id,
    });
  }

  return findings;
}

// Harness-resilience (Spec: 2026-05-29) — failure kinds that are model/API
// or harness infrastructure rather than semantic build/test failures.
const MODEL_API_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'model_api_error_exhausted',
  'harness_empty_result_exhausted',
  'harness_process_error_exhausted',
]);

export function evaluateModelApiErrors(
  snapshot: SourceSnapshot,
  _config: SupervisorWatchConfig,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const d of snapshot.terminal_dispatches) {
    if (d.status !== 'failed') continue;
    if (!d.failure_kind || !MODEL_API_FAILURE_KINDS.has(d.failure_kind)) continue;

    // Severity: critical for build dispatches (these block real shipping),
    // warning otherwise (spec/report dispatches that just need a re-poke).
    const isBuild = d.promote || d.promotion_input != null;
    const severity = isBuild ? 'critical' : 'warning';

    findings.push({
      dedupe_key: `model_api_error:${d.dispatch_phid}`,
      kind: 'model_api_error',
      severity,
      confidence: 'high',
      title: `Model/API failure exhausted on ${d.dispatch_phid}`,
      summary: `Dispatch to ${d.to_agent} terminated with ${d.failure_kind} — harness retries exhausted. ${d.failure_detail ?? 'no detail'}`,
      evidence: [
        {
          source: 'dispatch',
          ref: d.dispatch_phid,
          observed_at: snapshot.collected_at,
          detail: `failure_kind=${d.failure_kind}, failure_detail=${d.failure_detail ?? ''}`,
        },
      ],
      agent_id: d.to_agent,
      query_id: d.query_id,
      dispatch_id: d.dispatch_phid,
    });
  }

  return findings;
}

export function evaluateBuildFailures(
  snapshot: SourceSnapshot,
  _config: SupervisorWatchConfig,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const d of snapshot.terminal_dispatches) {
    if (d.status !== 'failed') continue;

    // Harness-resilience: model/API/harness exhaustion is covered by the
    // more specific `model_api_error` rule. Skip here to avoid duplicate
    // alerts on the same dispatch.
    if (d.failure_kind && MODEL_API_FAILURE_KINDS.has(d.failure_kind)) continue;

    // Only classify as build_failure when dispatch metadata indicates build/code work.
    const isBuild = d.promote || d.promotion_input != null ||
      /\b(build|deploy|implement|code|branch|merge|promote)\b/i.test(d.subject);
    if (!isBuild) continue;

    findings.push({
      dedupe_key: `build_failure:${d.dispatch_phid}`,
      kind: 'build_failure',
      severity: 'warning',
      confidence: 'high',
      title: `Build dispatch ${d.dispatch_phid} failed`,
      summary: `Dispatch to ${d.to_agent} failed: ${d.failure_kind ?? 'unknown'} — ${d.failure_detail ?? 'no detail'}. Subject: "${d.subject}"`,
      evidence: [{
        source: 'dispatch',
        ref: d.dispatch_phid,
        observed_at: snapshot.collected_at,
        detail: `status=failed, failure_kind=${d.failure_kind}, failure_detail=${d.failure_detail}`,
      }],
      agent_id: d.to_agent,
      query_id: d.query_id,
      dispatch_id: d.dispatch_phid,
    });
  }

  return findings;
}

export function evaluatePromotionFailures(
  snapshot: SourceSnapshot,
  _config: SupervisorWatchConfig,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const d of snapshot.terminal_dispatches) {
    if (d.status !== 'done') continue;
    if (!d.promote) continue;

    const promo = d.promotion_result as {
      required?: boolean;
      completed?: boolean;
      repos?: Array<{
        pushed?: boolean;
        verified?: boolean;
        promoted_sha?: string;
        remote_main_sha?: string;
      }>;
    } | null | undefined;

    // No promotion payload at all
    if (!promo) {
      // Check if there's a skip reason in the input
      if (d.promotion_input?.promotion_skip_reason) {
        // Protocol gap: promote=true but skip reason set (inconsistent)
        findings.push({
          dedupe_key: `protocol_gap:promotion:${d.dispatch_phid}`,
          kind: 'protocol_gap',
          severity: 'info',
          confidence: 'medium',
          title: `Inconsistent promotion metadata on ${d.dispatch_phid}`,
          summary: `Dispatch has promote=true but also a promotion_skip_reason. Protocol gap.`,
          evidence: [{
            source: 'agent_done',
            ref: d.dispatch_phid,
            observed_at: snapshot.collected_at,
            detail: `promote=true, skip_reason="${d.promotion_input.promotion_skip_reason}", no promotion_result`,
          }],
          dispatch_id: d.dispatch_phid,
          agent_id: d.to_agent,
        });
        continue;
      }

      findings.push({
        dedupe_key: `promotion_failure:${d.dispatch_phid}`,
        kind: 'promotion_failure',
        severity: 'critical',
        confidence: 'high',
        title: `Missing promotion on build dispatch ${d.dispatch_phid}`,
        summary: `Build dispatch to ${d.to_agent} completed with promote=true but /agent-done has no promotion payload.`,
        evidence: [{
          source: 'agent_done',
          ref: d.dispatch_phid,
          observed_at: snapshot.collected_at,
          detail: `promote=true, promotion_result=null`,
        }],
        dispatch_id: d.dispatch_phid,
        agent_id: d.to_agent,
        query_id: d.query_id,
      });
      continue;
    }

    // Promotion not completed
    if (promo.completed !== true) {
      findings.push({
        dedupe_key: `promotion_failure:${d.dispatch_phid}`,
        kind: 'promotion_failure',
        severity: 'critical',
        confidence: 'high',
        title: `Incomplete promotion on ${d.dispatch_phid}`,
        summary: `Promotion block present but completed=${promo.completed}.`,
        evidence: [{
          source: 'agent_done',
          ref: d.dispatch_phid,
          observed_at: snapshot.collected_at,
          detail: `promotion.completed=${promo.completed}`,
        }],
        dispatch_id: d.dispatch_phid,
        agent_id: d.to_agent,
        query_id: d.query_id,
      });
      continue;
    }

    // Check individual repo entries
    if (!Array.isArray(promo.repos) || promo.repos.length === 0) {
      findings.push({
        dedupe_key: `promotion_failure:${d.dispatch_phid}`,
        kind: 'promotion_failure',
        severity: 'critical',
        confidence: 'high',
        title: `Empty promotion repos on ${d.dispatch_phid}`,
        summary: `Promotion block has completed=true but no repo entries.`,
        evidence: [{
          source: 'agent_done',
          ref: d.dispatch_phid,
          observed_at: snapshot.collected_at,
          detail: `promotion.repos is empty`,
        }],
        dispatch_id: d.dispatch_phid,
        agent_id: d.to_agent,
        query_id: d.query_id,
      });
      continue;
    }

    for (const repo of promo.repos) {
      const issues: string[] = [];
      if (!repo.pushed) issues.push('pushed=false');
      if (!repo.verified) issues.push('verified=false');
      if (!repo.promoted_sha) issues.push('missing promoted_sha');
      if (!repo.remote_main_sha) issues.push('missing remote_main_sha');
      if (repo.promoted_sha && repo.remote_main_sha && repo.promoted_sha !== repo.remote_main_sha) {
        issues.push(`sha mismatch: promoted=${repo.promoted_sha} remote=${repo.remote_main_sha}`);
      }

      if (issues.length > 0) {
        findings.push({
          dedupe_key: `promotion_failure:${d.dispatch_phid}`,
          kind: 'promotion_failure',
          severity: 'critical',
          confidence: 'high',
          title: `Promotion verification failed on ${d.dispatch_phid}`,
          summary: `Promotion issues: ${issues.join(', ')}`,
          evidence: [{
            source: 'agent_done',
            ref: d.dispatch_phid,
            observed_at: snapshot.collected_at,
            detail: issues.join('; '),
          }],
          dispatch_id: d.dispatch_phid,
          agent_id: d.to_agent,
          query_id: d.query_id,
        });
        break; // One finding per dispatch
      }
    }
  }

  return findings;
}

// Error marker patterns for news entries.
const ERROR_MARKERS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\btimeout\b/i,
  /\brate.?limit\b/i,
  /\bhung\b/i,
  /\bstuck\b/i,
  /\bpermission.?denied\b/i,
];

function isErrorLikeNews(message: string): boolean {
  return ERROR_MARKERS.some(re => re.test(message));
}

function fingerprint(message: string): string {
  // Normalize: lowercase, collapse whitespace, remove timestamps/ids
  return message
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<ts>')
    .replace(/[a-f0-9]{8,}/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateRepeatedNewsErrors(
  snapshot: SourceSnapshot,
  config: SupervisorWatchConfig,
  now: number,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  // Group error-like news by agent + fingerprint
  const buckets = new Map<string, { agent_id: string; fp: string; entries: NewsEntry[] }>();
  const windowStart = now - config.newsErrorWindowSeconds * 1000;

  for (const entry of snapshot.recent_news) {
    if (!isAgentWatched(config, entry.agent_id)) continue;

    const entryTs = new Date(entry.ts).getTime();
    if (entryTs < windowStart) continue;
    if (!isErrorLikeNews(entry.message)) continue;

    const fp = fingerprint(entry.message);
    const key = `${entry.agent_id}:${fp}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { agent_id: entry.agent_id, fp, entries: [] };
      buckets.set(key, bucket);
    }
    bucket.entries.push(entry);
  }

  for (const [_key, bucket] of buckets) {
    if (bucket.entries.length < config.newsErrorRepeatCount) continue;

    findings.push({
      dedupe_key: `news_repeated_error:${bucket.agent_id}:${bucket.fp}`,
      kind: 'news_repeated_error',
      severity: 'warning',
      confidence: 'medium',
      title: `Repeated errors from ${bucket.agent_id}`,
      summary: `${bucket.entries.length} error-like news entries matching pattern within ${config.newsErrorWindowSeconds}s window.`,
      evidence: bucket.entries.slice(0, 5).map(e => ({
        source: 'news' as const,
        ref: e.id,
        observed_at: e.ts,
        detail: e.message.slice(0, 200),
      })),
      counters: { error_count: bucket.entries.length },
      agent_id: bucket.agent_id,
    });
  }

  return findings;
}

export function evaluateAllRules(
  snapshot: SourceSnapshot,
  config: SupervisorWatchConfig,
  now: number = Date.now(),
): RuleFinding[] {
  return [
    ...evaluateStuckQueries(snapshot, config, now),
    ...evaluateAgentDown(snapshot, config, now),
    // Harness-resilience: model_api_error runs before build_failure so the
    // more specific infrastructure-failure signal wins on dedupe.
    ...evaluateModelApiErrors(snapshot, config),
    ...evaluateBuildFailures(snapshot, config),
    ...evaluatePromotionFailures(snapshot, config),
    ...evaluateRepeatedNewsErrors(snapshot, config, now),
  ];
}
