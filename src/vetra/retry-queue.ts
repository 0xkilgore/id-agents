import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PendingVetraOp } from "./types.js";

const pendingPath = process.env.ID_VETRA_PENDING_PATH ?? "/Users/kilgore/Dropbox/Code/cane/id-agents/data/vetra-pending-ops.jsonl";
const deadLetterPath = process.env.ID_VETRA_DEAD_LETTER_PATH ?? "/Users/kilgore/Dropbox/Code/cane/id-agents/data/vetra-dead-letter.jsonl";

function ensureDir(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export const retryQueue = {
  pendingPath,
  deadLetterPath,
  appendPending(entry: PendingVetraOp) {
    ensureDir(pendingPath);
    appendFileSync(pendingPath, JSON.stringify(entry) + "\n");
  },
  appendDeadLetter(entry: PendingVetraOp) {
    ensureDir(deadLetterPath);
    appendFileSync(deadLetterPath, JSON.stringify(entry) + "\n");
  },
  readPending(): PendingVetraOp[] {
    try {
      return readFileSync(pendingPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  },
  rewritePending(entries: PendingVetraOp[]) {
    ensureDir(pendingPath);
    const nextPath = pendingPath + ".tmp";
    writeFileSync(nextPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
    renameSync(nextPath, pendingPath);
  },
};
