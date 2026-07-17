# Wave105 usage-meter build-scope reconciliation

## Finding

OP-7 usage admission, queue release, manager telemetry, and the canonical
`GET /usage` report are already implemented. The missing substrate surface was
an operator-readable statement of what is built, which endpoint is canonical,
and which requested concepts are intentionally not modeled. Without that
contract, the usage-meter request could repeatedly appear unbuilt.

## Delta

- Added `GET /usage/scope` (`usage-meter-scope.v1`).
- Points Chris to the canonical clickable `GET /usage` meter and supporting
  manager routes.
- Reports telemetry capture availability and current OP-7 enforcement mode.
- Marks provider-plan percentages without calibrated limits and per-artifact
  cost attribution as intentionally not modeled.
- Does not add a second meter, storage path, or gating implementation.

## Verification

- `npm test -- tests/unit/usage-meter-service.test.ts tests/unit/usage-meter-admission.test.ts tests/unit/usage-meter-release.test.ts`
  - 3 files passed, 45 tests passed.
- `npm run build`
  - Core TypeScript, TUI TypeScript, and build stamp completed.
- `git diff --check`
  - Clean.

## Chris-clickable delta

After manager deployment/restart, open `/usage/scope`, then follow
`canonical_meter.href` (`/usage`). The scope response is the manager-owned
receipt that the meter is built and identifies the remaining exclusions.
