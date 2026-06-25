#!/usr/bin/env node
// T-QA.8: render the canonical QA runbook to docs/qa-and-testing-runbook.md from
// the compiled module. Run AFTER `npm run build` (imports dist/qa-runbook).
//   node scripts/gen-qa-runbook.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { renderRunbookMarkdown } = await import(join(root, "dist", "qa-runbook", "render.js"));

const docsDir = join(root, "docs");
mkdirSync(docsDir, { recursive: true });
const outPath = join(docsDir, "qa-and-testing-runbook.md");
writeFileSync(outPath, renderRunbookMarkdown(), "utf8");
console.log(`[gen-qa-runbook] wrote ${outPath}`);
