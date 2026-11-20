# Authentication Hardening (Issues #740–#743)

This document describes how authentication tokens, abuse controls, audit records,
and browser-facing protections behave, and which settings operators can change.

## 1. Recovery and verification tokens (#740)

| Token | Storage | Lifetime | Single use |
|---|---|---|---|
| Email verification | SHA-256 hash in `users.email_verification_token` | 24 h | Claimed by a conditional update (`email_verified = false` and token matches) |
| Password reset | SHA-256 hash in `password_reset_tokens.token_hash` | 60 min | Claimed by a conditional update (`consumed_at IS NULL` and not expired) before the password changes |

- Raw tokens are 32 random bytes, emailed once, and never stored.
- Requesting a reset consumes every earlier unused reset token for that user.
- If the password change fails, the claim is released so the same link can be retried.
- **Concurrent use:** two requests with the same link cannot both succeed. The loser
  receives `INVALID_TOKEN`.
- **Enumeration:** `POST /auth/password-reset/request` returns the same body for known and
  unknown addresses, takes at least `PASSWORD_RESET_MIN_RESPONSE_MS` (500 ms), and sends
  email without awaiting delivery. Delivery failures are logged, never returned.
- **Session invalidation:** a successful reset (and `logout-all-devices`) records a
  revocation marker in Redis (`session:revoked-before:<userId>`). The session guard rejects
  any Bearer token whose `iat` predates the marker, with `401 SESSION_REVOKED`. The guard
  fails closed: if Redis cannot be read, it returns `503 SESSION_CHECK_UNAVAILABLE`.
- The JWT fallback secret (`'secret'`) has been removed. A missing `JWT_SECRET` rejects tokens.

**Known limit:** `iat` has one-second resolution, so a token issued in the same second as a
revocation is still accepted.

## 2. Abuse controls on authentication endpoints (#741)

Every auth route has an IP bucket. Routes that carry an account identifier also have an
account bucket keyed by the normalized email (or Stellar address). Keys are hashed before
they reach the store.

| Route | IP bucket | Account bucket |
|---|---|---|
| `POST /auth/register` | yes | email |
| `POST /auth/login` | yes | email |
| `POST /auth/refresh` | yes | — |
| `POST /auth/password-reset/request` | yes | email |
| `POST /auth/password-reset/confirm` | yes | — |
| `POST /auth/verify-email` | yes | — |
| `POST /auth/wallet/challenge` | yes | Stellar address |
| `POST /auth/wallet/verify` | yes | Stellar address |

