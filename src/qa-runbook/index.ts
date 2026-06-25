// T-QA.8 — QA-and-testing runbook module.
//
// Reference/decision-support ONLY: nothing imports this at run time. It is the
// canonical QA runbook (roadmap-reset §4.7.2) assembled from the shipped T-QA
// substrate + rendered to markdown, so the runbook is a living artifact that
// can't drift from the code it documents. Deleting this directory changes zero
// runtime behavior. Regenerate the committed doc with
// `node scripts/gen-qa-runbook.mjs`.

export * from "./types.js";
export { buildQaRunbook } from "./runbook.js";
export { renderRunbookMarkdown } from "./render.js";
