#!/usr/bin/env bun
/**
 * validate-migrations.ts
 *
 * Validates migration filenames in apps/backend/database/migrations/ to ensure:
 *   1. Every file starts with a 5-digit zero-padded numeric prefix (e.g. 00001_)
 *   2. No two files share the same numeric prefix (no duplicates)
 *   3. Prefixes form a monotonically increasing sequence (no gaps are enforced;
 *      only ordering — a later file must not have a lower number than an earlier one)
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more violations found
 *
 * Usage:
 *   bun run apps/backend/scripts/validate-migrations.ts
 *   bun run apps/backend/scripts/validate-migrations.ts --dir path/to/migrations
 *   bun run apps/backend/scripts/validate-migrations.ts --dry-run
 *
 * Flags:
 *   --dry-run   Report all findings but always exit 0 (useful for local triage
 *               without blocking CI).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuration ──────────────────────────────────────────────────────────

// Parse optional --dir argument
const argDir = (() => {
  const idx = process.argv.indexOf('--dir');
  return idx !== -1 ? process.argv[idx + 1] : undefined;
})();

const DRY_RUN = process.argv.includes('--dry-run');

const MIGRATIONS_DIR =
  argDir ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../database/migrations',
  );

const PREFIX_REGEX = /^(\d{5})_/;

// ─── Types ───────────────────────────────────────────────────────────────────

interface MigrationFile {
  filename: string;
  prefix: number;
  raw: string; // the matched "00001" string
}

interface ValidationResult {
  duplicates: Array<{ prefix: number; files: string[] }>;
  nonMonotonic: Array<{ file: string; prefix: number; prevFile: string; prevPrefix: number }>;
  unparseable: string[];
}

// ─── Core logic ──────────────────────────────────────────────────────────────

export function parseMigrationFiles(dir: string): {
  files: MigrationFile[];
  unparseable: string[];
} {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  const allFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic sort — relies on zero-padded prefixes

  const files: MigrationFile[] = [];
  const unparseable: string[] = [];

  for (const filename of allFiles) {
    const match = PREFIX_REGEX.exec(filename);
    if (!match) {
      unparseable.push(filename);
      continue;
    }
    files.push({ filename, prefix: parseInt(match[1], 10), raw: match[1] });
  }

  return { files, unparseable };
}

export function validateMigrations(files: MigrationFile[]): ValidationResult {
  const result: ValidationResult = {
    duplicates: [],
    nonMonotonic: [],
    unparseable: [],
  };

  // ── Check for duplicate prefixes ──────────────────────────────────────────
  const byPrefix = new Map<number, string[]>();
  for (const f of files) {
    const existing = byPrefix.get(f.prefix) ?? [];
    existing.push(f.filename);
    byPrefix.set(f.prefix, existing);
  }

  for (const [prefix, filenames] of byPrefix) {
    if (filenames.length > 1) {
      result.duplicates.push({ prefix, files: filenames });
    }
  }

  // ── Check monotonically increasing order ──────────────────────────────────
  // Files are already lexicographically sorted (zero-padded prefixes make this work).
  for (let i = 1; i < files.length; i++) {
    const prev = files[i - 1];
    const curr = files[i];
    if (curr.prefix < prev.prefix) {
      result.nonMonotonic.push({
        file: curr.filename,
        prefix: curr.prefix,
        prevFile: prev.filename,
        prevPrefix: prev.prefix,
      });
    }
  }

  return result;
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

function printReport(
  dir: string,
  files: MigrationFile[],
  result: ValidationResult & { unparseable: string[] },
): boolean {
  let hasErrors = false;

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Validation results will be reported but exit code will be 0.\n');
  }

  console.log(`\n📂 Migration directory: ${dir}`);
  console.log(`   ${files.length} SQL file(s) found\n`);

  if (result.unparseable.length > 0) {
    hasErrors = true;
    console.error('❌ Files with no parseable numeric prefix:');
    for (const f of result.unparseable) {
      console.error(`   • ${f}`);
    }
    console.error(
      '   → Rename these files to follow the pattern: NNNNN_description.sql\n',
    );
  }

  if (result.duplicates.length > 0) {
    hasErrors = true;
    console.error('❌ Duplicate numeric prefixes detected:');
    for (const dup of result.duplicates) {
      console.error(`   Prefix ${String(dup.prefix).padStart(5, '0')}:`);
      for (const f of dup.files) {
        console.error(`     • ${f}`);
      }
    }
    console.error(
      '\n   → See MIGRATIONS_NAMING.md for the canonical ordering and the\n' +
        '     forward-looking convention for resolving duplicates.\n',
    );
  }

  if (result.nonMonotonic.length > 0) {
    hasErrors = true;
    console.error('❌ Non-monotonic prefix ordering detected:');
    for (const nm of result.nonMonotonic) {
      console.error(
        `   "${nm.file}" (prefix ${nm.prefix}) comes after "${nm.prevFile}" (prefix ${nm.prevPrefix})`,
      );
    }
    console.error('   → Migrations must be in ascending order.\n');
  }

  if (!hasErrors) {
    console.log('✅ All migration filenames are valid (unique, monotonically increasing).\n');
  } else if (DRY_RUN) {
    console.log('⚠️  Issues found above. Exiting 0 because --dry-run was passed.\n');
  }

  return hasErrors;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main(): void {
  let files: MigrationFile[];
  let unparseable: string[];

  try {
    ({ files, unparseable } = parseMigrationFiles(MIGRATIONS_DIR));
  } catch (err) {
    console.error(`\nFatal: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = validateMigrations(files);
  const hasErrors = printReport(MIGRATIONS_DIR, files, { ...result, unparseable });

  process.exit(hasErrors && !DRY_RUN ? 1 : 0);
}

if (import.meta.main) {
  main();
}
