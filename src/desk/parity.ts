// Kapelle Desk — parity gate (Desk.md tray vs desk_items substrate).
//
// Minimal v1: reports ok when no markdown source is configured or counts align.

import { readFileSync, existsSync } from "node:fs";
import type { DeskItemRow } from "./types.js";

export interface DeskParityReport {
  status: "ok" | "fallback" | "drift";
  checked_at: string;
  markdown_count: number;
  substrate_count: number;
  drift: string[];
}

/** Count bullet lines under the AWAITING YOU / On your desk tray headings in Desk.md. */
export function countDeskMarkdownTrayLines(markdown: string): number {
  const lines = markdown.split("\n");
  let inTray = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+📥\s+(AWAITING YOU|On your desk)/i.test(line)) {
      inTray = true;
      continue;
    }
    if (inTray && /^##\s+/.test(line)) break;
    if (inTray && /^\s*[-*•]\s+/.test(line)) count += 1;
  }
  return count;
}

export function computeDeskParity(
  substrateRows: DeskItemRow[],
  markdownSourcePath: string | null,
  checkedAt: string,
): DeskParityReport {
  const onDesk = substrateRows.filter(
    (r) => r.desk_class === "tray" && r.tray_state === "on_desk",
  );
  if (!markdownSourcePath || !existsSync(markdownSourcePath)) {
    return {
      status: "ok",
      checked_at: checkedAt,
      markdown_count: 0,
      substrate_count: onDesk.length,
      drift: [],
    };
  }
  const markdown = readFileSync(markdownSourcePath, "utf8");
  const markdownCount = countDeskMarkdownTrayLines(markdown);
  const substrateCount = onDesk.length;
  const drift: string[] = [];
  // Substrate may be a superset (federated artifacts/decisions); only drift when
  // markdown has MORE tray lines than persisted desk_items.
  if (markdownCount > substrateCount) {
    drift.push(
      `markdown tray has ${markdownCount} items but substrate has ${substrateCount} on_desk rows`,
    );
  }
  return {
    status: drift.length ? "drift" : "ok",
    checked_at: checkedAt,
    markdown_count: markdownCount,
    substrate_count: substrateCount,
    drift,
  };
}
