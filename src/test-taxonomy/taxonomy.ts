// T-QA.1 — the canonical test taxonomy (the data).
//
// Grounded in id-agents' ACTUAL conventions (not invented): vitest under
// tests/unit/**, tests/integration/** behind `npm run test:e2e`, the deploy-guard
// smoke path (src/deploy-guard/smoke.ts), *-parity.test.ts + the T-DEPLOY.6
// weekly id-agents↔Kapelle parity lane, and live-UI in kapelle-site (Regina's
// lane). The CLAUDE.md pre-promotion checklist (vitest + tsc build + dist) is the
// canonical promotion gate the `gates_promotion` flags encode.

import type { TestCategory, TestCategoryDef } from "./types.js";

export const UNIT: TestCategoryDef = {
  id: "unit",
  name: "Unit",
  role: "Catch logic regressions in a single module in isolation — the fastest, most local signal.",
  scope: "One module/function with its dependencies stubbed or in-memory (e.g. an in-memory SqliteAdapter).",
  invocation: {
    command: "npm test",
    path_globs: ["tests/unit/**/*.test.ts"],
    requires: ["node 23 (better-sqlite3 ABI)"],
    note: "Runs via scripts/run-vitest.mjs. The bulk of the suite (~hundreds of files).",
  },
  run_phases: ["local", "ci", "pre_promotion"],
  gates_promotion: true,
  speed: "fast",
  examples: ["tests/unit/outputs-reactions-feedback.test.ts", "tests/unit/gateway-eval-recommend.test.ts"],
};

export const INTEGRATION: TestCategoryDef = {
  id: "integration",
  name: "Integration",
  role: "Catch breakage across module boundaries and against real adapters/transports the unit layer stubs out.",
  scope: "Multiple modules wired together over real seams (Express routes + a real SqliteAdapter, the external manager API).",
  invocation: {
    command: "npm run test:e2e",
    path_globs: ["tests/integration/**/*.test.ts", "tests/unit/**/*-integration.test.ts"],
    requires: ["ID_CONTROL_API_KEY for external-manager integration tests"],
    note: "Some integration-style tests also live in tests/unit/ with a -integration suffix and run under `npm test`.",
  },
  run_phases: ["ci", "pre_promotion"],
  gates_promotion: true,
  speed: "medium",
  examples: ["tests/integration/agent-lifecycle.test.ts", "tests/unit/dispatch-recovery-integration.test.ts"],
};

export const SMOKE: TestCategoryDef = {
  id: "smoke",
  name: "Smoke",
  role: "Confirm a freshly built/deployed artifact boots and serves the basic happy path — a shallow go/no-go.",
  scope: "The running service end-to-end, breadth over depth (does it start, build clean, answer a basic request).",
  invocation: {
    command: 'id-agents promote-to-main --smoke "npm run build && npm test"',
    path_globs: ["src/deploy-guard/smoke.ts"],
    note: "The promotion helper gates on a smoke command; deploy-guard runs post-deploy smoke + ABI check + rollback.",
  },
  run_phases: ["pre_promotion", "post_deploy"],
  gates_promotion: true,
  speed: "fast",
  examples: ["src/deploy-guard/smoke.ts", "tests/unit/deploy-guard.test.ts"],
};

export const REGRESSION: TestCategoryDef = {
  id: "regression",
  name: "Regression",
  role: "Catch reintroduced or collateral breakage by re-running the EXISTING corpus broadly, not just the changed files.",
  scope: "The full unit + integration suite around the change (the 'N tests still green, 0 regressions' discipline).",
  invocation: {
    command: "npm test",
    path_globs: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    note: "Regression is a re-run discipline over the whole suite, not a distinct file-naming convention.",
  },
  run_phases: ["ci", "pre_promotion"],
  gates_promotion: true,
  speed: "medium",
  examples: ["the full `npm test` run before any promotion to main"],
};

export const LIVE_UI: TestCategoryDef = {
  id: "live_ui",
  name: "Live-UI",
  role: "Catch UI/UX breakage that only appears in a real rendered browser (layout, interaction, console wiring).",
  scope: "The kapelle-site console rendered end-to-end against the live backend.",
  invocation: {
    command: "(kapelle-site — Regina's lane: Playwright / manual browser verification)",
    path_globs: ["kapelle-site/**/*.spec.ts"],
    requires: ["a running backend + the built frontend"],
    note: "Owned by the kapelle-site single-writer lane (Regina), not id-agents. Backend changes that a UI depends on are smoke/integration-gated here; the UI assertion itself runs there.",
  },
  run_phases: ["pre_promotion", "scheduled"],
  gates_promotion: true,
  speed: "slow",
  examples: ["kapelle-site console reaction buttons + acted-upon chip (C0 frontend)"],
};

export const CROSS_SYSTEM: TestCategoryDef = {
  id: "cross_system",
  name: "Cross-system",
  role: "Catch divergence between two systems that must stay in contract/parity (id-agents ↔ Kapelle).",
  scope: "Two systems' shared contracts/data — schema, projections, and read-model parity across the boundary.",
  invocation: {
    command: "npm test (parity suites) + the T-DEPLOY.6 weekly id-agents↔Kapelle parity lane",
    path_globs: ["tests/unit/**/*-parity.test.ts", "**/*cross-system*.test.ts"],
    note: "Runs on a schedule (T-DEPLOY.6 weekly lane) and pre-promotion for contract-touching changes.",
  },
  run_phases: ["pre_promotion", "scheduled"],
  gates_promotion: false, // conditional: gates only changes that touch the shared contract
  speed: "slow",
  examples: ["tests/unit/inbox-projection-parity.test.ts", "T-DEPLOY.6 weekly parity lane"],
};

/** The canonical taxonomy, ordered fastest/most-local → slowest/most-integrated. */
export const CANONICAL_TAXONOMY: TestCategoryDef[] = [
  UNIT,
  INTEGRATION,
  SMOKE,
  REGRESSION,
  LIVE_UI,
  CROSS_SYSTEM,
];

const BY_ID = new Map<TestCategory, TestCategoryDef>(CANONICAL_TAXONOMY.map((c) => [c.id, c]));

export function getCategory(id: TestCategory): TestCategoryDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown test category: ${id}`);
  return def;
}

/** The categories whose failure blocks promotion to main (the CLAUDE.md gate). */
export function promotionGatingCategories(): TestCategory[] {
  return CANONICAL_TAXONOMY.filter((c) => c.gates_promotion).map((c) => c.id);
}
