// OSS-lift eval — artifact-store decision-support module.
//
// Decision-support ONLY: nothing in the codebase imports this at run time. It
// encodes the paperless-ngx (GPL-3.0) vs own-doc-model-substrate eval for the
// artifact-store lane as a typed, tested capability/cost catalog + a pure
// recommender, so the adopt-vs-extend decision rests on a versioned artifact
// instead of prose. Deleting this directory changes zero runtime behavior.
// Sibling of src/exec-sandbox/ (RF1), src/observability-eval/ (RF3),
// src/gateway-eval/ (RF2).

export * from "./types.js";
export { PAPERLESS_NGX, OWN_DOC_MODEL, DEFAULT_CATALOG } from "./catalog.js";
export {
  recommendArtifactStore,
  computeAdoptVsExtend,
  requiredCapabilities,
  adoptMonthlyUsd,
  extendOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type RecommendOptions,
} from "./recommend.js";
