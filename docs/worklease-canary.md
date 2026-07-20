# WorkLease canary and fencing contract

This processor is additive to the existing workspace custody lease. A workspace
lease answers **where** a build may write; WorkLease answers **which manager** may
perform authoritative lifecycle writes for one named scheduler lane.

`IDAGENTS_WORKLEASE_AUTHORITY=off` is the default and immediate rollback.
`shadow` records/evaluates leases but never gates legacy writes. `canary` gates
only the exact lane in `IDAGENTS_WORKLEASE_CANARY_LANE`; every other lane remains
legacy-authoritative.

Acquire is atomic per resource and allocates a monotonically increasing fencing
token. Renew, release, and any completion write must present both lease id and
fencing token. Expiry is durable and lazy/recovery-driven. A replacement manager
calls `recover()` at startup: live leases remain owned, elapsed leases become
expired, and a later acquisition receives a higher fence. Therefore a stale
manager cannot complete after expiry or takeover.

Cutover integration order:

1. Start in `shadow`; compare operations to the legacy lane for lifecycle deltas.
2. Set one isolated lane and change authority to `canary`.
3. Call `assertFence()` in the same transaction immediately before authoritative
   dispatch completion/failure/cancellation writes.
4. Roll back instantly by setting authority to `off`; lease history remains for
   diagnosis and the legacy scheduler retains authority.
