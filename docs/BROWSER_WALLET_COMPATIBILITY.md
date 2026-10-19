# Browser and Wallet Compatibility Matrix

This document defines the supported browser and wallet combinations for Rentars,
the required capabilities each combination must meet, fallback behaviour for
unsupported environments, and the test cadence for maintaining this matrix.

> **Users on unsupported browsers** receive a clear banner with guidance and can
> still browse properties without a wallet. Booking and wallet-dependent features
> are gracefully disabled with an explanation.

---

## 1. Supported desktop browsers

| Browser | Minimum version | Wallet support | Core browsing | Notes |
|---|---|---|---|---|
| Chrome | 110+ | ✅ Freighter | ✅ | Primary test target |
| Firefox | 115+ | ✅ Freighter | ✅ | |
| Edge (Chromium) | 110+ | ✅ Freighter | ✅ | Chromium-based; shares Chrome test results |
| Safari | 16.4+ | ⚠️ No Freighter extension | ✅ | Browse-only; wallet features unavailable (see §4) |
| Brave | 1.50+ | ✅ Freighter | ✅ | Chromium-based; test wallet flows independently |
| Opera | 96+ | ✅ Freighter | ✅ | Chromium-based |

### Out of support

| Browser | Reason |
|---|---|
| Chrome < 110 | Missing CSS Container Queries, gap in Safari-compat WebKit APIs |
| Firefox < 115 | Missing `Intl.PluralRules` update used by i18n formatting |
| IE 11 / Legacy Edge | Not supported — modern ES modules, CSS variables, and WebAssembly required |
| Safari < 16.4 | Missing `structuredClone`, `Array.at()`, and CSS `:has()` |

---

## 2. Supported mobile browsers

| Browser | Platform | Minimum version | Wallet support | Notes |
|---|---|---|---|---|
| Chrome for Android | Android 10+ | 110+ | ⚠️ No mobile Freighter | Browse-only on mobile |
| Safari for iOS | iOS 16.4+ | 16.4+ | ⚠️ No mobile Freighter | Browse-only on mobile |
| Firefox for Android | Android 10+ | 115+ | ⚠️ No mobile Freighter | Browse-only on mobile |
| Samsung Internet | Android | 21+ | ⚠️ No mobile Freighter | Browse-only on mobile |

> **Mobile wallet note:** Freighter does not have a mobile extension. Mobile users
> can browse properties, view listings, and read booking details, but cannot
> initiate or confirm bookings that require a wallet signature. This is a known
> limitation documented in §4.

---

## 3. Supported wallet versions

### Freighter (primary wallet)

| Version | Status | Notes |
|---|---|---|
| 12.x+ | ✅ Supported | Current recommended version |
| 11.x | ✅ Supported | |
| 10.x | ⚠️ Best-effort | Some API shape differences; upgrade recommended |
| < 10.x | ❌ Unsupported | `@stellar/freighter-api` API contract not met |

**Required Freighter capabilities:**
- `isConnected()` — wallet connection check
- `getAddress()` — public key retrieval
- `signTransaction()` — XDR transaction signing
- `getNetwork()` — active network detection (testnet / mainnet)

### Other wallets

No other Stellar wallets are officially supported at this time. The `freighter-utils.ts`
abstraction layer is designed to allow future wallet adapters to be added without
changing consumer code.

---

## 4. Required browser capabilities

The following APIs are required for full functionality. They are checked at
runtime in `useCompatibility()`.

