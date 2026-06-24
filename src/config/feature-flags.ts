// Operator-surface feature flags — the substrate read-path cutover switches.
//
// Each surface (artifacts → tasks → desk, per the read-model contract §11) gets
// a `<SURFACE>_USE_DOCUMENT_MODEL` env flag. When ON, the console reads the
// surface from the substrate query route; when OFF, it walks markdown as before.
// Default OFF everywhere — the flag is a reversible cutover, not a migration.

export type DocumentModelSurface = "artifacts" | "tasks" | "desk";

const ENV_KEY: Record<DocumentModelSurface, string> = {
  artifacts: "ARTIFACTS_USE_DOCUMENT_MODEL",
  tasks: "TASKS_USE_DOCUMENT_MODEL",
  desk: "DESK_USE_DOCUMENT_MODEL",
};

function isOn(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

/** True when the given operator surface should read from the document-model
 *  substrate instead of walking markdown. Reads the per-surface env flag. */
export function useDocumentModel(
  surface: DocumentModelSurface,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOn(env[ENV_KEY[surface]]);
}

/** Cane-draft-as-approvable-artifact capability flag (CANE_DRAFT_ARTIFACTS).
 *  OFF by default. When OFF, draft registration, the `revise_draft` op route,
 *  and the cane_draft send executor are all inert — Cane keeps the legacy
 *  state.json/Telegram approval flow exactly as today (zero regression). The
 *  flip is a reversible cutover, not a migration. Distinct from the generic
 *  ARTIFACTS_EDIT_IN_PRODUCT flag (edit.ts), which gates the generic `edit` op. */
export function isCaneDraftArtifactsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOn(env.CANE_DRAFT_ARTIFACTS);
}
