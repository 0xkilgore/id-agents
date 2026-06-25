// RF3 — observability-eval decision-support module.
//
// Decision-support ONLY: nothing in the codebase imports this at run time. It
// encodes the RF3 eval (Promptfoo + Langfuse as the foundation for a Kapelle
// Observe/Audit paid tier; adopt-vs-build; cost) as a typed, tested capability/
// cost catalog + a pure stack recommender, so the eventual adopt-vs-build
// decision rests on a versioned artifact instead of prose. Deleting this
// directory changes zero runtime behavior. Sibling of src/exec-sandbox/ (RF1).

export * from "./types.js";
export { LANGFUSE, PROMPTFOO, OPENTELEMETRY, USAGE_METER, DEFAULT_CATALOG } from "./catalog.js";
export {
  recommendStack,
  computeAdoptVsBuild,
  requiredCapabilities,
  adoptMonthlyUsd,
  buildOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type RecommendOptions,
} from "./recommend.js";
