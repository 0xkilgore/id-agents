export { mountInboxEmailRoutes } from "./routes.js";
export { ingestForwardedEmail } from "./intake.js";
export { listEmailAliases, normalizeAliasAddress, normalizeEmailAddress, upsertEmailAlias } from "./storage.js";
export type { EmailIntakeResult, ForwardedEmailInput, RegisterEmailAliasInput } from "./types.js";
