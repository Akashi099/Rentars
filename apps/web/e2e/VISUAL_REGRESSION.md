# Visual Regression Testing

`visual-regression.spec.ts` captures deterministic screenshots of the critical
routes and states so that responsive regressions — clipped cards, overlapping
content, or missing actions/controls — fail CI instead of only showing up in
manual review.

## Coverage

| Route | States captured |
|---|---|
| `/login`, `/register` | default, validation error |
| `/` | loaded (full page), above-fold viewport |
| `/search` | empty, results, filters open, map |
| `/property/:id` | loading skeleton, not-found, loaded |
| `/dashboard`, `/dashboard/notifications` | unauthenticated, notifications |
| `/booking`, `/booking/confirmation` | default, confirmation |
| unknown route | 404 not-found |

Desktop (`chromium`) and mobile (`mobile-chrome`) projects are run in CI.

## Determinism

Volatile content is neutralised before capture (see the spec's
`seedDeterministicState` / `stabilizeDynamicContent` helpers):

- `Date` is frozen so relative timestamps are stable.
- The Freighter wallet API is mocked to a predictable disconnected state.
- Map tiles are replaced with a solid placeholder colour.
- SVG/chart animations and skeleton shimmers are disabled.

Per-test `maxDiffPixelRatio` tolerances (1–3 %) absorb anti-aliasing noise while
still surfacing real layout changes.

## Running locally

```bash
cd apps/web

# Compare against committed baselines
yarn playwright test e2e/visual-regression.spec.ts --project=chromium

# Update baselines after an intentional UI change
yarn playwright test e2e/visual-regression.spec.ts --project=chromium --update-snapshots
yarn playwright test e2e/visual-regression.spec.ts --project=mobile-chrome --update-snapshots
```

## Updating approved baselines

Baselines live next to the spec:

```
apps/web/e2e/visual-regression.spec.ts-snapshots/
```

They are committed to Git and versioned with the code that produces them.

1. Make the UI change and run the update commands above.
2. **Review every changed image** in the pull request diff — confirm the change
   is intentional and that no control was lost or clipped.
3. Commit the regenerated snapshots together with the source change.
4. A reviewer must approve the snapshot diff before merge.

Never approve a baseline update without opening the image. A passing run after a
blind `--update-snapshots` can hide a real regression.

## CI behaviour

The `visual-regression` job in `.github/workflows/ci.yml` runs on every pull
request. On failure it uploads the Playwright report and `test-results/`
directory (actual, expected, and diff images) as a build artifact for review.
