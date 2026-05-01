// Short names for model strings shown in the TUI agents table.
// Add new entries here as model names appear — the heuristic fallback
// below handles unknown claude-* names automatically, but explicit
// entries always win and let us pick nicer abbreviations than the
// algorithm would produce.

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  // Anthropic Claude
  'claude-opus-4-6': 'opus-4-6',
  'claude-opus-4-7': 'opus-4-7',
  'claude-sonnet-4-6': 'sonn-4-6',

  // OpenAI Codex (already short, but pinned for stability)
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.5': 'gpt-5.5',

  // Cursor / Composer
  'composer-2': 'comp-2',
};

/**
 * Abbreviate a model name for compact display.
 *
 * Lookup order:
 *   1. Explicit entry in MODEL_ABBREVIATIONS — wins.
 *   2. Heuristic for `claude-<word>-<rest>`: strip the `claude-` prefix,
 *      strip trailing `-YYYYMMDD` date stamps, truncate the first word
 *      to 4 chars, keep the rest. So `claude-haiku-4-5-20251001` → `haik-4-5`.
 *   3. Otherwise the input unchanged.
 *
 * Returns `—` for missing/empty input.
 */
export function abbrevModel(model: string | undefined): string {
  if (!model) return '—';
  if (model in MODEL_ABBREVIATIONS) return MODEL_ABBREVIATIONS[model];

  // Strip a trailing -YYYYMMDD date stamp.
  const cleaned = model.replace(/-\d{8}$/, '');

  if (cleaned.startsWith('claude-')) {
    const rest = cleaned.slice('claude-'.length);
    const m = rest.match(/^([a-z]+)(.*)$/);
    if (m) {
      const word = m[1].slice(0, 4);
      return `${word}${m[2]}`;
    }
  }

  return cleaned;
}
