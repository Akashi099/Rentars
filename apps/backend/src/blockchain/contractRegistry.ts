/**
 * Contract Version Registry
 *
 * Single source of truth for all deployed Soroban contract metadata.
 * Populated from environment variables at startup and validated before
 * the server accepts traffic.
 *
 * What is tracked per contract:
 *   - contractId       — deployed contract address (StrKey-encoded)
 *   - abiVersion       — semver string sourced from the ABI JSON
 *   - wasmHash         — SHA-256 hash of the deployed WASM binary (hex)
 *   - network          — Stellar network the contract is deployed on
 *   - deployedAt       — ISO-8601 deployment timestamp (optional)
 *   - compatibleApps   — semver ranges of app releases known to work
 *
 * All fields except wasmHash and deployedAt are required for production.
 * A mismatch between the registry entry and the configured contract ID is
 * detected at startup via validateContractRegistry().
 *
 * Upgrade sequencing:
 *   1. Deploy new WASM to staging; update WASM_HASH_<CONTRACT> env vars.
 *   2. Run validateContractRegistry() in the staging pipeline.
 *   3. After smoke-testing, promote env vars to production.
 *   4. Restart the production server; startup validation confirms consistency.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { env } from '@/config/env.js';
import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  REVIEW_CONTRACT_ID,
} from './config.js';

// ─── ABI version constants (single source; keep in sync with ABI JSON files) ─

export const ABI_VERSIONS = {
  booking: '0.1.0',
  propertyListing: '0.1.0',
  review: '0.1.0',
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContractRegistryEntry {
  /** Human-readable contract name. */
  name: string;
  /** Deployed Soroban contract ID (StrKey-encoded). */
  contractId: string;
  /** ABI version (semver string). */
  abiVersion: string;
  /**
   * SHA-256 hash of the deployed WASM binary, hex-encoded.
   * Set via WASM_HASH_<CONTRACT_NAME> env var.  Empty string when not yet set.
   */
  wasmHash: string;
  /** Stellar network this entry applies to. */
  network: 'testnet' | 'mainnet';
  /**
   * ISO-8601 timestamp of the most recent deployment.
   * Set via DEPLOY_TIME_<CONTRACT_NAME> env var.  null when not tracked.
   */
  deployedAt: string | null;
  /**
   * Semver ranges (comma-separated) of application releases known to be
   * compatible with this contract + ABI version.
   * Example: ">=1.0.0 <2.0.0"
   */
  compatibleApps: string;
}

export interface ContractRegistryValidationError {
  contract: string;
  field: string;
  message: string;
}

// ─── Build the registry from environment ─────────────────────────────────────

function resolveNetwork(): 'testnet' | 'mainnet' {
  return env.STELLAR_NETWORK;
}

function buildEntry(
  name: string,
  contractId: string,
  abiVersion: string,
  wasmHashEnvKey: string,
  deployTimeEnvKey: string,
  compatibleAppsEnvKey: string,
): ContractRegistryEntry {
  return {
    name,
    contractId,
    abiVersion,
    wasmHash: process.env[wasmHashEnvKey] ?? '',
    network: resolveNetwork(),
    deployedAt: process.env[deployTimeEnvKey] ?? null,
    compatibleApps: process.env[compatibleAppsEnvKey] ?? '*',
  };
}

/**
 * Live registry built from the current environment.
 * Exported so other modules can read contract metadata at runtime.
 */
