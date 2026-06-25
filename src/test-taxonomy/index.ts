// T-QA.1 — Test taxonomy module.
//
// Reference/decision-support ONLY: nothing imports this at run time. It is the
// canonical test taxonomy (roadmap-reset §4.7) expressed as typed data + a
// classifier, so the taxonomy is versioned, queryable, and tooling-consumable
// instead of living only in a prose doc. Deleting this directory changes zero
// runtime behavior. A follow-up (T-QA.2 per-agent pre-promotion verification)
// can consume it; that wiring is intentionally not done here.

export * from "./types.js";
export {
  CANONICAL_TAXONOMY,
  UNIT,
  INTEGRATION,
  SMOKE,
  REGRESSION,
  LIVE_UI,
  CROSS_SYSTEM,
  getCategory,
  promotionGatingCategories,
} from "./taxonomy.js";
export { classifyTest, invocationFor, gatesPromotion, describeTest } from "./classify.js";