**Operator overrides** (all optional, positive integers):

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_IP_RATE_POINTS` | `30` | Requests per IP per window |
| `AUTH_IP_RATE_WINDOW_SECONDS` | `60` | IP window |
| `AUTH_ACCOUNT_RATE_POINTS` | `10` | Requests per account per window |
| `AUTH_ACCOUNT_RATE_WINDOW_SECONDS` | `900` | Account window |

**Trusted proxies:** set `TRUST_PROXY` when the API sits behind a load balancer.
Without it, every client shares one bucket.

| Value | Effect |
|---|---|
| unset / `false` | Ignore `X-Forwarded-For` (default) |
| `1`, `2`, … | Trust that many hops |
| `10.0.0.0/8,loopback` | Trust only these addresses |
| `true` | **Rejected at startup.** It lets any client choose its own rate-limit key. |

**Redis failure:** auth routes return `503 RATE_LIMIT_UNAVAILABLE` and do not fall back to a
per-process limiter, because that would multiply the limit by the instance count. Redis
is required for login regardless (refresh tokens are stored there).

**Shared networks:** the IP bucket is generous so users behind one NAT are not throttled by
a neighbour. The account bucket limits guessing against one target. Recovery still works
from a shared IP as long as the account bucket is not exhausted.

## 3. Audit records for sensitive operations (#742)

Each sensitive action writes one record through `auditLogger.log`, with actor, target
resource, correlation ID, outcome, and timestamp.

| Action | Audit action name |
|---|---|
| Password reset requested | `auth.password_reset_request` |
| Password reset completed | `auth.password_reset_confirm` |
| Email verified | `auth.email_verify` |
| Logout / logout everywhere | `auth.logout`, `auth.logout_all_devices` |
| Wallet linked | `account.wallet_link` |
| Refund approved (admin) | `admin.refund_approve` |
| Dispute resolved | `dispute.resolve` |
| User or property suspended / activated | `admin.*` |

- **Redaction:** metadata keys matching credential, key-material, raw-payload, or body
  patterns are stored as `[REDACTED]`. Nested objects and arrays are sanitized recursively.
  Strings longer than 255 characters are truncated.
- **Append-only:** migration `00065_audit_logs_append_only.sql` adds a trigger that rejects
  `UPDATE` and `DELETE` on `audit_logs` for every role. Retention does not touch this table.
- **Search:** audit queries remain behind admin scopes (`GET /admin/audit-logs`).

## 4. Browser transport, CORS, and CSRF (#743)

**Token transport.** The API authenticates with `Authorization: Bearer` tokens. The web app
reads the access token from `localStorage` and sends it in the header. A cross-site page
cannot attach that header, so cross-site request forgery does not reach authenticated routes.
The tradeoff is that any script running on the web origin (for example through an XSS bug)
can read the token. Moving the token to an HttpOnly cookie would remove that exposure, but it
would bring back the CSRF exposure this document describes. That is a separate decision.
The only cookie the API sets is the CSRF double-submit cookie (`__Host-csrf-token`, not
HttpOnly, `SameSite=Strict`, `Secure` in production).

**CORS.**
- Only origins listed in `CORS_ORIGIN` receive `Access-Control-Allow-Origin`. Other origins
  get no CORS headers and the browser blocks the read. The request is not turned into a 500.
- Wildcards are rejected at startup.
- In production, `CORS_ORIGIN` must be set explicitly and every entry must be `https://`.
  The development default (`http://localhost:3001`) is never used by omission.

**CSRF.** Mutating requests without an `Authorization: Bearer` header must send the
`X-CSRF-Token` header matching the `__Host-csrf-token` cookie. A cross-site form or script
cannot read the cookie, so it cannot forge a matching header, and a cross-site form post
without a Bearer token is rejected with `403 CSRF_TOKEN_MISSING`.

Bearer requests skip the double-submit check. The API stores no session in cookies, so a
Bearer request has no ambient credentials to forge. A cross-site page cannot set the
`Authorization` header without a CORS preflight, and preflight succeeds only for origins in
`CORS_ORIGIN`. The web client sends Bearer tokens and does not send `X-CSRF-Token`, so this
exemption is what keeps its mutations working.

In development over plain HTTP, browsers ignore the `__Host-` cookie because it requires `Secure`.

## Role hierarchy and assignment (#916)

- **Authority:** `users.role` in the database is the only source of truth. The JWT `role` claim is a cache for route gating; the admin role-change endpoint re-reads the actor's role from the database before acting.
- **Roles:** `tenant`, `host` (non-privileged); `admin`, `moderator`, `support`, `finance` (privileged). The `both` value in the web types is not stored by the backend.
- **Who can change roles:** only an `admin` (scope `admin:users:role`), via `PATCH /api/v1/admin/users/:id/role` with body `{ "role": "<role>" }`. Unknown body fields are rejected.
- **Transition matrix:** defined in `apps/backend/src/config/roleTransitions.ts`. Privileged roles are granted and removed only through a non-privileged role. Self-changes and demotion of the last admin are refused.
- **Profile updates:** `PATCH /api/profile` cannot set `role`, `status`, `verified`, `verification_status`, or identity fields. Such keys are dropped by the validator and again in the service.
- **Audit:** every attempt writes `admin.user_role_change` (allowed) or `admin.user_role_change_denied` (refused) with actor, target, old role, new role, and request correlation ID.
- **Client display:** the web app reads its role from `GET /api/auth/me`, never from localStorage. If the server cannot confirm the role, the UI shows no role.
- **Known gap:** a demoted admin keeps admin-family access on existing tokens until they expire. Shorter access-token lifetimes or a token-version check would close this.

