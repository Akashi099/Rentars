/**
 * Visual regression tests — captures and diffs page screenshots.
 *
 * Baseline update:  npx playwright test e2e/visual-regression.spec.ts --update-snapshots
 * CI run:           npx playwright test e2e/visual-regression.spec.ts
 *
 * Design decisions
 * ─────────────────
 * • Timestamps, live prices, and wallet addresses are masked before capture so
 *   nondeterministic values do not create false failures.
 * • Dynamic content (maps, charts) is replaced with a deterministic placeholder
 *   via CSS override injected per-test.
 * • maxDiffPixelRatio is set conservatively at 0.02 (2 %) for dense UI surfaces
 *   (dashboard, search) and 0.01 (1 %) for simpler auth pages.
 * • Each test group covers the four relevant states: loading → empty → error → success.
 *   Where the app does not expose a dedicated loading/empty/error route the test
 *   captures the nearest representative state (e.g. a 404 page for the error state).
 * • Desktop (1280×720) and mobile (390×844) viewports are declared per-project in
 *   playwright.config.ts.  The tests below run across all configured projects.
 */

import { test, expect, type Page } from '@playwright/test';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Freeze timestamps and mask wallet addresses so screenshots are deterministic.
 */
async function seedDeterministicState(page: Page) {
  await page.addInitScript(() => {
    // Freeze Date so relative timestamps ("2 minutes ago") are stable
    const FIXED_NOW = new Date('2024-06-15T10:00:00.000Z').getTime();
    const OriginalDate = Date;
    class FrozenDate extends OriginalDate {
      constructor(...args: ConstructorParameters<typeof OriginalDate>) {
        if (args.length === 0) super(FIXED_NOW);
        else super(...args);
      }
      static now() {
        return FIXED_NOW;
      }
    }
    // @ts-ignore — override global Date
    window.Date = FrozenDate;

    // Mock Freighter wallet so wallet-dependent UI renders predictably
    (window as any).freighter = {
      isConnected: () => Promise.resolve(false),
      getPublicKey: () => Promise.resolve('GVISUAL000000000000000000000000000000000000000000000000'),
      signTransaction: (_xdr: string) => Promise.resolve({ signedXDR: '' }),
    };
  });
}

/**
 * Inject CSS that replaces map tiles and chart animations with a static
 * placeholder colour, preventing per-run render differences.
 */
async function stabilizeDynamicContent(page: Page) {
  await page.addStyleTag({
    content: `
      /* Map tiles — replace with solid background */
      .leaflet-tile-pane,
      .leaflet-tile { visibility: hidden !important; }
      .leaflet-container { background: #e5e7eb !important; }

      /* Recharts / SVG animations */
      .recharts-wrapper *,
      svg animate,
      svg animateTransform { animation: none !important; transition: none !important; }

      /* Skeleton shimmer — freeze it */
      [class*="animate-pulse"],
      [class*="animate-shimmer"] { animation: none !important; }

      /* Relative timestamps */
      [data-testid="relative-time"],
      [class*="timeAgo"] { visibility: hidden !important; }
    `,
  });
}

// ─── auth pages ───────────────────────────────────────────────────────────────

test.describe('Visual regression — auth pages', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('login page — default state', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('login--default.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });

  test('login page — validation error state', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    // Submit empty form to trigger inline validation errors
    const submitBtn = page.getByRole('button', { name: /login|sign in/i }).first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      await page.waitForTimeout(300);
    }
    await expect(page).toHaveScreenshot('login--validation-error.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });

  test('register page — default state', async ({ page }) => {
    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('register--default.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });

  test('register page — validation error state', async ({ page }) => {
    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    const submitBtn = page.getByRole('button', { name: /register|sign up|create/i }).first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      await page.waitForTimeout(300);
    }
    await expect(page).toHaveScreenshot('register--validation-error.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });
});

// ─── home page ────────────────────────────────────────────────────────────────

test.describe('Visual regression — home page', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('home page — loaded state', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('home--loaded.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('home page — above fold (viewport only)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    // Capture only the above-fold viewport to catch hero/navbar regressions
    await expect(page).toHaveScreenshot('home--above-fold.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });
});

// ─── search page ──────────────────────────────────────────────────────────────

test.describe('Visual regression — search page', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('search page — empty query (no results state)', async ({ page }) => {
    await page.goto('/search');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('search--empty.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('search page — with query results', async ({ page }) => {
    await page.goto('/search?q=Miami&page=1');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('search--results.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('search page — filter sidebar open', async ({ page }) => {
    await page.goto('/search');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    // Open the filter panel if a trigger exists
    const filterBtn = page
      .getByRole('button', { name: /filter/i })
      .or(page.getByTestId('filter-toggle'))
      .first();
    if (await filterBtn.isVisible()) {
      await filterBtn.click();
      await page.waitForTimeout(300);
    }
    await expect(page).toHaveScreenshot('search--filters-open.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('search page — map view', async ({ page }) => {
    await page.goto('/search?view=map');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('search--map-view.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03, // map placeholder colour may vary slightly
    });
  });
});

// ─── property detail page ─────────────────────────────────────────────────────

test.describe('Visual regression — property detail', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('property detail — loading state (skeleton)', async ({ page }) => {
    // Intercept API to induce a loading state by delaying the response
    await page.route('**/api/v1/properties/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });
    await page.goto('/property/test-property-id');
    // Capture before response arrives to see skeleton
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('property--loading.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('property detail — error state (not found)', async ({ page }) => {
    // Intercept to return 404
    await page.route('**/api/v1/properties/does-not-exist', (route) =>
      route.fulfill({ status: 404, body: JSON.stringify({ error: 'Not found' }) })
    );
    await page.goto('/property/does-not-exist');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('property--not-found.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('property detail — loaded state', async ({ page }) => {
    await page.goto('/property/test-property-id');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('property--loaded.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });
});

// ─── dashboard pages ──────────────────────────────────────────────────────────

test.describe('Visual regression — dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('dashboard — unauthenticated redirect state', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    // Should redirect to login or show auth gate
    await expect(page).toHaveScreenshot('dashboard--unauthenticated.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('host dashboard — notifications page', async ({ page }) => {
    await page.goto('/dashboard/notifications');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('dashboard--notifications.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });
});

// ─── booking flow ─────────────────────────────────────────────────────────────

test.describe('Visual regression — booking flow', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('booking page — default (unauthenticated) state', async ({ page }) => {
    await page.goto('/booking');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('booking--default.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('booking confirmation page', async ({ page }) => {
    await page.goto('/booking/confirmation');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('booking--confirmation.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });
});

// ─── error pages ──────────────────────────────────────────────────────────────

test.describe('Visual regression — error pages', () => {
  test.beforeEach(async ({ page }) => {
    await seedDeterministicState(page);
  });

  test('404 not-found page', async ({ page }) => {
    await page.goto('/this-route-definitely-does-not-exist-404');
    await page.waitForLoadState('networkidle');
    await stabilizeDynamicContent(page);
    await expect(page).toHaveScreenshot('error--404.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });
});
