# Changelog

## 0.1.44-beta

### Bug Fixes

- **`defaults.register` propagation**: `register: false` in config defaults now correctly propagates to agents that don't set `register` explicitly. Previously only agent-level `register` was respected.
- **`getDeployerAddress()` null safety**: Returns `null` instead of throwing when no OWS wallet or private key is configured. Deploys with `register: false` no longer require wallet configuration.

## 0.1.43-beta

### Features

- **`/sync` command**: New config reconciliation command that updates running teams without full teardown. Diffs agents into new/removed/changed/unchanged categories and applies minimal changes.
- **Orphan process fix**: `/deploy` now kills old agent processes before deleting DB records, preventing port leaks.

### Documentation

- Added `/sync` command guide and updated all deployment docs with `/sync` vs `/deploy` distinction.