## CAPTCHA enforcement (#917)

hCaptcha is verified **server-side** by `captchaMiddleware` (`apps/backend/src/middleware/captcha.middleware.ts`). The client sends the token as `captchaToken`; the server calls hCaptcha `siteverify` with a 5 s timeout.

**Protected endpoints** (verification required on every request):

| Endpoint | Why |
|---|---|
| `POST /api/auth/register` | Account creation at scale |
| `POST /api/auth/login` | Credential stuffing |
| `POST /api/auth/password-reset/request` | Reset-email flooding |

**Documented exemptions** (no CAPTCHA; each is protected another way):

| Endpoint | Protection instead |
|---|---|
| `POST /api/auth/wallet/challenge`, `POST /api/auth/wallet/verify` | Wallet signature proof plus per-route rate limits |
| `POST /api/auth/password-reset/confirm` | Single-use reset token from email |
| `POST /api/auth/verify-email` | Single-use verification token plus rate limit |
| `POST /api/auth/refresh`, `POST /api/auth/logout*` | Refresh-token possession, no new account or credential attempt |

**Outcomes** (all fail closed; a provider problem never accepts a request):

| Situation | HTTP | Code | Retryable |
|---|---|---|---|
| No token, or token over 4096 chars | 422 | `CAPTCHA_TOKEN_MISSING` | No (complete the challenge) |
| Provider rejects token | 422 | `CAPTCHA_INVALID` | Yes, with a new challenge |
| Token expired or already used | 422 | `CAPTCHA_EXPIRED` | Yes, with a new challenge |
| Provider timeout, network error, non-2xx, or unreadable answer | 503 | `CAPTCHA_UNAVAILABLE` | Yes, after `Retry-After: 5` |
| `HCAPTCHA_SECRET_KEY` missing in production | 503 | `CAPTCHA_MISCONFIGURED` | No (operator fix) |

`HCAPTCHA_ENABLED=false` bypasses verification in development and CI only. In production it is ignored and logged.

**Web client:** `HCaptcha.tsx` announces load failures and challenge errors in a live region with a keyboard-reachable "Try again". Tokens are single-use, so `LoginForm` and `RegisterForm` clear the token and reset the widget after every submit attempt.

## Profile field ownership and updates (#918)

The `profiles` table (migration `00005`) has these columns: `user_id`, `display_name`, `avatar_url` (VARCHAR 255), `bio`, `phone`, `stellar_address`, `verified`, `created_at`, `updated_at`. The API maps `name` to `display_name` in one place (`apps/backend/src/services/profile.service.ts`).

| Field | API name | Visibility | Writable by owner | Notes |
|---|---|---|---|---|
| Display name | `name` | Public | Yes | Required and non-empty after trimming |
| Avatar | `avatar_url` | Public | Yes | http(s) URL, at most 255 characters. Upload storage is not implemented |
| Stellar address | `stellar_address` | Public | Yes | Must match `^G[A-Z2-7]{55}$`. Changes are audited as `account.wallet_link` on both PATCH paths |
| Verification | `verification_status` | Public | No | Derived from `verified` |
| Phone | `phone` | Private (owner only) | Yes | E.164-style |
| Bio | `bio` | Private (owner only) | Yes | At most 500 characters |
| Timestamps | `created_at`, `updated_at` | Private | No | `updated_at` is set on every write |
| Identity and privilege | `id`, `user_id`, `role`, `status`, `verified` | Server-owned | No | Dropped from any update |

Removed from the API because no column exists: `address`, `preferred_currency`, `last_active`, `stellar_wallet`.

**Partial updates:** `PATCH /api/profile` writes only the keys present. An omitted key keeps its stored value, and an explicit `null` clears an optional field.

**Concurrent edits:** optionally send `expected_updated_at` (the `updated_at` last read). If the stored value has changed, the server returns `409 PROFILE_CONFLICT` with the current profile, and the web form adopts it instead of overwriting.

**Public view:** `GET /api/profile/:id` returns only the public fields and no completeness data, which would reveal which private fields are empty.
