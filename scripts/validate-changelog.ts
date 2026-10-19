#!/usr/bin/env bun
/**
 * Validates that CHANGELOG.md is well-formed before a release.
 *
 * Rules enforced:
 *   1. An [Unreleased] section must exist.
 *   2. Every entry under [Unreleased] must carry at least one recognised
 *      category heading (### Added | Changed | Deprecated | Removed | Fixed |
 *      Security | Performance).
 *   3. Any version section (e.g. [1.2.3]) must include a release date in the
 *      heading (e.g. [1.2.3] - 2026-09-25).
 *
 * Exits 0 on success, 1 on validation failures.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');
const VALID_CATEGORIES = new Set([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Performance',
]);

let errors: string[] = [];

function fail(msg: string) {
  errors.push(`  ✗ ${msg}`);
}

const content = readFileSync(CHANGELOG_PATH, 'utf-8');
const lines = content.split('\n');

// ── Rule 1: [Unreleased] section must exist ──────────────────────────────────
if (!lines.some((l) => /^##\s+\[Unreleased\]/i.test(l))) {
  fail('Missing ## [Unreleased] section');
}

// ── Rule 2: [Unreleased] section must have at least one recognised category ──
const unreleasedStart = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
if (unreleasedStart >= 0) {
  // Find end of the Unreleased section (next ## heading or EOF)
  const unreleasedEnd = lines.findIndex(
    (l, i) => i > unreleasedStart && /^##\s+\[/.test(l)
  );
  const section = lines.slice(
    unreleasedStart + 1,
    unreleasedEnd === -1 ? undefined : unreleasedEnd
  );
  const hasCategory = section.some((l) => {
    const m = l.match(/^###\s+(\w+)/);
    return m && VALID_CATEGORIES.has(m[1]);
  });
  if (!hasCategory) {
    fail(
      `[Unreleased] section has no recognised category heading. ` +
        `Add at least one of: ${[...VALID_CATEGORIES].join(', ')}.`
    );
  }
}

// ── Rule 3: Version sections must include a date ─────────────────────────────
const versionLines = lines.filter((l) =>
  /^##\s+\[\d+\.\d+\.\d+\]/.test(l)
);
for (const line of versionLines) {
  if (!/^##\s+\[\d+\.\d+\.\d+\]\s+-\s+\d{4}-\d{2}-\d{2}/.test(line)) {
    fail(`Version heading is missing a release date: ${line.trim()}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error('CHANGELOG.md validation failed:\n');
  for (const e of errors) console.error(e);
  console.error('');
  process.exit(1);
}

console.log('CHANGELOG.md validation passed.');
