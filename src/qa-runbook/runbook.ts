// T-QA.8 — assemble the canonical QA runbook from the shipped T-QA substrate.
//
// The taxonomy + regression sections are DERIVED from the code (CANONICAL_TAXONOMY
// and FAILURE_MODES), so the runbook cannot list a stale set — the drift tests
// enforce it. The workflow/cadence sections (per-agent reqs, Vercel preview,
// Sentinel cadence) are grounded in the roadmap with their real status flags.

import { CANONICAL_TAXONOMY, promotionGatingCategories } from "../test-taxonomy/index.js";
import { FAILURE_MODES } from "../regression-coverage/index.js";
import type { QaRunbook, RunbookSection } from "./types.js";

function taxonomySection(): RunbookSection {
  const body = [
    "The six canonical test categories (`src/test-taxonomy`), fastest/most-local first:",
    "",
    ...CANONICAL_TAXONOMY.map(
      (c) =>
        `- **${c.name}** (\`${c.id}\`) — ${c.role} _Gates promotion: ${c.gates_promotion ? "yes" : "conditional"}; phases: ${c.run_phases.join(", ")}; invoke: \`${c.invocation.command}\`._`,
    ),
  ];
  return { id: "test-taxonomy", title: "1. Test taxonomy", track: "T-QA.1", status: "live", body };
}

function promotionGateSection(): RunbookSection {
  const gating = promotionGatingCategories();
  const body = [
    "Pre-promotion gate (CLAUDE.md). All three must pass before any branch is promoted to `main`:",
    "",
    "1. **Unit/regression**: `npm test` (vitest) — exit 0, all tests pass.",
    "2. **Production build**: `npm run build` (tsc strict) — exit 0, no TypeScript errors.",
    "3. **Dist artifacts**: `ls dist/<module>/` confirms compiled `.js` present.",
    "",
    `Categories whose failure gates promotion: ${gating.map((c) => `\`${c}\``).join(", ")}.`,
    "vitest (swc, loose) passing is NOT sufficient — a clean tsc build is required.",
    "Promote via `id-agents promote-to-main --smoke \"npm run build && npm test\"`.",
  ];
  return { id: "promotion-gate", title: "2. Promotion gate", track: "T-QA.1/Spec 054", status: "live", body };
}

function regressionRuleSection(): RunbookSection {
  const body = [
    "Standing rule (`src/regression-coverage`): every typed failure mode must have a",
    "regression test before its bug can reach `closed` (the bug-squash-log §4 gate).",
    "A bug closed without a `regression_test_ref` — or with a ref that is not a real",
    "test file — is a BLOCK violation; closing under the `other` mode is a WARN.",
    "",
    "Catalogued failure modes:",
    "",
    ...FAILURE_MODES.map((m) => `- **\`${m.id}\`** — ${m.description} _(e.g. ${m.example})_`),
  ];
  return { id: "regression-coverage", title: "3. Regression-coverage requirement", track: "T-QA.5", status: "live", body };
}

function escapeHatchSection(): RunbookSection {
  const body = [
    "When a flaky or UNRELATED red test would block an otherwise-clean promotion",
    "(the canonical case: a better-sqlite3 ABI break or a port-binding integration",
    "flake reddening the full `npm test`), do NOT fall back to a manual force-push.",
    "Use the T-QA.7 escape hatch (`src/cli/smoke-exempt.ts`):",
    "",
    "```",
    "id-agents promote-to-main --repo $REPO --branch $BR --execute \\",
    "  --smoke \"npm run build && npm test\" \\",
    "  --smoke-exempt \"**/remote-heartbeat.test.ts\"",
    "```",
    "",
    "If EVERY failing test file matches an exempt glob, the gate downgrades",
    "abort→proceed and records `smoke.gate=passed_with_exempt_failures` +",
    "`smoke.exempt_failures` in the promotion JSON (operator-visible). If ANY",
    "non-exempt test fails — or none can be parsed — it aborts as before (exit 9).",
    "Always confirm the exempted test is green IN ISOLATION before exempting it.",
  ];
  return { id: "escape-hatches", title: "4. Escape hatches (unrelated red suite)", track: "T-QA.7", status: "live", body };
}

function perAgentSection(): RunbookSection {
  const body = [
    "Each owning agent declares its required pre-promotion test set + threshold;",
    "Spec 054 enforces the declared set per agent. Until the per-agent declarations",
    "are ratified, the baseline for every code agent (Roger/Cane) is the §2 gate",
    "(green `npm test` + clean tsc build + dist). Frontend (Regina) additionally",
    "owns live-UI verification (§5). Paper agents (Maestra/CTO) are gated by no",
    "code-test category — an unrelated red suite must not block a paper promotion.",
  ];
  return { id: "per-agent-requirements", title: "5. Per-agent pre-promotion requirements", track: "T-QA.2", status: "phase2", body };
}

function vercelPreviewSection(): RunbookSection {
  const body = [
    "**HELD (HC-15): needs a Vercel preview token from Chris (~5 min).** Once wired,",
    "Sentinel hits the per-PR preview URL and runs smoke checks against the live UI,",
    "so verification never has to say \"flag for live-preview check\". Until the token",
    "lands, live-UI assertions are manual in the kapelle-site (Regina) lane; backend",
    "changes a UI depends on are smoke/integration-gated here.",
  ];
  return { id: "vercel-preview", title: "6. Live-UI / Vercel preview workflow", track: "T-QA.3", status: "held", body };
}

function sentinelCadenceSection(): RunbookSection {
  const body = [
    "**Phase 2.** Standing verification cadence: the `id-agents-parity-weekly` loop",
    "(T-DEPLOY.6) runs the `id-agents-compat` suite + reviews the parity ledger; the",
    "Sentinel verification loop (L8) runs 2h/weekly/biweekly. Promote these from",
    "ad-hoc to typed Loop runtime once the T10 substrate matures, budgeted via the",
    "T-ORCH orchestration daemon. Sentinel retries under provider rate-limit rather",
    "than re-firing (T-QA.4).",
  ];
  return { id: "sentinel-cadence", title: "7. Standing verification cadence", track: "T-QA.6", status: "phase2", body };
}

/** Assemble the canonical runbook. Pure. */
export function buildQaRunbook(): QaRunbook {
  return {
    title: "Kapelle QA & Testing Runbook",
    generated_note:
      "Generated from code (`src/qa-runbook`). The taxonomy + regression sections are derived from " +
      "`src/test-taxonomy` and `src/regression-coverage`; edit those, then regenerate. Do not hand-edit.",
    sections: [
      taxonomySection(),
      promotionGateSection(),
      regressionRuleSection(),
      escapeHatchSection(),
      perAgentSection(),
      vercelPreviewSection(),
      sentinelCadenceSection(),
    ],
  };
}
