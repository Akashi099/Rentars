# Rentars Data Inventory

**Version:** 2026-09-24.1  
**Owner:** Platform Engineering / Legal  
**Review cycle:** Quarterly or on any schema change

This document maps every personal and sensitive data field collected by Rentars to its collection purpose, access controls, retention period, and deletion behaviour. It is the internal counterpart to the user-facing [Privacy Policy](../apps/web/src/app/privacy/page.tsx).

---

## How to read this document

| Column | Meaning |
|---|---|
| Field / table | Database table and column, storage bucket path, or log field |
| Category | Personal (P), Sensitive (S), Financial (F), Behavioural (B), Blockchain-public (BC) |
| Purpose | Why it is collected |
| Who can access | Roles/services with read access |
| Retention | How long the data is kept |
| Deletion | What happens on user account deletion |
| Notes | Blockchain immutability, third-party sharing, etc. |

---

## 1. Identity & Authentication

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `users.email` | P | Account login, transactional emails | auth service, admin (read) | Life of account + 30 days | Anonymised to `deleted-<id>@rentars.invalid` | Never shared with hosts/tenants publicly |
| `users.email_verified` | P | Verify email before booking | auth service, admin | Life of account | Deleted with account | — |
| `users.password_hash` | S | Authentication | auth service only | Life of account | Deleted | bcrypt hash, never logged |
| `users.role` | P | RBAC | auth service, admin | Life of account | Deleted | — |
| `users.status` | P | Account moderation | admin | Life of account | Deleted | — |
| `users.created_at` | P | Fraud detection, analytics | admin | Life of account + 30 days | Deleted | — |
| `password_reset_tokens` (table) | S | Password recovery | auth service | 1 hour (TTL per token) | Expired automatically | Tokens are hashed; raw token never stored |
| `email_verification_tokens` (table) | S | Email verification | auth service | 24 hours (TTL) | Expired automatically | — |
| `refresh_tokens` (table) | S | Session management | auth service | 7 days (TTL) | Revoked on logout / account deletion | Rotated on each use |

---

## 2. User Profile

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `profiles.display_name` | P | Public user identity | all authenticated users | Life of account | Deleted | Shown on listings and reviews |
| `profiles.avatar_url` | P | Public user identity | all authenticated users | Life of account | Supabase Storage object deleted | Stored in `avatars/` bucket |
| `profiles.bio` | P | Public profile | all authenticated users | Life of account | Deleted | User-authored content |
| `profiles.stellar_address` | BC | USDC payment settlement | all authenticated users (visible in booking context), blockchain (public) | Life of account | Removed from DB; on-chain record is permanent | **Publicly visible on Stellar ledger. Users are informed at wallet-connection time.** |
| `profiles.location` | P | Optional display | all authenticated users | Life of account | Deleted | City-level only; never GPS coordinates |
| `profiles.phone` | P | Optional; host verification | host, admin | Life of account | Deleted | Not shared with tenants |

---

## 3. Property Listings

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `properties.title`, `.description` | P | Listing display | public | Life of listing + 30 days | Soft-deleted (`deleted_at`), then hard-deleted after 30 days | — |
| `properties.address`, `.city`, `.country` | P | Location display, search | public | Life of listing + 30 days | Soft/hard deleted | Street-level address shown only to confirmed tenants; city shown publicly |
| `properties.latitude`, `.longitude` | P | Map display, geospatial search | public (approximate), confirmed tenants (precise) | Life of listing + 30 days | Deleted | Coordinates fuzzed ±0.01° for public map tiles |
| `properties.owner_id` | P | Host identification | booking service, admin | Life of listing + 30 days | Deleted | Links to `users.id` |
| `properties.on_chain_id` | BC | Soroban contract reference | public (blockchain) | Permanent (on-chain) | DB reference deleted; on-chain record permanent | On-chain record includes title and price — no PII |
| `properties.price_per_night` | F | Booking calculation | public | Life of listing | Deleted | — |
| `property_images` (table + Storage) | P | Listing display | public | Life of listing + 30 days | Storage objects deleted; table rows deleted | EXIF data stripped on upload via sharp |

---

