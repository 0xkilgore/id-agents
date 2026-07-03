// SPDX-License-Identifier: MIT
//
// kapelle-remote-doctor v1 (T-REMOTE, P0b) — one-command re-entry diagnosis. The
// pure verdict engine + §2.1 contract; the transport/control-plane probe layer
// (connect-m4.sh doctor) assembles a DoctorProbeInput and feeds it here.
// See cto/output/2026-06-29-laptop-remote-operations-product-architecture.md.

export {
  computeDoctorReport,
  computeTransportVerdict,
  doctorExitCode,
} from './report.js';

export { formatDoctorMarkdown } from './format.js';

export { computeConsoleRouteStatus, type ConsoleRouteStatus } from './route-status.js';

export {
  DOCTOR_VERSION,
  type DoctorProbeInput,
  type DoctorReport,
  type TransportProbe,
  type TransportVerdict,
  type ManagerProbe,
  type KapelleOpsProbe,
  type OrchestrationProbe,
  type AgentsProbe,
  type DispatchAction,
  type DispatchActionClass,
  type ReleaseCohort,
} from './types.js';
