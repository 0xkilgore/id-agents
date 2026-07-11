import type { Agent } from '../api/types.js';

export interface AgentRuntimeTruthView {
  runtime: string;
  model: string;
  providerLane: string;
  source: string;
  why: string;
  staleDesiredModel: string | null;
  exhaustedReason: string | null;
}

function stringMeta(agent: Agent, key: string): string | null {
  const value = agent.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function statusLooksExhausted(status: string | undefined): boolean {
  return typeof status === 'string' && /exhaust|rate[-_ ]?limit|session[-_ ]?limit/i.test(status);
}

function runtimeFromMetadata(agent: Agent): string | null {
  return typeof agent.metadata?.runtime === 'string' && agent.metadata.runtime.trim()
    ? agent.metadata.runtime.trim()
    : null;
}

export function agentRuntimeTruth(agent: Agent): AgentRuntimeTruthView {
  const usage = agent.metadata?.runtimeUsageTruth;
  const runtime = usage?.actualRuntime || agent.runtime || runtimeFromMetadata(agent) || '—';
  const model = usage?.actualModel || agent.model || '—';
  const providerLane = usage?.usageTelemetry?.provider || stringMeta(agent, 'provider_lane') || 'other';
  const source = usage?.usageTelemetry?.source || 'agents_row';
  const desired = usage?.catalogDesiredModel || null;
  const staleDesiredModel = usage?.catalogModelStale && desired ? desired : null;
  const exhaustedReason = stringMeta(agent, 'exhausted_reason');

  const whyParts: string[] = [];
  if (exhaustedReason) {
    whyParts.push(`exhausted: ${exhaustedReason}`);
  } else if (statusLooksExhausted(agent.status)) {
    whyParts.push(`exhausted: ${agent.status}`);
  }
  if (staleDesiredModel) {
    whyParts.push(`fallback/different desired model: ${staleDesiredModel}`);
  }
  if (!usage && (agent.runtime || runtimeFromMetadata(agent))) {
    whyParts.push('legacy agents row');
  }

  return {
    runtime,
    model,
    providerLane,
    source,
    why: whyParts.length > 0 ? whyParts.join(' · ') : 'live /agents runtime truth',
    staleDesiredModel,
    exhaustedReason,
  };
}
