#!/usr/bin/env bash
# Read-only synthetic production checks. Never mutates data or moves funds.
# See docs/synthetic-monitoring.md for the probe definitions and alert rules.
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
WEB_URL="${WEB_URL:-http://localhost:3001}"
FAILURES=0

redact() {
  sed -E 's/("password"|"token"|"secret"|Bearer )[[:space:]]*[^,}]*/\1 ***REDACTED***/Ig'
}

fail() {
  echo "FAIL [$1] step=$2 $3" | redact
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "PASS [$1] $2"
}

# 1. Frontend site
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WEB_URL/" || echo 000)
if [ "$code" = "200" ]; then pass site "frontend HTTP 200"; else fail site frontend "HTTP $code"; fi

# 2. API health
health=$(curl -s --max-time 10 "$BASE_URL/health" || echo "")
if echo "$health" | grep -q '"status"'; then
  pass health "api healthy version=$(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
else
  fail health api "no status in /health"
fi

# 3. CORS preflight
acao=$(curl -s -o /dev/null -D - -X OPTIONS --max-time 10 \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: GET" \
  "$BASE_URL/api/v1/properties/search/advanced" 2>/dev/null \
  | grep -i '^access-control-allow-origin' | head -1 || true)
if [ -n "$acao" ]; then pass cors "allow-origin header present"; else fail cors cors "missing allow-origin"; fi

# 4. Auth round-trip (read-only; canary credentials from env, redacted in logs)
if [ -n "${SYNTHETIC_CANARY_EMAIL:-}" ] && [ -n "${SYNTHETIC_CANARY_PASSWORD:-}" ]; then
  login=$(curl -s --max-time 10 -X POST "$BASE_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SYNTHETIC_CANARY_EMAIL\",\"password\":\"$SYNTHETIC_CANARY_PASSWORD\"}" || echo "")
  token=$(echo "$login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "$token" ]; then
    pcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "Authorization: Bearer $token" "$BASE_URL/api/v1/profile" || echo 000)
    if [ "$pcode" = "200" ]; then pass auth "login + profile 200"; else fail auth auth "profile HTTP $pcode"; fi
  else
    fail auth auth "login returned no token"
  fi
  # Invalid token must be rejected
  icode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer invalid-token" "$BASE_URL/api/v1/profile" || echo 000)
  if [ "$icode" = "401" ] || [ "$icode" = "403" ]; then pass auth "invalid token rejected ($icode)"; else fail auth auth "invalid token got HTTP $icode"; fi
else
  echo "SKIP [auth] SYNTHETIC_CANARY_EMAIL/PASSWORD not set"
fi

# 5. Search (read-only)
t0=$(date +%s%N)
scode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "$BASE_URL/api/v1/properties/search/advanced?q=berlin" || echo 000)
t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
if [ "$scode" = "200" ] && [ "$ms" -lt 2000 ]; then
  pass search "HTTP 200 in ${ms}ms"
else
  fail search search "HTTP $scode in ${ms}ms"
fi

exit "$FAILURES"
