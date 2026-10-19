# Compatibility Requirements for ABI and Schema Changes

## Why this matters

Rentars deploys three independently versioned components:

- **Backend** (`apps/backend`) — Express API, Bun runtime
- **Frontend** (`apps/web`) — Next.js, Yarn
- **Contracts** (`apps/contracts`) — Soroban/Stellar WASM, immutable after deployment

A database migration or contract ABI change can silently break a deployed client
or block a rollback.  Every such change therefore requires explicit release notes
and passing compatibility checks before merging.

## What triggers the check

The `check-abi-migration-changelog.sh` CI script fails a PR if any of the
following files change without a corresponding CHANGELOG.md update:

| Changed files | Category |
|---|---|
| `apps/contracts/*.json` | Contract ABI |
| `apps/backend/database/migrations/*.sql` | Database schema |

## What to write in the changelog

Add an entry under `## [Unreleased]` with at least one of these headings:

### Additive changes (backwards-compatible)

These are safe to deploy without coordination.  Label them under `### Added`.

```markdown
### Added
- Migration 00025: add `cancelled_at` column to `bookings` (nullable, defaults
  to NULL for existing rows — backwards compatible with the deployed backend).
```

### Breaking changes (require coordinated rollout)

Label them under `### Changed` or `### Removed` and include:

1. **What changed** — the field, table, or contract entrypoint affected.
2. **Incompatible client versions** — which deployed version of backend/web/contract
   is no longer compatible after this change.
3. **Rollout order** — which component must be deployed first.
4. **Rollback boundary** — whether rolling back crosses this migration boundary
   (if so, a data migration or contract re-deploy may be required).

```markdown
### Changed
- Contract ABI: `create_booking` entrypoint now requires `escrow_agent` parameter.
  Incompatible with backend < 1.4.0.  Deploy backend 1.4.0 before this contract.
  Rolling back the contract is not possible post-deploy; rollback requires
  re-deploying the prior WASM from the release manifest.
```

## Release manifest

Every release generates `docs/releases/manifest-<version>.json` via:

```bash
bun run release:manifest --version X.Y.Z
```

The manifest records:
- `release.commit` — exact git SHA
- `database.latest_migration` — last applied migration filename
- `contracts.abi_sha256` — SHA-256 of each ABI file at release time
- `components.*` — per-component version

Use these fields during rollback to identify a compatible set.  See
`docs/releases/rollback.md` for the full procedure.

## Suppressing the check

If the ABI or migration change is already covered by a prior changelog entry
(e.g., a stacked PR), set the `BASE_SHA` environment variable to the commit
that already includes the changelog update:

```bash
BASE_SHA=<prior-commit> bash scripts/check-abi-migration-changelog.sh
```

Do not bypass the check with `git commit --no-verify`.
