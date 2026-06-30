# overnight-promotion-stale-inflight-guard

Task: `overnight-promotion-stale-inflight-guard`
Dispatch: `phid:disp-72c60cd907ae9617`

## Change

- Added `src/dispatch-scheduler/stale-inflight-guard.ts`, a pure classifier for in-flight staleness decisions.
- Added focused regression coverage in `tests/unit/dispatch-scheduler-stale-inflight-guard.test.ts`.

## Safety Notes

- Default-inert: the new helper is not wired into the scheduler loop or any live daemon path.
- No destructive behavior: the helper has no database, Git, task, promotion, or scheduler client dependency.
- No auto-close behavior: stale rows are classified as `stale`; callers must choose an explicit operator or scheduler mutation path separately.
- Terminal guard: terminal dispatches and terminal linked queries classify as `terminal`, not `stale`.
- Active guard: recent `last_output_at` evidence keeps an old in-flight claim classified as `active`.

## Verification

- `npx vitest run tests/unit/dispatch-scheduler-stale-inflight-guard.test.ts`
- `npm run build:core`

## Promotion

Promotion was not run because this scheduler message did not include structured build-dispatch `repo` and `branch` metadata for `id-agents promote-to-main`. The work is committed on branch `overnight-promotion-stale-inflight-guard` for review/promotion by a follow-up owner.
