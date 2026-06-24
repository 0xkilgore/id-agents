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