## 4. Bookings

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `bookings.tenant_id` | P | Booking ownership | tenant, host (property owner), admin | 7 years (financial record) | Anonymised after 7 years | Legal retention for financial records |
| `bookings.property_id` | P | Booking reference | tenant, host, admin | 7 years | Retained (anonymised) | — |
| `bookings.check_in`, `.check_out` | P | Stay dates | tenant, host, admin | 7 years | Retained (anonymised) | — |
| `bookings.total_price` | F | Payment record | tenant, host, admin, finance role | 7 years | Retained (anonymised) | — |
| `bookings.guest_count` | P | Capacity enforcement | tenant, host, admin | 7 years | Retained (anonymised) | — |
| `bookings.escrow_id` | BC | TrustlessWork escrow reference | tenant, host, admin, blockchain | Permanent (on-chain) | DB reference retained; on-chain permanent | Escrow amount publicly visible on Stellar |
| `bookings.on_chain_id` | BC | Soroban booking record | public (blockchain) | Permanent | DB reference retained; on-chain permanent | On-chain record includes amounts and addresses |
| `bookings.rules_acknowledged_at` | P | Consent evidence | tenant, admin | 7 years | Retained | — |
| `bookings.terms_version`, `.terms_accepted_at` | P | Legal consent record | tenant, admin, legal | 7 years | Retained | Immutable after booking creation |
| `bookings.dispute_reason` | P | Dispute context | tenant, host involved, admin | 7 years | Retained (anonymised) | — |
| `bookings.refund_amount`, `.refund_tier` | F | Refund record | tenant, admin, finance | 7 years | Retained (anonymised) | — |
| `booking_status_history` (table) | P | Audit trail | tenant, admin | 7 years | Retained (anonymised) | — |
| `booking_modifications` (table) | P | Modification audit | tenant, host, admin | 7 years | Retained (anonymised) | — |

---

## 5. Payments

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `payments.amount_usdc` | F | Payment record | tenant, admin, finance | 7 years | Retained (anonymised) | — |
| `payments.stellar_tx_hash` | BC | Transaction proof | tenant, host, admin, public (blockchain) | Permanent | DB reference retained; on-chain permanent | **Publicly visible on Stellar ledger** |
| `payments.status` | F | Payment state | tenant, admin | 7 years | Retained | — |
| `payments.metadata` | F | Debugging context | admin | 7 years | Retained | Must not contain raw wallet keys or seed phrases |

---

## 6. Reviews

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `reviews.rating`, `.comment` | P | Platform trust, search ranking | public | Life of review + 30 days | Soft-deleted, author name removed | User can request review deletion via support |
| `reviews.author_id` | P | Review ownership | admin | Life of review | Anonymised on user deletion | — |
| `reviews.moderation_status` | P | Content moderation | admin, moderator | Life of review | Deleted | — |

---

## 7. Messages

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `messages.content` | S | Host-tenant communication | sender, recipient, admin (moderation only) | 2 years | Deleted on account deletion of both parties | Admin access only for active moderation cases |
| `messages.sender_id`, `.recipient_id` | P | Message routing | sender, recipient, admin | 2 years | Anonymised | — |

---

## 8. Notifications

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `notifications` (table) | P | In-app alerts | owning user only | 90 days | Deleted | — |
| `notification_preferences` (table) | P | User consent for channels | owning user, email service | Life of account | Deleted | — |
| Push tokens (`push_subscriptions`) | P | Push delivery | push service only | Until user unsubscribes or token expires | Deleted on account deletion | — |

---

## 9. Wallet & Blockchain

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `wallet_auth` (table) | S | Wallet-based authentication | auth service | Life of account | Deleted | Challenge nonces rotated per-session |
| `blockchain_logs` (table) | BC | On-chain operation audit | admin, engineering | 2 years | Retained | No private keys; tx hashes and operation types only |
| Stellar wallet address (public key) | BC | Payment settlement | public (blockchain) | **Permanent — cannot be deleted from Stellar ledger** | DB reference removed; on-chain record immutable | **Disclosed prominently: wallet addresses and transaction amounts are publicly visible to anyone on the Stellar network** |

---

## 10. Analytics & Search

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `search_analytics` (table) | B | Search improvement, zero-result detection | admin, moderator | 1 year | Deleted | Queries are stored without user ID; no PII linkage |
| `property_views` (table) | B | Listing analytics | host (own property), admin | 1 year | Deleted | IP addresses hashed before storage |
| `saved_searches` (table) | P | User convenience | owning user only | Until user deletes or account deletion | Deleted | — |

---

