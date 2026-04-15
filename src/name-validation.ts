// SPDX-License-Identifier: MIT

const RESERVED_WORDS = new Set([
  'delete', 'list', 'create', 'deploy', 'sync', 'spawn', 'kill', 'stop',
  'start', 'rebuild', 'agents', 'status', 'schedule', 'tasks', 'team',
  'teams', 'ask', 'hey', 'news', 'register', 'configs', 'registry',
  'keys', 'meta', 'pay', 'heartbeat', 'heartbeats', 'cancel', 'clear',
  'update', 'help', 'sync-wallets', 'artifact', 'output', 'verify',
]);

const SHELL_META = /[*?[\]{}]/;
const CONTROL_OR_WHITESPACE = /[\s\x00-\x1f\x7f]/;
const MAX_LENGTH = 64;

export type NameKind = 'team' | 'agent';

export interface NameValidationResult {
  valid: boolean;
  error?: string;
}

export function validateName(name: string, kind: NameKind): NameValidationResult {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: `${kind} name cannot be empty` };
  }

  if (name.length > MAX_LENGTH) {
    return { valid: false, error: `${kind} name exceeds ${MAX_LENGTH} characters` };
  }

  if (CONTROL_OR_WHITESPACE.test(name)) {
    return { valid: false, error: `${kind} name contains whitespace or control characters` };
  }

  if (name.startsWith('-')) {
    return { valid: false, error: `${kind} name cannot start with "-" (looks like a flag)` };
  }

  if (SHELL_META.test(name)) {
    return { valid: false, error: `${kind} name contains shell metacharacters (*, ?, [, ], {, })` };
  }

  if (RESERVED_WORDS.has(name.toLowerCase())) {
    return { valid: false, error: `"${name}" is a reserved command word and cannot be used as a ${kind} name` };
  }

  return { valid: true };
}

export function getReservedWords(): string[] {
  return [...RESERVED_WORDS].sort();
}
