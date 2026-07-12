# Harden Refuel Classification Waves 18-19

Dispatch: `phid:disp-8552af3636127c72`
Task: `harden-refuel-classification`

## Change

Broadened `deriveEmptySuccessCandidate` evidence detection so fast `done`
coordinator refuel rows are not classified as empty-success `needs_review`
when their `result_json` contains concrete closeout evidence but no
`artifact_path`.

New accepted evidence shapes:

- source/source-ref lists
- output artifact lists
- created/claimed/accepted/promoted row lists
- promote count objects
- post-status verification objects

Empty containers and all-zero count objects remain classified as suspect.

## Fixtures

Added regression coverage for:

- wave 17 promoted/accepted count evidence
- wave 18 sources plus created rows
- wave 19 promote counts plus post-status verification
- empty wave evidence containers remaining `needs_review`

## Verification

Passed:

```text
npm test -- tests/unit/dispatch-read-model-recovery-classification.test.ts tests/unit/dispatch-effective-state.test.ts tests/unit/dispatch-sort-group.test.ts
Test Files  3 passed (3)
Tests  97 passed (97)
```

Build passed:

```text
npm run build
```

Full suite status:

```text
npm run build && npm test
Build passed.
Tests failed: 18 failed, 3772 passed, 109 skipped.
```

The full-suite failures were outside this read-model change, in public/remote
agent list assertions and artifact comment route expectations.
