# Artifact Comment Router Sweep

Task: artifact-comment-router
Dispatch reassignment: phid:disp-b56468e2b4e6fd14
Date: 2026-06-29
Agent: substrate-api-codex

## Implementation

- Added artifact comment classification:
  - approval_signal: short approvals such as "Ship it", "approved", "LGTM", and the `ship_it` reaction.
  - substantive_follow_up: default for concrete requested work and `wrong` / `iterate` reactions.
  - question: question-mark / interrogative comments and the `explain` reaction.
- Routed classified comments:
  - approval_signal auto-applies artifact approval via `approveArtifact`.
  - substantive_follow_up dispatches to the artifact catalog owner through the existing comment dispatch path.
  - question stays threaded on the artifact and does not dispatch.
- Removed artifact comments from Desk Needs Me so comments do not become Chris inbox/needs-you decisions.

## 2026-06-29 Sweep Evidence

Read-only live DB checked: `/Users/kilgore/.id-agents/id-agents.db`.

Query result:

- `artifact_operations` has 5 `comment_recorded` rows total.
- Date range `2026-06-29T00:00:00Z` to `2026-06-30T00:00:00Z`: 0 `comment_recorded` rows.
- Existing `comment_recorded` rows are all from 2026-06-17.

Related incident artifacts say the intended real-world sweep set is 26 Chris-authored artifact comments on 2026-06-29: 23 approval signals and 3 substantive UI follow-ups. Those concrete comment rows were not present in the manager artifact operation log at verification time, so no live rows could be auto-approved or routed from this DB.

## Verification

- `npm test -- tests/unit/outputs-comment-dispatch.test.ts tests/unit/outputs-reactions-feedback.test.ts tests/unit/desk-tray.test.ts`
- `npm run build:core`

