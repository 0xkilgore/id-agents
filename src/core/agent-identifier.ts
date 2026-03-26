// SPDX-License-Identifier: MIT
/**
 * Agent Identifier utilities
 *
 * Agent identities are ENS domain names such as "agent-5.sep.xid.eth" or
 * "myagent.eth".  The ENS domain is the primary and only identity format.
 *
 * Before registration: agent name is the local config name (e.g., "x", "gateway").
 * After registration: agent name becomes the full ENS domain (e.g., "agent-5.sep.xid.eth").
 *
 * Examples:
 *   - agent-5.sep.xid.eth
 *   - myagent.eth
 *   - gateway (unregistered, local name only)
 */

export interface AgentIdentifier {
  alias?: string;       // Human readable local name (e.g., "gateway")
  tokenId?: string;     // Token ID / label (e.g., "agent-5")
  domain?: string;      // ENS domain name (e.g., "agent-5.sep.xid.eth") - primary identity
}

export interface ParsedAgentRef {
  alias?: string;
  tokenId?: string;
  domain?: string;      // ENS domain name if the ref looks like one
  isFullySpecified: boolean;  // Has domain
}

/**
 * Parse an agent reference string into components
 *
 * Supported formats:
 *   - agent-5.sep.xid.eth (ENS domain – primary)
 *   - myagent.eth (ENS domain – primary)
 *   - alias (lookup by local name)
 */
export function parseAgentRef(ref: string): ParsedAgentRef {
  const trimmed = ref.trim().toLowerCase();

  // ----- ENS domain detection -----
  // If the reference ends with ".eth" treat it as an ENS domain name.
  if (trimmed.endsWith('.eth')) {
    // Extract alias from the first label (everything before the first dot)
    const firstDot = trimmed.indexOf('.');
    const alias = firstDot !== -1 ? trimmed.slice(0, firstDot) : undefined;

    return {
      alias,
      domain: trimmed,
      isFullySpecified: true,
    };
  }

  // ----- Local alias -----
  const alias = trimmed || undefined;

  // Validate alias format (URI label rules)
  if (alias && !isValidAlias(alias)) {
    throw new Error(`Invalid alias format: ${alias}. Must use only lowercase letters, digits, and hyphens, and not start or end with a hyphen.`);
  }

  return { alias, isFullySpecified: false };
}

/**
 * Format an agent identifier into string form
 *
 * Returns the ENS domain if available, otherwise the local alias.
 */
export function formatAgentId(id: AgentIdentifier): string {
  if (id.domain) {
    return id.domain;
  }
  return id.alias || id.tokenId || '';
}

/**
 * Format an agent for display
 *
 * Returns the ENS domain if available, otherwise the local alias.
 */
export function formatAgentDisplay(
  id: AgentIdentifier
): string {
  if (id.domain) {
    return id.domain;
  }
  return id.alias || id.tokenId || '';
}

/**
 * Check if an alias is valid per URI label rules
 * - Only lowercase letters (a-z), digits (0-9), and hyphens (-)
 * - Must not start or end with a hyphen
 */
export function isValidAlias(alias: string): boolean {
  if (!alias || alias.length === 0) {
    return false;
  }

  // Check for valid characters
  if (!/^[a-z0-9-]+$/.test(alias)) {
    return false;
  }

  // Must not start or end with hyphen
  if (alias.startsWith('-') || alias.endsWith('-')) {
    return false;
  }

  return true;
}

/**
 * Normalize an alias to valid format
 * - Lowercase
 * - Replace invalid chars with hyphens
 * - Remove leading/trailing hyphens
 */
export function normalizeAlias(name: string): string {
  // ENS domain names should not be mangled
  if (name.endsWith('.eth')) return name.toLowerCase();
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Result from resolving an agent reference
 */
export interface ResolveResult {
  agents: AgentMatch[];
  ambiguous: boolean;
  warning?: string;
}

export interface AgentMatch {
  id: string;           // Internal UUID
  alias?: string;
  tokenId?: string;
  domain?: string;      // ENS domain name
  port?: number;
  status?: string;
}

/**
 * Build a warning message for ambiguous matches
 */
export function buildAmbiguityWarning(ref: string, matches: AgentMatch[]): string {
  const lines = [`Multiple agents match "${ref}":`];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const display = m.domain || m.alias || m.id || '?';
    lines.push(`  ${i + 1}. ${display}`);
  }

  lines.push('');
  lines.push('Use a more specific identifier (e.g., ENS domain or agent ID).');

  return lines.join('\n');
}
