// T-QA.2 — the per-agent pre-promotion requirement catalog (the data).
//
// Grounded in the roadmap §4.7.2 (each agent declares its required set) + the
// real lanes: code agents (Roger/Cane) own the full code suite, the verifier
// (Sentinel) owns everything, the frontend agent (Regina) owns live-UI + smoke,
// and paper agents (Maestra/CTO) are gated by no code-test category. Roger's row
// is RATIFIED (authoritative for this lane); the rest are PROPOSED DEFAULTS each
// owning agent ratifies by flipping `ratified` in its own dispatch.

import type { TestCategory } from "../test-taxonomy/types.js";
import { CANONICAL_TAXONOMY } from "../test-taxonomy/index.js";
import type { AgentPromotionRequirement } from "./types.js";

const ALL_CATEGORIES: TestCategory[] = CANONICAL_TAXONOMY.map((c) => c.id);

/** Every code-test category a backend agent is accountable for. */
const CODE_CATEGORIES: TestCategory[] = ["unit", "integration", "smoke", "regression", "cross_system"];

export const AGENT_PROMOTION_REQUIREMENTS: AgentPromotionRequirement[] = [
  {
    agent: "roger",
    required_categories: [...CODE_CATEGORIES],
    threshold: "all_pass_plus_tsc_build",
    ratified: true, // Roger's own lane — authoritative.
    note: "Backend code agent: full code suite green + clean tsc build + dist artifacts.",
  },
  {
    agent: "cane",
    required_categories: [...CODE_CATEGORIES],
    threshold: "all_pass_plus_tsc_build",
    ratified: false,
    note: "Proposed: backend code agent, same bar as Roger. Cane ratifies its own row.",
  },
  {
    agent: "sentinel",
    required_categories: [...ALL_CATEGORIES],
    threshold: "all_pass_plus_tsc_build",
    ratified: false,
    note: "Proposed: the verifier is accountable for every category by definition.",
  },
  {
    agent: "regina",
    required_categories: ["live_ui", "smoke"],
    threshold: "all_pass",
    ratified: false,
    note: "Proposed: frontend (kapelle-site) lane is gated on live-UI + smoke, not the backend unit suite.",
  },
  {
    agent: "maestra",
    required_categories: [],
    threshold: "all_pass",
    ratified: false,
    note: "Proposed: paper agent — no code-test category gates a prose/runbook promotion.",
  },
  {
    agent: "cto",
    required_categories: [],
    threshold: "all_pass",
    ratified: false,
    note: "Proposed: scope/spec agent — no code-test category gates a scope-doc promotion.",
  },
];

const BY_AGENT = new Map(AGENT_PROMOTION_REQUIREMENTS.map((r) => [r.agent, r]));

/**
 * The requirement for `agent`. Unknown agent → conservative default: every
 * category required + tsc build (so an unrecognized lane is never under-gated).
 */
export function getRequirement(agent: string): AgentPromotionRequirement {
  const key = agent.trim().toLowerCase();
  const found = BY_AGENT.get(key);
  if (found) return { ...found, required_categories: [...found.required_categories] };
  return {
    agent: key,
    required_categories: [...ALL_CATEGORIES],
    threshold: "all_pass_plus_tsc_build",
    ratified: false,
    note: "Unknown agent — conservative default (every category + tsc build).",
  };
}
