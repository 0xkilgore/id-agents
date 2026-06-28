/**
 * AgentDetail — full-screen detail view for a focused agent.
 * v1 fields: name/runtime/health/status (+ remote endpoint/probe/access).
 * v2 dossier (T-CKPT.agent-v2), appended when `detail` is present: per-agent
 * charts (tasks/tokens/failures), the recent-output-last-20 feed, and the
 * agent's skills/loops/scripts. Degrades to v1 when detail is null.
 * Accessible in the agents view via → arrow when an agent is selected.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentDetailResponse } from '../api/types.js';
import { humanizeLastSeen } from '../util/format.js';
import { healthColor } from '../util/colors.js';

/** Send-state for the AP8 "dispatch to this agent" composer. */
export type ComposerStatus = 'idle' | 'sending' | 'sent' | 'error';

/** AP8 composer view-state, owned by App and rendered below the dossier. */
export interface AgentDispatchComposer {
  /** Is the composer open (capturing keystrokes)? */
  open: boolean;
  /** The message draft typed so far. */
  text: string;
  /** Send lifecycle. */
  status: ComposerStatus;
  /** Operator actor the dispatch is attributed to (e.g. user:chris). */
  actor: string;
  /** Last error (status==='error') or confirmation detail (status==='sent'). */
  note?: string | null;
}

interface AgentDetailProps {
  agent: Agent | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
  nowMs: number;
  /** v2 dossier; null while loading or when the backend returns no detail. */
  detail?: AgentDetailResponse | null;
  /** AP8 composer state; when undefined/closed the panel isn't rendered. */
  composer?: AgentDispatchComposer;
}

