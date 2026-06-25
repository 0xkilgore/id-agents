// T-QA.8 — render the assembled runbook to canonical markdown. Pure + deterministic.

import type { QaRunbook } from "./types.js";
import { buildQaRunbook } from "./runbook.js";

const STATUS_BADGE: Record<string, string> = {
  live: "LIVE",
  held: "HELD",
  phase2: "PHASE 2",
};

/** Render a runbook to a canonical markdown string. Deterministic. */
export function renderRunbookMarkdown(runbook: QaRunbook = buildQaRunbook()): string {
  const out: string[] = [];
  out.push(`# ${runbook.title}`);
  out.push("");
  out.push(`> ${runbook.generated_note}`);
  out.push("");
  out.push("## Contents");
  for (const s of runbook.sections) {
    out.push(`- [${s.title}](#${s.id}) — \`${s.track}\` · ${STATUS_BADGE[s.status]}`);
  }
  out.push("");
  for (const s of runbook.sections) {
    out.push(`## ${s.title}`);
    out.push("");
    out.push(`<a id="${s.id}"></a>_Track ${s.track} · status: **${STATUS_BADGE[s.status]}**_`);
    out.push("");
    for (const line of s.body) out.push(line);
    out.push("");
  }
  // Trim a single trailing blank line for a clean EOF.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
