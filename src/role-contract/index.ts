// SPDX-License-Identifier: MIT
//
// CoS role-contract module (T-COS first task). The declarative source of truth
// for fleet roles that run over the manager engine. See ./types.ts for the
// shape and ./contract.ts for the greenfield Chief-of-Staff seed + registry.

export {
  ROLE_CONTRACT_SCHEMA_VERSION,
  type RoleCapability,
  type RoleCapabilityKind,
  type RoleComposition,
  type RoleCompositionRole,
  type RoleAccountScope,
  type RoleRequirements,
  type RoleContract,
  type RoleContractValidationError,
  type RoleContractValidationResult,
} from './types.js';

export {
  CHIEF_OF_STAFF_CONTRACT,
  DEFAULT_ROLE_CONTRACTS,
  validateRoleContract,
  resolveRoleContract,
  instantiateRoleContract,
  RoleContractRegistry,
  type ResolveRoleContractResult,
  type InstantiateRoleContractResult,
} from './contract.js';