export const CONTRACT_REGISTRY: Readonly<Record<string, ContractRegistryEntry>> = Object.freeze({
  booking: buildEntry(
    'booking',
    BOOKING_CONTRACT_ID,
    ABI_VERSIONS.booking,
    'WASM_HASH_BOOKING',
    'DEPLOY_TIME_BOOKING',
    'COMPATIBLE_APPS_BOOKING',
  ),
  propertyListing: buildEntry(
    'propertyListing',
    PROPERTY_LISTING_CONTRACT_ID,
    ABI_VERSIONS.propertyListing,
    'WASM_HASH_PROPERTY_LISTING',
    'DEPLOY_TIME_PROPERTY_LISTING',
    'COMPATIBLE_APPS_PROPERTY_LISTING',
  ),
  review: buildEntry(
    'review',
    REVIEW_CONTRACT_ID,
    ABI_VERSIONS.review,
    'WASM_HASH_REVIEW',
    'DEPLOY_TIME_REVIEW',
    'COMPATIBLE_APPS_REVIEW',
  ),
});

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidContractId(id: string): boolean {
  if (!id) return false;
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

/**
 * Validate every entry in the registry.
 *
 * Called at startup (before accepting traffic) so misconfigured contracts
 * are caught before any booking or payment flow can touch an invalid address.
 *
 * When `strict` is true (default in production), missing WASM hashes are
 * also reported as errors.  In development/staging they are warnings only.
 */
export function validateContractRegistry(
  strict = env.NODE_ENV === 'production',
): ContractRegistryValidationError[] {
  const errors: ContractRegistryValidationError[] = [];

  for (const [key, entry] of Object.entries(CONTRACT_REGISTRY)) {
    // Contract ID must be present and a valid StrKey.
    if (!entry.contractId) {
      errors.push({
        contract: key,
        field: 'contractId',
        message: `Contract ID for '${key}' is not set. Configure the corresponding environment variable.`,
      });
    } else if (!isValidContractId(entry.contractId)) {
      errors.push({
        contract: key,
        field: 'contractId',
        message: `Contract ID for '${key}' is not a valid Soroban contract address: ${entry.contractId}`,
      });
    }

    // ABI version must be a non-empty semver-ish string.
    if (!entry.abiVersion || !/^\d+\.\d+\.\d+/.test(entry.abiVersion)) {
      errors.push({
        contract: key,
        field: 'abiVersion',
        message: `ABI version for '${key}' is missing or malformed: ${entry.abiVersion}`,
      });
    }

    // Network must agree with the backend's configured network.
    if (entry.network !== env.STELLAR_NETWORK) {
      errors.push({
        contract: key,
        field: 'network',
        message: `Registry network '${entry.network}' does not match STELLAR_NETWORK='${env.STELLAR_NETWORK}'.`,
      });
    }

    // WASM hash: required in production; advisory in other environments.
    if (!entry.wasmHash) {
      if (strict) {
        errors.push({
          contract: key,
          field: 'wasmHash',
          message: `WASM hash for '${key}' is not set. Set WASM_HASH_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} before deploying to production.`,
        });
      } else {
        console.warn(
          `[contract-registry] WASM hash for '${key}' is not set. ` +
          `Set WASM_HASH_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} before deploying to production.`,
        );
      }
    }
  }

  return errors;
}

// ─── Accessor helpers ─────────────────────────────────────────────────────────

/**
 * Return the registry entry for a contract by key.
 * Throws if the key is not in the registry (programming error).
 */
export function getContractEntry(key: keyof typeof CONTRACT_REGISTRY): ContractRegistryEntry {
  const entry = CONTRACT_REGISTRY[key];
  if (!entry) {
    throw new Error(`[contract-registry] Unknown contract key: '${key}'`);
  }
  return entry;
}

/**
 * Safe subset of the registry suitable for public API responses.
 * Excludes nothing sensitive (all fields are non-secret) but provides a
 * stable shape independent of the internal registry structure.
 */
export interface PublicContractInfo {
  name: string;
  contractId: string;
  abiVersion: string;
  wasmHash: string;
  network: string;
  deployedAt: string | null;
  compatibleApps: string;
}

export function getPublicContractInfo(): PublicContractInfo[] {
  return Object.values(CONTRACT_REGISTRY).map((e) => ({
    name: e.name,
    contractId: e.contractId,
    abiVersion: e.abiVersion,
    wasmHash: e.wasmHash,
    network: e.network,
    deployedAt: e.deployedAt,
    compatibleApps: e.compatibleApps,
  }));
}
