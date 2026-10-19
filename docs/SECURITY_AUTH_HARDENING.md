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
