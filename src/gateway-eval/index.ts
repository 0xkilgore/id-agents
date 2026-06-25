// RF2 — model-gateway decision-support module.
//
// Decision-support ONLY: nothing in the codebase imports this at run time. It
// encodes the RF2 eval (Portkey gateway pattern for provider-neutral routing /
// guardrails / observability; adopt-vs-extend-own; cost) as a typed, tested
// capability/cost catalog + a pure recommender, so the adopt-vs-extend decision
// rests on a versioned artifact instead of prose. Deleting this directory
// changes zero runtime behavior. Sibling of src/exec-sandbox/ (RF1) and
// src/observability-eval/ (RF3).

export * from "./types.js";
export { PORTKEY, LITELLM, OPENROUTER, OWN_MODEL_POLICY, DEFAULT_CATALOG } from "./catalog.js";
export {
  recommendGateway,
  computeAdoptVsExtend,
  requiredCapabilities,
  adoptMonthlyUsd,
  extendOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type RecommendOptions,
} from "./recommend.js";
