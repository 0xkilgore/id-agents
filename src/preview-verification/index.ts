// T-QA.3 / HC-15 — live-UI Vercel preview verification substrate.
//
// Roger's "wire substrate" step in the sequence Chris (gets token) -> Roger
// (this seam) -> Sentinel (preview-URL smoke step). A token-ready gate that
// no-ops with a STRUCTURED skip until the Vercel preview token (HC-15) and the
// Sentinel smoke runner are present — so it is additive + reversible and
// activates the moment both land, with no further Roger round-trip.
//
// Reference/substrate: nothing imports it at run time yet. Sentinel's verifier
// will call verifyPreview() with its runSmoke implementation once HC-15's token
// is provisioned.

export * from "./types.js";
export { loadPreviewConfig, verifyPreview } from "./verify.js";
