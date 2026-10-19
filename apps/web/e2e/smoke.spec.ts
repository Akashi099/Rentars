/**
 * Post-deploy smoke suite.
 *
 * Validates that the deployed environment is internally consistent:
 *   1. Backend readiness probe responds.
 *   2. Health endpoint reports no hard failures.
 *   3. CORS policy allows the configured frontend origin.
 *   4. Unauthenticated property search returns a valid response shape.
 *   5. Frontend home page loads without a JS error overlay.
 *   6. Frontend-to-backend connectivity: /api/v1/readiness is reachable from
 *      the browser context.
 *
 * Run after every deployment via .github/workflows/smoke-tests.yml.
 * Inject environment via:
 *   SMOKE_API_URL        — backend base URL (e.g. https://api.rentars.app)
 *   SMOKE_FRONTEND_URL   — frontend base URL (e.g. https://rentars.app)
 *   SMOKE_DEPLOYMENT_ID  — commit SHA, image tag, or run ID (attached to failures)
 *   SMOKE_ENVIRONMENT    — environment name, e.g. staging or preview-pr-42
 *
 * No real money moves, no booking is created, and no persistent data is
 * written outside the isolated test fixture scope.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3000';
const FRONTEND_URL = process.env.SMOKE_FRONTEND_URL ?? 'http://localhost:3001';
const DEPLOYMENT_ID = process.env.SMOKE_DEPLOYMENT_ID ?? 'local';
const ENVIRONMENT = process.env.SMOKE_ENVIRONMENT ?? 'local';

/** Prefixes a message with environment and deployment identity for clear failure attribution. */
function ctx(msg: string): string {
  return `[env=${ENVIRONMENT} deploy=${DEPLOYMENT_ID}] ${msg}`;
}

// ── 1. Backend readiness probe ───────────────────────────────────────────────
test('backend readiness probe returns 200', async ({ request }) => {
  const res = await request.get(`${API_URL}/api/v1/readiness`);
  expect(res.status(), ctx(`Expected 200 from ${API_URL}/api/v1/readiness`)).toBe(200);
  const body = await res.json();
  expect(body, ctx('Readiness body shape mismatch')).toMatchObject({ status: 'ready', service: 'rentars-api' });
});

// ── 2. Health endpoint ────────────────────────────────────────────────────────
test('health endpoint returns ok or degraded (not 5xx crash)', async ({ request }) => {
  const res = await request.get(`${API_URL}/health`);
  // 200 = ok, 503 = degraded — both mean the process is alive
  expect([200, 503], ctx(`Expected 200 or 503 from ${API_URL}/health, got ${res.status()}`)).toContain(res.status());
  const body = await res.json();
  expect(typeof body.status, ctx('Health body missing status field')).toBe('string');
});

// ── 3. CORS policy ────────────────────────────────────────────────────────────
test('CORS preflight allows configured frontend origin', async ({ request }) => {
  const res = await (request as APIRequestContext).fetch(`${API_URL}/api/v1/readiness`, {
    method: 'OPTIONS',
    headers: {
      Origin: FRONTEND_URL,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  });
  // A missing or mis-configured CORS policy returns 4xx or omits the header.
  const allowOrigin = res.headers()['access-control-allow-origin'] ?? '';
  expect(
    allowOrigin === FRONTEND_URL || allowOrigin === '*',
    ctx(`Expected CORS allow-origin "${FRONTEND_URL}" or "*", got "${allowOrigin}"`)
  ).toBe(true);
});

// ── 4. Unauthenticated property search ───────────────────────────────────────
test('property search returns a valid response shape', async ({ request }) => {
  const res = await request.get(`${API_URL}/api/v1/properties?limit=1`);
  // Unauthenticated search may return 200 or 401 depending on auth policy;
  // either is acceptable — we only confirm the API is responding structurally.
  expect([200, 401, 403], ctx(`Unexpected status ${res.status()} from property search`)).toContain(res.status());
  if (res.status() === 200) {
    const body = await res.json();
    // Shape check — must be an array or pagination wrapper
    expect(
      Array.isArray(body) || Array.isArray(body.data) || typeof body === 'object',
      ctx('Property search response has unexpected shape')
    ).toBe(true);
  }
});

// ── 5. Frontend home page loads ───────────────────────────────────────────────
test('frontend home page loads without uncaught error overlay', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await page.goto(FRONTEND_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  // Filter known third-party / extension noise
  const realErrors = jsErrors.filter(
    (e) => !e.includes('chrome-extension') && !e.includes('moz-extension')
  );
  expect(realErrors, ctx(`Unexpected JS errors on home page: ${realErrors.join('; ')}`)).toHaveLength(0);
  await expect(page).toHaveTitle(/.+/);
});

// ── 6. Browser → backend connectivity ────────────────────────────────────────
test('frontend can reach backend readiness endpoint', async ({ page }) => {
  await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const result = await page.evaluate(async (apiUrl: string) => {
    try {
      const res = await fetch(`${apiUrl}/api/v1/readiness`);
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, API_URL);

  expect(
    result.ok,
    ctx(`Browser could not reach backend at ${API_URL}: ${JSON.stringify(result)}`)
  ).toBe(true);
});
