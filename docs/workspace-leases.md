# Workspace Leases + Protected Canonical Checkouts (T-OSS.2)

Make build dispatches **unable to dirty canonical checkouts by accident**.

A build dispatch never writes the canonical repo root. The manager allocates a
git **worktree** under `<protected_root>/.worktrees/`, records custody as a
**workspace lease**, and verifies the protected root is unchanged at closeout.

This is a public Kapelle capability — the registry format is portable and safe for
public examples; real absolute paths live in a private overlay. Standard git
worktrees are the core primitive (no custom sandbox).

## Concepts

- **Protected root** — a canonical checkout that may be *read* but never *mutated*
  by a build dispatch outside a lease (e.g. the deploy checkout). Registered in
  `src/workspaces/repo-registry.ts` (override via `IDAGENTS_REPO_REGISTRY` JSON).
- **Workspace lease** — the custody record for a build dispatch: which protected
  root, which worktree the agent runs in, the remote/base/branch, and the dirty
  status observed before/after. See `WorkspaceLease` in
  `src/dispatch-scheduler/types.ts`.
- **Leased worktree path** — `<protected_root>/.worktrees/<agent>-<dispatch>-<branch>`.

## Admission rules (`decideAdmission` / `allocateWorktree`)

For a build dispatch with `repo` + `branch`:

1. Resolve the protected root from the registry.
2. Snapshot `git status` of the protected root (ignoring `.worktrees/` custody infra).
3. **Dirty protected root → block** (`blocked_dirty_protected_root`) with the exact
   `git status --short`, unless the dispatch declares
   `workspace_policy: "reconcile_dirty_root"`.
4. Fetch the remote.
5. Never check the build branch out in the protected root itself.
6. **Branch already in another live worktree → block** (`branch_conflict`) — reuse
   only when the existing lease id matches; never reset destructively.
7. Create/reuse the leased worktree off `<remote>/<base>`.
8. Snapshot protected-root + worktree status into the lease.

## Closeout rules (`validateWorkspaceCloseout`)

Every `/agent-done` for a leased build must return `workspace` evidence. Success
requires:

- `lease_id` + `worktree_path` match the dispatch lease.
- `protected_root_status_after` shows **no new dirt** vs `…_before`
  (`protected_root_dirty_after` with the exact file list otherwise).
- A dirty worktree at closeout is allowed **only** for failed/blocked dispatches.
- When promotion is required, each promotion repo entry echoes the same
  `workspace_lease_id`, `worktree_path`, and clean `protected_root_status_after`
  (`validatePromotionLeaseFields`).

## Dirty-root monitor (`sampleProtectedRoot` / `sampleAll`)

Samples every protected root and emits a `DirtyRootRecord` (branch, ahead/behind,
dirty count, status preview, last lease/dispatch owner, severity):

- `critical` — deploy/core root dirty, or canonical root off its intended branch.
- `warning` — non-deploy protected root dirty.
- `info` — clean root with ahead/behind drift.

Surface these as **"Protected checkout dirty"** — the point is custody: who
dirtied which root, when, and whether a lease owned it.

## Self-hosting

Provide your own registry via `IDAGENTS_REPO_REGISTRY` pointing at a JSON file of
`ProtectedRootEntry[]` (or `{ "protected_roots": [...] }`). Public examples ship
synthetic fixtures; private absolute paths stay in the private overlay.

---

OSS provenance: built fresh for Kapelle; folds the `id-agents` (MIT) dispatch
scheduler + git-worktree custody primitive into AGPL Kapelle with MIT notice
retained. See cto/output/2026-06-22-toss2-workspace-leases-protected-checkouts.md.
