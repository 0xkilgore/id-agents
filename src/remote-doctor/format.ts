// SPDX-License-Identifier: MIT
//
// kapelle-remote-doctor v1 — the human-Markdown rendering of a DoctorReport. The
// JSON (report.ts) is the contract; this is the at-a-glance operator view. Pure.

import type { DoctorReport } from './types.js';

/** Render the compact one-screen operator report (the default, non-`--json` view). */
export function formatDoctorMarkdown(r: DoctorReport): string {
  const gate = r.safe_to_fire ? '✅ SAFE TO FIRE: yes' : '⛔ SAFE TO FIRE: no';
  const lines: string[] = [
    `# kapelle-remote-doctor v${r.doctor_version}  —  ${r.generated_at}`,
    '',
    gate,
    `→ ${r.next_action}`,
    '',
    `- transport: ${r.transport.verdict} (tunnel=${r.transport.tunnel}, magicdns=${r.transport.magicdns}, ip=${r.transport.tailscale_ip})`,
    `- manager: ${r.manager.health}, fresh=${r.manager.fresh}${r.manager.startup_errors.length ? `, startup_errors=${r.manager.startup_errors.length}` : ''}`,
    `- reactor: ${r.reactor.health}`,
    `- kapelle ops: auth=${r.kapelle_ops.auth} via ${r.kapelle_ops.via}, fresh=${r.kapelle_ops.fresh}`,
    `- orchestration: ${r.orchestration.mode}${r.orchestration.auto_paused ? ' (auto-paused)' : ''}${r.orchestration.kill_switch ? ' (kill-switch)' : ''}`,
    `- agents: ${r.agents.registered} registered${r.agents.offline.length ? `, ${r.agents.offline.length} offline` : ''}`,
    `- freshness: all_nodes_fresh=${r.freshness.all_nodes_fresh}${r.freshness.stale_nodes.length ? `, stale=[${r.freshness.stale_nodes.join(', ')}]` : ''}, release_cohort=${r.freshness.release_cohort}`,
  ];

  if (!r.safe_to_fire) {
    lines.push('', '## Blocking reasons');
    for (const reason of r.safe_to_fire_reasons) lines.push(`- ${reason}`);
  }

  if (r.dispatches_needing_action.length > 0) {
    lines.push('', '## Dispatches needing action');
    for (const d of r.dispatches_needing_action) lines.push(`- [${d.class}] ${d.title} (${d.id})`);
  }

  return lines.join('\n');
}
