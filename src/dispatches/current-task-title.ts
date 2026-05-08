// SPDX-License-Identifier: MIT
/**
 * extractCurrentTaskTitle — pure helper to render a card-safe single
 * line from a dispatch's markdown body.
 *
 * Rules:
 *   - first non-empty line wins
 *   - strip leading markdown punctuation (`#`, `-`, `*`, ordered-list prefix)
 *   - trim surrounding whitespace
 *   - empty / whitespace-only / punctuation-only input → "Untitled dispatch"
 *   - truncate with ASCII ellipsis once over `maxLen` (default 120)
 *
 * Plan: docs/superpowers/plans/2026-05-08-vetra-readside-dashboard.md
 * Phase 1 / Task 1.
 */

const HEADING_RE = /^#{1,6}\s+/;
const BULLET_RE = /^[-*]\s+/;
const ORDERED_LIST_RE = /^\d+\.\s+/;
const PUNCTUATION_ONLY_RE = /^[#\-*\s\d.]+$/;

function stripLeadingMarkers(line: string): string {
  let out = line;
  out = out.replace(HEADING_RE, '');
  out = out.replace(BULLET_RE, '');
  out = out.replace(ORDERED_LIST_RE, '');
  return out.trim();
}

export function extractCurrentTaskTitle(bodyMarkdown: string, maxLen = 120): string {
  if (!bodyMarkdown) return 'Untitled dispatch';

  const lines = bodyMarkdown.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (PUNCTUATION_ONLY_RE.test(trimmed)) continue;
    const cleaned = stripLeadingMarkers(trimmed);
    if (!cleaned) continue;
    if (cleaned.length > maxLen) {
      return `${cleaned.slice(0, maxLen)}...`;
    }
    return cleaned;
  }
  return 'Untitled dispatch';
}
