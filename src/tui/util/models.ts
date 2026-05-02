// Short names for model strings shown in the TUI agents table.
//
// Maintain this table by hand. When a new model appears, add an entry.
// Until then the row will display the full model string and visibly
// overflow the column — that's a feature, not a bug, because it makes
// missing entries obvious.

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  // Anthropic Claude
  'claude-opus-4-20250514': 'opus-4-0',
  'claude-opus-4-5-20250514': 'opus-4-5',
  'claude-opus-4-6': 'opus-4-6',
  'claude-opus-4-7': 'opus-4-7',
  'claude-sonnet-4-5-20250514': 'sonn-4-5',
  'claude-sonnet-4-6': 'sonn-4-6',
  'claude-haiku-4-5-20251001': 'haiku-4-5',

  // OpenAI Codex
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.5': 'gpt-5.5',

  // Cursor / Composer
  'composer-2': 'comp-2',
};

/**
 * Look up the short display name for a model.
 *
 *   - In the table → returns the abbreviation.
 *   - Not in the table → returns the input unchanged (will overflow the
 *     column, which signals "add me to the table").
 *   - Missing/empty → returns `—`.
 */
export function abbrevModel(model: string | undefined): string {
  if (!model) return '—';
  return MODEL_ABBREVIATIONS[model] ?? model;
}
