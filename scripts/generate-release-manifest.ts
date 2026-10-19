#!/usr/bin/env bun
/**
 * Generates a machine-readable release manifest at
 * docs/releases/manifest-<version>.json.
 *
 * The manifest records:
 *   - commit SHA and tag
 *   - per-component versions (backend, web, contracts)
 *   - latest applied migration
 *   - ABI file hashes for each contract
 *   - Docker image identifiers (if IMAGE_TAG env is set)
 *   - rollback documentation pointer
 *
 * Usage:
 *   bun run scripts/generate-release-manifest.ts [--version <semver>]
 *
 * Reads version from:
 *   1. --version CLI flag
 *   2. ROOT_VERSION env variable
 *   3. root package.json version field
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ── Resolve version ──────────────────────────────────────────────────────────
const versionFlag = process.argv.findIndex((a) => a === '--version');
const version: string =
  versionFlag >= 0
    ? (process.argv[versionFlag + 1] ?? '')
    : (process.env.ROOT_VERSION ?? String((json('package.json') as { version?: string }).version ?? '0.0.0'));

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: "${version}". Pass --version X.Y.Z or set ROOT_VERSION.`);
  process.exit(1);
}

// ── Component versions ────────────────────────────────────────────────────────
const backendPkg = json('apps/backend/package.json') as { version?: string };
const webPkg = json('apps/web/package.json') as { version?: string };
const contractsCargo = read('apps/contracts/Cargo.toml');
const contractsVersion = contractsCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';

// ── Latest migration ─────────────────────────────────────────────────────────
const migrationsDir = resolve(ROOT, 'apps/backend/database/migrations');
let latestMigration = 'none';
let migrationCount = 0;
if (existsSync(migrationsDir)) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  migrationCount = files.length;
  if (files.length > 0) latestMigration = files[files.length - 1];
}

// ── Rollback target and gate policy ──────────────────────────────────────────
// The rollback target is the newest manifest that is not this release. Its
// existence is what makes "roll back to the last known-good release" answerable.
const releasesDir = resolve(ROOT, 'docs/releases');
const gatePolicyPath = 'docs/releases/health-gates.json';
const previousManifest = existsSync(releasesDir)
  ? (readdirSync(releasesDir)
      .filter((f) => /^manifest-.+\.json$/.test(f) && f !== `manifest-${version}.json`)
      .map((f) => ({
        file: f,
        generatedAt: String(
          (json(`docs/releases/${f}`) as { generated_at?: unknown }).generated_at ?? ''
        ),
      }))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]?.file ?? null)
  : null;

// ── ABI hashes ───────────────────────────────────────────────────────────────
const abiFiles = ['booking_abi.json', 'property_listing_abi.json', 'review_abi.json'];
const abiHashes: Record<string, string> = {};
for (const abi of abiFiles) {
  const path = `apps/contracts/${abi}`;
  if (existsSync(resolve(ROOT, path))) {
    abiHashes[abi] = sha256(read(path));
  }
}

// ── Git metadata ──────────────────────────────────────────────────────────────
const commit = git('rev-parse HEAD');
const tag = git('describe --tags --exact-match 2>/dev/null') || `v${version}`;

// ── Assemble manifest ────────────────────────────────────────────────────────
const manifest = {
  schema_version: '1',
  generated_at: new Date().toISOString(),
  release: {
    version,
    commit,
    tag,
    image_tag: process.env.IMAGE_TAG ?? null,
  },
  components: {
    backend: { version: backendPkg.version ?? version },
    web: { version: webPkg.version ?? version },
    contracts: { version: contractsVersion },
  },
  database: {
    latest_migration: latestMigration,
    migration_count: migrationCount,
  },
  dependencies: {
    stellar_network: process.env.STELLAR_NETWORK ?? null,
    contract_ids: {
      property_listing: process.env.PROPERTY_LISTING_CONTRACT_ID ?? null,
      booking: process.env.BOOKING_CONTRACT_ID ?? null,
      review: process.env.REVIEW_CONTRACT_ID ?? null,
    },
  },
  contracts: {
    abi_sha256: abiHashes,
  },
  rollback: {
    docs: 'docs/releases/rollback.md',
    prior_manifest_pattern: `docs/releases/manifest-*.json`,
    previous_manifest: previousManifest ? `docs/releases/${previousManifest}` : null,
    health_gate_policy: {
      path: gatePolicyPath,
      sha256: existsSync(resolve(ROOT, gatePolicyPath)) ? sha256(read(gatePolicyPath)) : null,
    },
  },
};

// ── Write ─────────────────────────────────────────────────────────────────────
const outDir = resolve(ROOT, 'docs/releases');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `manifest-${version}.json`);
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Release manifest written to: ${outPath.replace(ROOT + '/', '')}`);