| Capability | Used for | Fallback |
|---|---|---|
| `WebExtensions` API | Freighter detection | Wallet features disabled; browse-only mode |
| `Intl.DateTimeFormat` | Date formatting (i18n) | Hard fallback to `en-US` locale |
| `Intl.NumberFormat` | Currency formatting (i18n) | Hard fallback to `en-US` locale |
| `Intl.PluralRules` | Night-count pluralisation | English plural form used |
| `localStorage` | Auth token persistence | Session-only mode (tokens lost on tab close) |
| `fetch` | API calls | Application non-functional; upgrade prompt shown |
| CSS Grid / Flexbox | Layout | Non-functional on unsupported browsers (pre-IE11 out-of-support) |
| WebAssembly | Stellar SDK (transaction building) | Booking flow disabled |
| ES2020+ (optional chaining, nullish coalescing) | Compiled output | Transpiled by Next.js; not a runtime concern |

---

## 5. Fallback behaviour for unsupported environments

### 5a. Unsupported browser (version too old)

- A non-dismissible banner is shown at the top of every page:
  *"Your browser version is not supported. Please upgrade to Chrome 110+,
  Firefox 115+, or Safari 16.4+ for the best experience."*
- Core property browsing continues to work where possible.
- Booking and wallet flows are disabled with an explanation.

### 5b. Freighter not installed

- A contextual prompt is shown when a user attempts to connect a wallet:
  *"Freighter wallet is not installed. [Install Freighter](https://www.freighter.app)"*
- Users can continue browsing without a wallet.
- This state is surfaced by `FreighterError('NOT_INSTALLED')` in `freighter-utils.ts`.

### 5c. Mobile browser (no wallet extension available)

- Wallet-dependent CTAs (Book Now, Connect Wallet) display a message:
  *"Wallet connections require a desktop browser with the Freighter extension."*
- A safe non-wallet browsing path remains fully functional on mobile.

### 5d. Safari (desktop)

- Freighter is not available as a Safari extension.
- The same message as 5c is shown on Safari desktop.
- All non-wallet pages (search, property detail, static content) work normally.

---

## 6. Known limitations

| Limitation | Affected environments | Tracking issue |
|---|---|---|
| No mobile wallet support | All mobile browsers | Tracked — future mobile wallet adapter |
| Safari lacks Freighter extension | Safari desktop | Dependent on Freighter team |
| Freighter < 10.x — API shape differences | Freighter 10.x | #903 |
| WebAssembly blocked by some corporate firewalls | Enterprise networks | Known; documented in support runbooks |

---

## 7. Test cadence

| Test type | Frequency | Scope |
|---|---|---|
| Automated E2E (Playwright) | Every PR | Core search and property detail journeys on Chrome |
| Cross-browser automated | Weekly CI | Chrome, Firefox, Edge — search and booking journeys |
| Real-wallet testnet check | Before every release | Freighter on Chrome + Firefox — full booking flow on testnet |
| Manual Safari check | Monthly | Browse-only journey; confirm wallet fallback message |
| Mobile browser check | Monthly | Chrome Android + Safari iOS — browse-only journey |
| Freighter version regression | On Freighter releases | Install new version; run wallet E2E suite |

Automated cross-browser runs use the `playwright.config.ts` browser matrix.
Real-wallet testnet checks are manual — steps are documented in
`apps/web/e2e/smoke.spec.ts` and `apps/backend/RUNBOOKS.md`.

---

## 8. Adding a new supported combination

1. Verify the browser/wallet combination meets all required capabilities in §4.
2. Add it to the appropriate table in §1, §2, or §3.
3. Add a corresponding Playwright project to `apps/web/playwright.config.ts`.
4. Run the full E2E suite against the new target.
5. Update the test cadence table in §7 if the new combination requires periodic checks.
6. Open a PR referencing this file.

---

## 9. Deprecating a supported combination

1. Announce deprecation in the next release changelog entry under `### Removed`.
2. Add the combination to the "Out of support" table in §1 or §2 with the reason.
3. Ensure the runtime `useCompatibility()` check covers the newly unsupported version.
4. Remove the Playwright project for the deprecated target.

---

*Document owner: Frontend platform team*
*Last updated: 2026-10-16*
*Next review: 2027-01-31 (Q1 roadmap review)*
*Closes: #848*
