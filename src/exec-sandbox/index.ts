// RF1 — exec-sandbox decision-support module.
//
// Decision-support ONLY: nothing in the codebase imports this at run time. It
// encodes the RF1 eval (E2B vs Daytona; integrate-vs-operate-own; cost) as a
// typed, tested capability/cost catalog + a pure recommender, so the eventual
// integration decision rests on a versioned artifact instead of prose. Deleting
// this directory changes zero runtime behavior — that is what makes it the
// safest reversible "ship it" for a research-shaped item.

export * from "./types.js";
export { E2B, DAYTONA, LOCAL_PROCESS, DEFAULT_CATALOG } from "./catalog.js";
export {
  recommendProvider,
  compareIntegrateVsOperate,
  estimateHostedMonthlyUsd,
  estimateOperateOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
  type CostAssumptions,
  type RecommendOptions,
} from "./recommend.js";
