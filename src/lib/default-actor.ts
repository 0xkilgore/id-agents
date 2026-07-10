// T-DECHRIS — configurable default actor/owner fallback.
//
// A handful of routes/read-models fall back to a literal "chris" when no
// actor/owner is supplied by the caller (needs-me filtering, approval
// attribution, decision ownership). That default is correct for Chris's own
// account but silently wrong for any other account — a fresh Gideon-style
// account with no caller-supplied actor would have items/approvals
// attributed to a person who doesn't exist on their team. This constant lets
// a non-Chris deployment override the fallback without changing Chris's
// existing behavior (unset env = identical to before this change).
export const DEFAULT_ACTOR_ID: string = process.env.KAPELLE_DEFAULT_ACTOR_ID || "chris";
