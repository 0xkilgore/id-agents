# Wave91 Reports Receipt Exclusion

Task: `wave91-reports-receipt-exclusion`

Summary:
- Added `final-document` to the artifact stamp contract and Reports surface admission.
- Added an integration fixture with system receipt, system diagnostic, operator report, and operator final-document examples.
- Verified Reports includes only the operator report/final-document rows from the fixture and System includes the receipt/diagnostic rows.

Validation:
- `npm test -- tests/integration/doc-model-artifact-surfaces.test.ts`
- `npx tsc --noEmit`
