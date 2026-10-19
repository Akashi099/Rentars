#!/usr/bin/env bash
# Validates that the runtime versions in use meet the project's minimum
# requirements.  Called by the `engines:check` npm script and the CI
# runtime-check job.  Exits 1 on the first unsupported version and prints
# a human-readable error with the actual vs required version.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ERRORS=0

fail() {
  echo -e "${RED}✗ $1${NC}" >&2
  ERRORS=$((ERRORS + 1))
}

pass() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Compare semver components (major.minor.patch).  Returns 0 when $1 >= $2.
version_gte() {
  local actual="$1" required="$2"
  printf '%s\n%s\n' "$required" "$actual" | sort -V -C
}

# ── Node ────────────────────────────────────────────────────────────────────
REQUIRED_NODE="20.0.0"
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | tr -d 'v')
  if version_gte "$NODE_VERSION" "$REQUIRED_NODE"; then
    pass "Node $NODE_VERSION (required >= $REQUIRED_NODE)"
  else
    fail "Node $NODE_VERSION is too old — required >= $REQUIRED_NODE"
  fi
else
  fail "Node not found — required >= $REQUIRED_NODE"
fi

# ── Yarn ────────────────────────────────────────────────────────────────────
REQUIRED_YARN="1.22.0"
if command -v yarn &>/dev/null; then
  YARN_VERSION=$(yarn --version 2>/dev/null)
  if version_gte "$YARN_VERSION" "$REQUIRED_YARN"; then
    pass "Yarn $YARN_VERSION (required >= $REQUIRED_YARN)"
  else
    fail "Yarn $YARN_VERSION is too old — required >= $REQUIRED_YARN"
  fi
else
  fail "Yarn not found — required >= $REQUIRED_YARN"
fi

# ── Bun ─────────────────────────────────────────────────────────────────────
REQUIRED_BUN="1.1.0"
if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version 2>/dev/null)
  if version_gte "$BUN_VERSION" "$REQUIRED_BUN"; then
    pass "Bun $BUN_VERSION (required >= $REQUIRED_BUN)"
  else
    fail "Bun $BUN_VERSION is too old — required >= $REQUIRED_BUN"
  fi
else
  echo "  Bun not found — skipping (only required for backend workspace)"
fi

# ── Rust ────────────────────────────────────────────────────────────────────
REQUIRED_RUST="1.82.0"
if command -v rustc &>/dev/null; then
  RUST_VERSION=$(rustc --version | awk '{print $2}')
  if version_gte "$RUST_VERSION" "$REQUIRED_RUST"; then
    pass "Rust $RUST_VERSION (required >= $REQUIRED_RUST)"
  else
    fail "Rust $RUST_VERSION is too old — required >= $REQUIRED_RUST"
  fi
else
  echo "  Rust not found — skipping (only required for contracts workspace)"
fi

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo -e "${RED}Engine check failed: $ERRORS unsupported runtime(s).${NC}" >&2
  echo "Update your runtime(s) or use a version manager (.tool-versions / .nvmrc)." >&2
  exit 1
fi

echo ""
echo "All engine checks passed."
