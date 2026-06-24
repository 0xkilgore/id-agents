# Build-pool member discipline (Stage D)

**Audience:** every build-pool member — `roger`, `regina` (lane captains) + `brunel`, `hopper`, `eames`, `gaudi`, `coder-max`, `coders`.

When the continuous-orchestration daemon fires a build to you, you are operating as a **pool member building in your OWN git worktree**, concurrently with other members building the same repo. The single-writer lock is gone; **the merge queue is the only serialization point.** Follow this exactly or you reintroduce the `main`-fighting the pool was built to eliminate.

## The contract

1. **Build in YOUR worktree only.** The daemon late-binds you to a distinct worktree (`.worktrees/<you>-<token>-<slug>`) off `main`. Build, test, and commit **only** there. Never write to the shared checkout.

2. **Push your branch — do NOT promote to `main` yourself.** When green (`npm run build && npm test` clean), commit and `git push` your build branch. **Do NOT call `promote-to-main` / `id-agents promote-to-main`.** Direct promotion bypasses the queue and is exactly the unserialized free-for-all on `main` that corrupts merges when N builders land at once.

3. **Submit a MergeRequest to the queue.** After pushing, submit a merge request (repo, branch, head_sha, your name as `builder`, the dispatch_id, and your worktree `lease_id`). The single-file **merge-queue worker** serializes all merges to `main` one at a time: it holds the repo merge-lock, rebases your branch onto the current `main` if `main` advanced, re-runs the smoke, and fast-forwards. `main` is **never** force-pushed and **never** auto-reverted.

4. **On `conflict` / `failed`, you get a fix-forward dispatch.** If your branch can't merge cleanly after the retry budget, the queue emits a **fix-forward dispatch back to you** (the `builder`) — never an auto-revert of `main`. Fix it forward in your worktree and resubmit (a new head_sha → a new merge request).

5. **Release your worktree only after `merged`.** Leave the worktree in place until the merge queue reports `merged` (the worker releases the lease eagerly on success). The 6h `reapMergedWorktrees()` sweep removes merged+clean worktrees automatically; it retains unmerged/dirty ones. Do **not** delete a worktree whose merge hasn't landed.

6. **Lane captains (`roger`/`regina`)** additionally own the repo's `CLAUDE.md` and absorb the fix-forward / merge-conflict dispatches first; the daemon spills overflow to the other members.

## Why

Builds parallelize (N worktrees off `main`); **merges serialize** (one-at-a-time queue). If any member promotes directly, two merges race on `main` and corrupt each other — the failure this whole design removes. Push + submit, let the worker merge.

Canonical spec: `cto/output/2026-06-23-build-pool-merge-queue-spec.md` (§4 routing, §3.3 merge queue). Mechanism: `src/build-pools/`, `src/merge-queue/`, `src/continuous-orchestration/{admission,daemon,factory}.ts`.