## 11. Audit Logs

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| `audit_logs.actor_id` | P | Accountability | admin, finance | 7 years | **Not deleted** — required for legal/regulatory compliance | Append-only; no update/delete API |
| `audit_logs.action`, `.resource_type`, `.resource_id` | P | Action trail | admin, finance | 7 years | Not deleted | — |
| `audit_logs.ip` | P | Security forensics | admin | 7 years | Not deleted | — |
| `audit_logs.meta` | P | Action context | admin | 7 years | Not deleted | Must not contain passwords or seed phrases |

---

## 12. Logs & Infrastructure

| Field | Category | Purpose | Access | Retention | Deletion | Notes |
|---|---|---|---|---|---|---|
| Application logs (stdout → log aggregator) | P | Debugging, incident response | engineering | 30 days | Auto-rotated | User IDs may appear; no passwords or wallet keys |
| Redis session/cache | P | Rate limiting, token storage | backend service | TTL per key (max 7 days) | Automatically expired | Never persisted to disk in production |
| Error tracking (if Sentry configured) | S | Bug detection | engineering | 90 days | Deletable via Sentry dashboard | PII scrubbing rules must be configured |

---

## 13. Third-Party Data Sharing

| Third party | Data shared | Purpose | User visibility |
|---|---|---|---|
| **Supabase** | All DB tables, Storage objects | Database hosting, auth, file storage | Privacy Policy |
| **TrustlessWork** | `escrow_id`, `booking_id`, wallet addresses, USDC amounts | Escrow creation and settlement | Privacy Policy |
| **Stellar Network** | Wallet addresses, transaction amounts, contract invocations | Blockchain settlement (public ledger) | Privacy Policy; disclosed at wallet connection |
| **Nodemailer / SMTP provider** | User email address, notification content | Transactional email delivery | Privacy Policy |
| **Redis** | Session tokens, rate-limit counters | Caching | Internal only |
| **Codecov** | Code coverage data (no user data) | CI coverage reporting | N/A |

---

## 14. Data Subject Rights

| Right | Mechanism | Notes |
|---|---|---|
| Access | User dashboard export (planned) / support request | Provides all non-blockchain personal data |
| Rectification | User profile edit | Self-service for profile fields |
| Deletion | Account deletion flow | See deletion column above; blockchain and 7-year financial records cannot be deleted |
| Portability | JSON export via support request | Covers profile, bookings, reviews, messages |
| Withdraw consent | Notification preferences page | Email/push channels toggled per-type |

---

## 15. Blockchain Immutability Notice

The following data is recorded on the **public Stellar blockchain** and **cannot be deleted** after it is written:

- Stellar wallet addresses involved in any transaction
- USDC payment amounts
- Escrow creation, release, and cancellation records
- On-chain property listing IDs
- On-chain booking IDs and status transitions

This is disclosed to users:
1. At wallet connection time (UI banner)
2. In the `TermsDisclosure` component shown before every booking
3. In the Terms of Service (`/terms`) and Privacy Policy (`/privacy`)

---

## 16. Category Ownership

Every sensitive category has a named owning team accountable for purpose,
access review, retention enforcement, and deletion behaviour.

| Category | Sections | Owner | Review cadence |
|---|---|---|---|
| Identity & Authentication | 1 | Platform Engineering | Quarterly |
| Profile & KYC | 2 | Platform Engineering | Quarterly |
| Listings & Locations | 3 | Backend / Search | Quarterly |
| Bookings & Payments | 4–5 | Finance Engineering | Quarterly |
| Messaging & Evidence | 6–7 | Trust & Safety | Quarterly |
| Notifications | 8 | Platform Engineering | Quarterly |
| Wallet & Blockchain | 9 | Protocol Engineering | Quarterly (ledger data is immutable — see §15) |
| Analytics & Search | 10 | Data / Search | Quarterly |
| Audit Logs | 11 | Security | Annually (7-year retention, append-only) |
| Logs & Infrastructure | 12 | SRE | Quarterly |

### Policy alignment

This inventory is the internal source of truth for the user-facing
[Privacy Policy](../apps/web/src/app/privacy/page.tsx). On each review the owner of
every category above must confirm the corresponding Privacy Policy section still
matches actual collection, retention, and deletion behaviour; discrepancies are
filed as issues against Platform Engineering before the next release.

## Change Log

| Date | Version | Change |
|---|---|---|
| 2026-09-24 | 1.0 | Initial inventory — all tables from migrations 00001–00057 |
| 2026-10-17 | 1.1 | Added category ownership and Privacy Policy alignment check (#837) |
