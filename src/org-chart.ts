// SPDX-License-Identifier: MIT
/**
 * Org Chart Generator
 *
 * Generates a markdown org chart from the YAML config's `org` section.
 * Supports infinitely nested groups with leads, members, and tags.
 */

import type { OrgConfig, Group } from './config-parser.js';

interface AgentInfo {
  name: string;
  description?: string;
  domain?: string;
}

/**
 * Recursively collect all members from a node and its subgroups.
 */
function collectMembers(node: Group): string[] {
  const members = new Set<string>(node.members || []);
  if (node.lead) members.add(node.lead);
  if (node.groups) {
    for (const sub of Object.values(node.groups)) {
      for (const m of collectMembers(sub)) members.add(m);
    }
  }
  return [...members];
}

/**
 * Render an org node as ASCII tree lines (recursive).
 */
function renderTreeNode(
  name: string,
  node: Group,
  agentMap: Map<string, AgentInfo>,
  prefix: string,
  isLast: boolean,
): string[] {
  const lines: string[] = [];
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = prefix + (isLast ? '    ' : '│   ');

  lines.push(`${prefix}${connector}${name} — ${node.description || ''}`);

  if (node.lead) {
    const leadDomain = agentMap.get(node.lead)?.domain;
    const leadSuffix = leadDomain ? ` (${leadDomain})` : '';
    lines.push(`${childPrefix}lead: ${node.lead}${leadSuffix}`);
  }

  // Direct members (not in subgroups)
  const directMembers = (node.members || []).filter(m => m !== node.lead);
  const hasSubgroups = node.groups && Object.keys(node.groups).length > 0;

  directMembers.forEach((member, mi) => {
    const memberDomain = agentMap.get(member)?.domain;
    const memberSuffix = memberDomain ? ` (${memberDomain})` : '';
    const mIsLast = !hasSubgroups && mi === directMembers.length - 1;
    const mConnector = mIsLast ? '└── ' : '├── ';
    lines.push(`${childPrefix}${mConnector}${member}${memberSuffix}`);
  });

  // Subgroups (recursive)
  if (hasSubgroups) {
    const subNames = Object.keys(node.groups!);
    subNames.forEach((subName, si) => {
      const subLines = renderTreeNode(
        subName,
        node.groups![subName],
        agentMap,
        childPrefix,
        si === subNames.length - 1,
      );
      lines.push(...subLines);
    });
  }

  return lines;
}

/**
 * Render a group detail section (recursive).
 */
function renderGroupDetail(
  name: string,
  node: Group,
  agentMap: Map<string, AgentInfo>,
  depth: number,
): string[] {
  const lines: string[] = [];
  const heading = '#'.repeat(Math.min(depth + 2, 6));

  lines.push(`${heading} ${name}`);
  if (node.description) lines.push(`${node.description}`);
  lines.push('');

  if (node.lead) {
    const leadAgent = agentMap.get(node.lead);
    lines.push(`**Lead:** ${node.lead} — ${leadAgent?.description || ''}`);
    lines.push('');
  }

  // Direct members
  const directMembers = (node.members || []).filter(m => m !== node.lead);
  if (directMembers.length > 0) {
    lines.push('| Agent | Description |');
    lines.push('|-------|-------------|');
    for (const member of directMembers) {
      const a = agentMap.get(member);
      lines.push(`| ${member} | ${a?.description || ''} |`);
    }
    lines.push('');
  }

  // Recurse into subgroups
  if (node.groups) {
    for (const [subName, sub] of Object.entries(node.groups)) {
      lines.push(...renderGroupDetail(subName, sub, agentMap, depth + 1));
    }
  }

  return lines;
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
    const treeLines = renderTreeNode(
      groupName,
      org.groups[groupName],
      agentMap,
      '',
      gi === groupNames.length - 1,
    );
    lines.push(...treeLines);
  });

  lines.push('```');
  lines.push('');

  // Group details
  lines.push('## Groups');
  lines.push('');
  for (const [groupName, group] of Object.entries(org.groups)) {
    lines.push(...renderGroupDetail(groupName, group, agentMap, 1));
  }

  // Tags
  if (org.tags && Object.keys(org.tags).length > 0) {
    lines.push('## Tags');
    lines.push('');
    lines.push('| Tag | Agents |');
    lines.push('|-----|--------|');
    for (const [tag, members] of Object.entries(org.tags)) {
      lines.push(`| ${tag} | ${members.join(', ')} |`);
    }
    lines.push('');

    // Reverse lookup
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
    const allMembers = collectMembers(group);
    lines.push(`| ${group.description || groupName} | ${allMembers.join(', ')} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a short org context string for a specific agent (recursive search).
 */
export function generateAgentOrgContext(
  agentName: string,
  org: OrgConfig,
): string {
  const parts: string[] = [];

  function findInNode(nodeName: string, node: Group, groupName: string, path: string[]): void {
    const isLead = node.lead === agentName;
    const isDirect = (node.members || []).includes(agentName);
    const allMembers = collectMembers(node);

    if (isLead) {
      const team = allMembers.filter(m => m !== agentName);
      const pathStr = path.length > 0 ? ` (${path.join(' > ')})` : '';
      parts.push(`You are the **lead** of **${nodeName}**${pathStr} (${node.description || ''}). Your team: ${team.join(', ')}.`);
    } else if (isDirect) {
      const peers = (node.members || []).filter(m => m !== agentName);
      const peerStr = peers.length > 0 ? ` Peers: ${peers.join(', ')}.` : '';
      const leadStr = node.lead ? ` Lead: ${node.lead}.` : '';
      parts.push(`You are in **${nodeName}** (${node.description || ''}).${leadStr}${peerStr}`);
    }

    // Recurse into subgroups
    if (node.groups) {
      for (const [subName, sub] of Object.entries(node.groups)) {
        findInNode(subName, sub, groupName, [...path, nodeName]);
      }
    }
  }

  for (const [groupName, group] of Object.entries(org.groups)) {
    findInNode(groupName, group, groupName, []);
  }

  // Tags
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
