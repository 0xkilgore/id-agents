// Continuous Orchestration — roadmap import.
//
// Parses the prose roadmap markdown into structured backlog candidates. The
// roadmap is human prose (track tables with status text, owners, placeholders),
// NOT a machine-readable dispatch queue — so every imported item lands as
// `needs_review` (NEVER `ready`). A human/approval gate (promoteToReady) turns a
// reviewed item into admissible work, attaching to_agent + dispatch_body. The
// daemon never fires straight off this parse.

import type { NewBacklogItem } from "./storage.js";

/** Matches a track/sub-track tag, e.g. T-CKPT.1, T-ORCH.2, T15.4, T11. */
const TRACK_TAG = /\bT-?(?:[A-Z]{1,6}|\d{1,3})(?:\.\d+)?\b/;

function stripMarkdown(cell: string): string {
  return cell
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isNorthStar(text: string): boolean {
  return /north\s*star|liz|T15\b/i.test(text);
}

export function normalizeRoadmapLogicalKeyPart(text: string): string {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function roadmapLogicalKey(input: { track: string; title: string }): string {
  return `roadmap:${normalizeRoadmapLogicalKeyPart(input.track)}:${normalizeRoadmapLogicalKeyPart(input.title)}`;
}

export interface RoadmapImportResult {
  items: NewBacklogItem[];
  /** Track tags seen, for the import summary. */
  tracks: string[];
}

/**
 * Extract backlog candidates from roadmap markdown. Conservative: only table
 * rows whose first cell carries a track tag become items. Deterministic +
 * pure; deduplicates by normalized title.
 */
export function parseRoadmapToBacklog(
  markdown: string,
  opts: { team_id?: string; source_ref: string },
): RoadmapImportResult {
  const items: NewBacklogItem[] = [];
  const seenTitles = new Set<string>();
  const tracks = new Set<string>();

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    // Markdown table data rows only.
    if (!line.startsWith("|") || !line.includes("|", 1)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const firstCell = stripMarkdown(cells[0]);
    // Skip header/separator rows.
    if (!firstCell || /^[-: ]+$/.test(cells[0]) || /^(sub-track|track|item|primitive|question|window|panel|mode|concept|field|failure)\b/i.test(firstCell)) {
      continue;
    }
    const tagMatch = firstCell.match(TRACK_TAG);
    if (!tagMatch) continue;

    const tag = tagMatch[0];
    // Title: prefer the descriptive part after an em/en dash, else the cell.
    const dashSplit = firstCell.split(/—|–| - /);
    const title = stripMarkdown(dashSplit.length > 1 ? dashSplit.slice(1).join(" - ") : firstCell);
    const dedupKey = `${tag}:${title}`.toLowerCase();
    if (!title || seenTitles.has(dedupKey)) continue;
    seenTitles.add(dedupKey);
    tracks.add(tag);

    items.push({
      team_id: opts.team_id ?? "default",
      logical_key: roadmapLogicalKey({ track: tag, title }),
      title: `${tag} — ${title}`.slice(0, 200),
      track: tag,
      readiness_state: "needs_review", // human gate required before READY
      risk_class: "build",
      is_north_star: isNorthStar(firstCell + " " + cells.join(" ")),
      source_refs: [opts.source_ref],
      // to_agent + dispatch_body intentionally null: filled at the approval gate.
    });
  }

  return { items: [...items], tracks: [...tracks] };
}
