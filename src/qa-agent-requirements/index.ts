// T-QA.2 — Per-agent pre-promotion verification requirements module.
//
// Reference/decision-support ONLY: nothing imports this at run time. A typed
// catalog of each agent's required pre-promotion test set + a pure checker, so
// Spec 054 can enforce per-agent requirements (the P-2 fix) instead of one
// uniform gate. Pairs with T-QA.7 smoke-exempt (what an unrelated red suite need
// NOT block) and T-QA.1 test-taxonomy (the category vocabulary). Deleting this
// directory changes zero runtime behavior.

export * from "./types.js";
export { AGENT_PROMOTION_REQUIREMENTS, getRequirement } from "./requirements.js";
export { checkAgentPromotion } from "./check.js";
