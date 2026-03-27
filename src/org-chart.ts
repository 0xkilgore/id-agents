// SPDX-License-Identifier: MIT
/**
 * Org Chart Generator
 *
 * Generates a markdown org chart from the YAML config's `org` section.
 * Written to the shared team folder so all agents can read it.
 */

import type { OrgConfig } from './config-parser.js';

interface AgentInfo {
  name: string;
  description?: string;
  domain?: string;
}

/**
 * Generate org chart markdown from config.
 */
export function generateOrgChart(
  teamName: string,
  org: OrgConfig,
  agents: AgentInfo[],
): string {
  const agentMap = new Map(agents.map(a => [a.name, a]));
  const lines: string[] = [];

  lines.push(`# ${teamName} — Org Chart`);
  lines.push('');
  lines.push('This document is auto-generated from the team config at deploy time.');
  lines.push('Use it to find who to talk to for different areas of the system.');
  lines.push('');

  // Build ASCII tree
  lines.push('## Structure');
  lines.push('');
  lines.push('```');
  lines.push(`${teamName}`);

  const groupNames = Object.keys(org.groups);
  groupNames.forEach((groupName, gi) => {
    const group = org.groups[groupName];
    const isLast = gi === groupNames.length - 1;
    const prefix = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    lines.push(`${prefix}${groupName} — ${group.description || ''}`);

    // Lead
    const leadAgent = agentMap.get(group.lead);
    const leadDomain = leadAgent?.domain ? ` (${leadAgent.domain})` : '';
    lines.push(`${childPrefix}├── ${group.lead} [lead]${leadDomain}`);

    // Members
    group.members.forEach((member, mi) => {
      const memberAgent = agentMap.get(member);
      const memberDomain = memberAgent?.domain ? ` (${memberAgent.domain})` : '';
      const memberPrefix = mi === group.members.length - 1 ? '└── ' : '├── ';
      lines.push(`${childPrefix}${memberPrefix}${member}${memberDomain}`);
    });
  });

  lines.push('```');
  lines.push('');

  // Group details
  lines.push('## Groups');
  lines.push('');

  for (const [groupName, group] of Object.entries(org.groups)) {
    lines.push(`### ${groupName}`);
    if (group.description) {
      lines.push(`${group.description}`);
    }
    lines.push('');
    lines.push(`| Role | Agent | Description |`);
    lines.push(`|------|-------|-------------|`);

    const leadAgent = agentMap.get(group.lead);
    lines.push(`| **Lead** | ${group.lead} | ${leadAgent?.description || ''} |`);

    for (const member of group.members) {
      const memberAgent = agentMap.get(member);
      lines.push(`| Member | ${member} | ${memberAgent?.description || ''} |`);
    }
    lines.push('');
  }

  // Quick reference: who to ask
  lines.push('## Who to Ask');
  lines.push('');
  lines.push('| Topic | Ask |');
  lines.push('|-------|-----|');

  for (const [groupName, group] of Object.entries(org.groups)) {
    const allMembers = [group.lead, ...group.members].join(', ');
    lines.push(`| ${group.description || groupName} | ${allMembers} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a short org context string for a specific agent.
 * Used in the identity skill to tell an agent who they work with.
 */
export function generateAgentOrgContext(
  agentName: string,
  org: OrgConfig,
): string {
  for (const [groupName, group] of Object.entries(org.groups)) {
    const isLead = group.lead === agentName;
    const isMember = group.members.includes(agentName);

    if (isLead) {
      const members = group.members.join(', ');
      return `You are the **lead** of the **${groupName}** group (${group.description || ''}). Your team members: ${members}. You coordinate work in this area.`;
    }

    if (isMember) {
      const peers = group.members.filter(m => m !== agentName);
      const peerList = peers.length > 0 ? ` Peers: ${peers.join(', ')}.` : '';
      return `You are in the **${groupName}** group (${group.description || ''}). Your lead: ${group.lead}.${peerList}`;
    }
  }

  return '';
}
