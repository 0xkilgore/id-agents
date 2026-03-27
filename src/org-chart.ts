// SPDX-License-Identifier: MIT
/**
 * Org Chart Generator
 *
 * Generates a markdown org chart from the YAML config's `org` section.
 * Supports groups with subgroups, leads, and tags.
 * Written to the shared team folder so all agents can read it.
 */

import type { OrgConfig } from './config-parser.js';

interface AgentInfo {
  name: string;
  description?: string;
  domain?: string;
}

/**
 * Get all members of a group (flattened from subgroups).
 */
function getGroupMembers(group: OrgConfig['groups'][string]): string[] {
  const members = new Set<string>();
  if (group.subgroups) {
    for (const sub of Object.values(group.subgroups)) {
      for (const m of sub.members) members.add(m);
    }
  }
  return [...members];
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
  lines.push('Auto-generated from the team config at deploy time.');
  lines.push('');

  // ASCII tree
  lines.push('## Structure');
  lines.push('');
  lines.push('```');
  lines.push(`${teamName}`);

  const groupNames = Object.keys(org.groups);
  groupNames.forEach((groupName, gi) => {
    const group = org.groups[groupName];
    const isLastGroup = gi === groupNames.length - 1;
    const gPrefix = isLastGroup ? '└── ' : '├── ';
    const gChild = isLastGroup ? '    ' : '│   ';

    const leadDomain = agentMap.get(group.lead)?.domain;
    const leadSuffix = leadDomain ? ` (${leadDomain})` : '';
    lines.push(`${gPrefix}${groupName} — ${group.description || ''}`);
    lines.push(`${gChild}lead: ${group.lead}${leadSuffix}`);

    if (group.subgroups) {
      const subNames = Object.keys(group.subgroups);
      subNames.forEach((subName, si) => {
        const sub = group.subgroups![subName];
        const isLastSub = si === subNames.length - 1;
        const sPrefix = isLastSub ? '└── ' : '├── ';
        const sChild = isLastSub ? '    ' : '│   ';

        lines.push(`${gChild}${sPrefix}${subName} — ${sub.description || ''}`);

        sub.members.forEach((member, mi) => {
          const memberDomain = agentMap.get(member)?.domain;
          const memberSuffix = memberDomain ? ` (${memberDomain})` : '';
          const mPrefix = mi === sub.members.length - 1 ? '└── ' : '├── ';
          lines.push(`${gChild}${sChild}${mPrefix}${member}${memberSuffix}`);
        });
      });
    }
  });

  lines.push('```');
  lines.push('');

  // Group details
  lines.push('## Groups');
  lines.push('');

  for (const [groupName, group] of Object.entries(org.groups)) {
    lines.push(`### ${groupName}`);
    if (group.description) lines.push(`${group.description}`);
    lines.push('');

    const leadAgent = agentMap.get(group.lead);
    lines.push(`**Lead:** ${group.lead} — ${leadAgent?.description || ''}`);
    lines.push('');

    if (group.subgroups) {
      for (const [subName, sub] of Object.entries(group.subgroups)) {
        lines.push(`**${subName}** — ${sub.description || ''}`);
        lines.push('| Agent | Description |');
        lines.push('|-------|-------------|');
        for (const member of sub.members) {
          const a = agentMap.get(member);
          lines.push(`| ${member} | ${a?.description || ''} |`);
        }
        lines.push('');
      }
    }
  }

  // Tags
  if (org.tags && Object.keys(org.tags).length > 0) {
    lines.push('## Tags');
    lines.push('');
    lines.push('Shared capabilities and technologies across agents.');
    lines.push('');
    lines.push('| Tag | Agents |');
    lines.push('|-----|--------|');
    for (const [tag, members] of Object.entries(org.tags)) {
      lines.push(`| ${tag} | ${members.join(', ')} |`);
    }
    lines.push('');

    // Reverse lookup: agent → tags
    lines.push('### Agent Tags');
    lines.push('');
    lines.push('| Agent | Tags |');
    lines.push('|-------|------|');
    const agentTags = new Map<string, string[]>();
    for (const [tag, members] of Object.entries(org.tags)) {
      for (const member of members) {
        if (!agentTags.has(member)) agentTags.set(member, []);
        agentTags.get(member)!.push(tag);
      }
    }
    for (const [agent, tags] of [...agentTags.entries()].sort()) {
      lines.push(`| ${agent} | ${tags.join(', ')} |`);
    }
    lines.push('');
  }

  // Who to ask
  lines.push('## Who to Ask');
  lines.push('');
  lines.push('| Topic | Ask |');
  lines.push('|-------|-----|');
  for (const [groupName, group] of Object.entries(org.groups)) {
    const allMembers = [group.lead, ...getGroupMembers(group).filter(m => m !== group.lead)];
    lines.push(`| ${group.description || groupName} | ${allMembers.join(', ')} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a short org context string for a specific agent.
 */
export function generateAgentOrgContext(
  agentName: string,
  org: OrgConfig,
): string {
  const parts: string[] = [];

  // Find group role
  for (const [groupName, group] of Object.entries(org.groups)) {
    const isLead = group.lead === agentName;
    const allMembers = getGroupMembers(group);
    const isMember = allMembers.includes(agentName);

    if (isLead) {
      const members = allMembers.filter(m => m !== agentName);
      parts.push(`You are the **lead** of the **${groupName}** group (${group.description || ''}). Your team members: ${members.join(', ')}.`);
    } else if (isMember) {
      // Find which subgroup
      if (group.subgroups) {
        for (const [subName, sub] of Object.entries(group.subgroups)) {
          if (sub.members.includes(agentName)) {
            const peers = sub.members.filter(m => m !== agentName);
            const peerStr = peers.length > 0 ? ` Peers: ${peers.join(', ')}.` : '';
            parts.push(`You are in the **${groupName}** group, **${subName}** subgroup (${sub.description || ''}). Your group lead: ${group.lead}.${peerStr}`);
            break;
          }
        }
      }
    }
  }

  // Find tags
  if (org.tags) {
    const myTags: string[] = [];
    for (const [tag, members] of Object.entries(org.tags)) {
      if (members.includes(agentName)) myTags.push(tag);
    }
    if (myTags.length > 0) {
      parts.push(`Your tags: ${myTags.join(', ')}.`);
    }
  }

  return parts.join(' ');
}