/** A unicode bar for a count relative to a max (charts in a TUI). */
function bar(n: number, max: number, width = 14): string {
  if (max <= 0) return '';
  const filled = Math.max(0, Math.min(width, Math.round((n / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** A sparkline over a numeric series (one block per point). */
function sparkline(values: number[]): string {
  if (values.length === 0) return '(no data)';
  const ticks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values
    .map((v) => ticks[Math.max(0, Math.min(7, Math.round((v / max) * 7)))])
    .join('');
}

function fieldRow(label: string, value: string | null | undefined, color?: string): string {
  const v = value ?? '(none)';
  const w = 22;
  const padded = label.padEnd(w);
  return `${padded}${v}`;
}

export function AgentDetail(props: AgentDetailProps): React.ReactElement {
  const { agent, positionLabel, windowSize, scrollOffset, contentWidth, nowMs, detail, composer } = props;

  if (!agent) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>agent · (none selected)</Text>
        <Text dimColor> </Text>
        <Text dimColor>(no agent selected — press ← to return)</Text>
        {Array.from({ length: Math.max(0, windowSize - 1) }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
      </Box>
    );
  }

  const isRemote = agent.deploymentShape === 'remote-endpoint' ||
    agent.metadata?.runtime === 'public-agent-remote';

  const lines: Array<{ label: string; value: string; color?: string }> = [];
  const agentName = agent.alias ?? agent.name;

  lines.push({ label: 'name', value: agentName });
  lines.push({ label: 'runtime', value: agent.metadata?.runtime ?? '—' });
  lines.push({ label: 'health', value: agent.health, color: healthColor(agent.health) });
  lines.push({ label: 'status', value: agent.status });

  if (isRemote) {
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Remote Endpoint ---', value: '' });
    lines.push({ label: 'customer_domain', value: agent.customer_domain ?? '—' });
    lines.push({ label: 'public_endpoint_url', value: agent.public_endpoint_url ?? '—' });
    lines.push({ label: 'ows_wallet', value: (agent.metadata as Record<string, unknown> | undefined)?.ows_wallet as string ?? agent.ows_wallet ?? '—' });
    lines.push({ label: 'idchain_domain', value: (agent.metadata as Record<string, unknown> | undefined)?.idchain_domain as string ?? agent.idchain_domain ?? '—' });
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Probe Status ---', value: '' });
    const lastSeenStr = agent.last_seen
      ? `${humanizeLastSeen(agent.last_seen, nowMs)} (unix: ${agent.last_seen})`
      : '(never probed)';
    lines.push({ label: 'last_seen', value: lastSeenStr });
    lines.push({ label: 'last_error', value: agent.last_error ?? '(none)' });
    lines.push({ label: 'consecutive_failures', value: String(agent.consecutive_failures ?? 0) });
    lines.push({ label: '', value: '' });
    lines.push({ label: '--- Access ---', value: '' });
    lines.push({ label: 'ssh_target', value: agent.ssh_target ?? '(not configured)' });
  } else {
    lines.push({ label: 'port', value: agent.port ? String(agent.port) : '—' });
    lines.push({ label: 'workingDirectory', value: agent.workingDirectory ?? '—' });
  }

  // ── v2 dossier (T-CKPT.agent-v2) ─────────────────────────────────────────
  if (detail) {
    const sec = (t: string) => lines.push({ label: `--- ${t} ---`, value: '' });
    const blank = () => lines.push({ label: '', value: '' });

    // (a) Charts — tasks by status, tokens today + 7d sparkline, failures.
    blank();
    sec('Charts');
    const { tasks, tokens, failures } = detail.charts;
    lines.push({ label: 'tasks (total)', value: String(tasks.total) });
    const taskMax = Math.max(1, ...Object.values(tasks.by_status));
    for (const [status, n] of Object.entries(tasks.by_status)) {
      lines.push({ label: `  ${status}`, value: `${bar(n, taskMax)} ${n}` });
    }
    lines.push({ label: 'tokens today', value: tokens.today.toLocaleString() });
    if (tokens.series.length > 0) {
      lines.push({
        label: 'tokens 7d',
        value: `${sparkline(tokens.series.map((p) => p.weighted))}  (${tokens.series.length}d)`,
      });
    }
    lines.push({
      label: 'failures',
      value: `${failures.consecutive} consec · ${failures.failed_dispatches} failed dispatch`,
    });
    if (failures.last_error) lines.push({ label: 'last_error', value: failures.last_error });

    // (b) Recent output — last 20 artifacts, newest first.
    blank();
    sec(`Recent Output (${detail.recent_outputs.length})`);
    if (detail.recent_outputs.length === 0) {
      lines.push({ label: '', value: '(none)' });
    } else {
      for (const o of detail.recent_outputs) {
        const when = humanizeLastSeen(Math.floor(Date.parse(o.produced_at) / 1000), nowMs);
        const tag = o.tag ? ` [${o.tag}]` : '';
        lines.push({ label: when, value: `${o.basename}${tag}` });
      }
    }

    const verifiedLandings = detail.verified_landings ?? [];
    const recentDispatches = detail.recent_dispatches ?? [];

    blank();
    sec(`Verified Landings (${verifiedLandings.length})`);
    if (verifiedLandings.length === 0) {
      lines.push({ label: '', value: '(none)' });
    } else {
      for (const d of verifiedLandings.slice(0, 8)) {
        const when = humanizeLastSeen(Math.floor(Date.parse(d.time) / 1000), nowMs);
        const attr = d.attributed_agent && d.attributed_agent !== agentName ? ` · ${d.attributed_agent}` : '';
        lines.push({ label: when, value: `${d.subject || d.dispatch_id}${attr}` });
      }
    }

    blank();
    sec(`Recent Dispatches (${recentDispatches.length})`);
    if (recentDispatches.length === 0) {
      lines.push({ label: '', value: '(none)' });
    } else {
      for (const d of recentDispatches.slice(0, 8)) {
        const when = humanizeLastSeen(Math.floor(Date.parse(d.time) / 1000), nowMs);
        const mark = d.verified ? '✓' : d.verification_status;
        const attr = d.attributed_agent && d.attributed_agent !== agentName ? ` · ${d.attributed_agent}` : '';
        lines.push({ label: when, value: `${mark} ${d.subject || d.dispatch_id}${attr}` });
      }
    }

    // (c) Skills / Loops / Scripts.
    blank();
    sec(`Skills (${detail.skills.length})`);
    if (detail.skills.length === 0) lines.push({ label: '', value: '(none)' });
    for (const s of detail.skills) lines.push({ label: '', value: `• ${s}` });

    blank();
    sec(`Loops (${detail.loops.length})`);
    if (detail.loops.length === 0) lines.push({ label: '', value: '(none)' });
    for (const l of detail.loops) {
      const flag = l.enabled ? '' : ' (disabled)';
      lines.push({ label: l.health_state, value: `${l.slug} · ${l.schedule_label}${flag}` });
    }

    blank();
    sec(`Scripts (${detail.scripts.length})`);
    if (detail.scripts.length === 0) lines.push({ label: '', value: '(none)' });
    for (const s of detail.scripts) lines.push({ label: '', value: `• ${s}` });
  } else {
    lines.push({ label: '', value: '' });
    lines.push({ label: '', value: '(loading dossier…)', color: 'gray' });
  }

  const allLines = lines.map(({ label, value, color }) => ({ label, value, color }));
  const total = allLines.length;
  const clampedOffset = Math.min(scrollOffset, Math.max(0, total - windowSize));
  const visible = allLines.slice(clampedOffset, clampedOffset + windowSize);
  const hiddenAbove = clampedOffset;
  const hiddenBelow = total - clampedOffset - visible.length;
  const W = 22;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>agent · {agentName}</Text>
          <Text dimColor>{positionLabel}</Text>
        </Box>
        <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
        {visible.map((row, i) => {
          if (!row.label && !row.value) return <Text key={i}> </Text>;
          if (row.label.startsWith('---')) {
            return <Text key={i} bold dimColor>{row.label}</Text>;
          }
          return (
            <Text key={i}>
              <Text dimColor>{row.label.padEnd(W)}</Text>
              {row.color
                ? <Text color={row.color}>{row.value}</Text>
                : <Text>{row.value}</Text>
              }
            </Text>
          );
        })}
        {Array.from({ length: Math.max(0, windowSize - visible.length) }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
        <Text dimColor>
          {composer?.open ? ' ' : hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : 'press d to dispatch to this agent'}
        </Text>
      </Box>
      {composer?.open ? <DispatchComposerPanel agentName={agentName} composer={composer} /> : null}
    </Box>
  );
}

/** AP8 — the "dispatch to this agent" composer panel, shown below the dossier
 *  while open. A single-line message buffer; Enter sends, Esc cancels. The send
 *  itself (POST /dispatch/enqueue) is owned by App; this just renders state. */
function DispatchComposerPanel(props: {
  agentName: string;
  composer: AgentDispatchComposer;
}): React.ReactElement {
  const { agentName, composer } = props;
  const statusLine = (() => {
    switch (composer.status) {
      case 'sending':
        return <Text color="yellow">sending…</Text>;
      case 'sent':
        return <Text color="green">✓ dispatched{composer.note ? ` (${composer.note})` : ''}</Text>;
      case 'error':
        return <Text color="red">error: {composer.note ?? 'failed to enqueue'}</Text>;
      default:
        return <Text dimColor>Enter send · Esc cancel</Text>;
    }
  })();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>
        dispatch → {agentName} <Text dimColor>(as {composer.actor})</Text>
      </Text>
      <Text>
        <Text dimColor>{'> '}</Text>
        {composer.text.length > 0 ? <Text>{composer.text}</Text> : <Text dimColor>(type a message)</Text>}
        <Text color="cyan">█</Text>
      </Text>
      {statusLine}
    </Box>
  );
}
