# Provider/runtime guard regression closeout

Dispatch: `phid:disp-b4a131907885da83`
Agent: `substrate-orch-codex`
Branch: `substrate-api-codex/provider-runtime-guard`

## Change

Added a focused admission regression for manual refuel rows that:

- target a build pool lane (`to_agent: "pool:backend"`),
- omit explicit provider/runtime pins (`provider: null`, `runtime: null`),
- late-bind to a registered Codex pool builder.

The regression asserts the row stays admissible, records the late-bound builder assignment, and does not become false provider/runtime mismatch fuel.

## Verification

- `npx vitest run tests/unit/continuous-orchestration-admission.test.ts` — pass, 54 tests.
- `npm run build` — pass.
- `npm test` — interrupted after unrelated integration failures in `tests/integration/public-onchain.test.ts` and `tests/integration/checkin-priority-wake.test.ts`; focused admission suite and build were green.
