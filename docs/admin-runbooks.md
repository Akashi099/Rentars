# Admin Runbooks

Operational step-by-step procedures for every privileged admin action on Rentars.

**Read before acting:**
- Every action in this document is logged to `audit_logs` with actor ID, IP, timestamp, and metadata.
- HIGH-RISK actions require a second admin to supply their user ID in the `X-Approval-Actor` request header (dual approval). Self-approval is rejected.
- When removing a role from a user, their active session tokens remain valid until they expire (max 15 min). For immediate revocation, rotate `JWT_SECRET` — this invalidates all tokens platform-wide.
- All USDC transactions on Stellar are irreversible. Verify booking IDs and amounts before approving any financial action.

---

## Role Reference

| Role | Scopes | Notes |
|---|---|---|
| `admin` | All scopes | Full platform access. Reserved for platform operators. |
| `moderator` | Content, disputes, analytics | Cannot access financial records. |
| `support` | Read-only: users, bookings, properties, audit | No mutations. |
| `finance` | Refund approval, reconciliation | Dual approval required for all mutations. |

To assign a role, update the `role` column in the `users` table:
```sql
UPDATE users SET role = 'moderator' WHERE id = '<user_id>';
```
Verify the constraint allows the value: `tenant | host | admin | moderator | support | finance`.

Removing a role means setting it back to a non-admin value:
```sql
UPDATE users SET role = 'tenant' WHERE id = '<user_id>';
```
New privileged operations are blocked immediately. In-flight requests using existing tokens complete normally (tokens last ≤ 15 min).

---

## Runbook 1 — Suspend a User

**Scope required:** `admin:users:suspend`  
**Roles:** `admin` only  
**Risk:** HIGH — dual approval required (`X-Approval-Actor` header)  
**Reversible:** Yes (use Activate User runbook)

### When to use
- Credible reports of fraud, abuse, harassment, or platform policy violations.
- Law enforcement request with valid legal process.

### Steps

1. **Gather evidence.** Document the reason in your incident tracking system. Reference ticket ID in the API call.

2. **Get approval.** A second admin must agree to the suspension. Note their user ID.

3. **Call the API:**
   ```bash
   curl -X POST https://api.rentars.app/api/v1/admin/users/<USER_ID>/suspend \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>" \
     -H "X-Approval-Actor: <APPROVING_ADMIN_USER_ID>" \
     -H "Content-Type: application/json"
   ```

4. **Verify** the response is `{ "message": "User suspended." }`.

5. **Check audit log:**
   ```bash
   curl "https://api.rentars.app/api/v1/admin/audit-logs?targetId=<USER_ID>" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```
   Confirm entries for both actors appear.

6. **Notify the user** via email (if legally permissible) referencing the ticket.

### Rollback
If suspension was in error, follow Runbook 2 immediately.

---

## Runbook 2 — Activate (Unsuspend) a User

**Scope required:** `admin:users:activate`  
**Roles:** `admin`, `moderator`  
**Risk:** Medium  
**Reversible:** Yes

### Steps

1. Confirm the suspension reason has been addressed.

2. **Call the API:**
   ```bash
   curl -X POST https://api.rentars.app/api/v1/admin/users/<USER_ID>/activate \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

3. **Verify** response: `{ "message": "User activated." }`.

4. **Check audit log** for `admin.user_activate` entry.

---

## Runbook 3 — Suspend a Property Listing

**Scope required:** `admin:properties:suspend`  
**Roles:** `admin`, `moderator`  
**Risk:** Medium — active bookings are NOT automatically cancelled  
**Reversible:** Yes

### When to use
- Listing violates community standards or local regulations.
- Safety concern reported by a guest.
- DMCA / legal takedown request.

### Steps

1. Note property ID from the admin dashboard (`GET /api/v1/admin/properties`).

2. **Check for active bookings** before suspending:
   ```bash
   curl "https://api.rentars.app/api/v1/admin/bookings?status=Confirmed" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```
   Filter results by `property_id`. If active bookings exist, coordinate with support to notify affected guests before proceeding.

3. **Suspend:**
   ```bash
   curl -X POST https://api.rentars.app/api/v1/admin/properties/<PROPERTY_ID>/suspend \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

4. **Verify** response and check audit log for `admin.property_suspend`.

### Rollback
```bash
curl -X POST https://api.rentars.app/api/v1/admin/properties/<PROPERTY_ID>/activate \
  -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
```

---

## Runbook 4 — Resolve a Dispute

**Scope required:** `admin:disputes:resolve`  
**Roles:** `admin`, `moderator`  
**Risk:** HIGH — escrow is settled; action triggers irreversible USDC transfer  
**Dual approval required:** Yes (`X-Approval-Actor` header)

### When to use
A tenant or host has opened a dispute on a confirmed booking and escalated to platform review.

### Investigation checklist (complete before resolving)

- [ ] Read the dispute reason on the booking record.
- [ ] Review booking dates, check-in confirmation, and any messages between parties.
- [ ] Check the audit log for all state changes on the booking.
- [ ] Contact both parties for evidence if needed.
- [ ] Determine outcome: `refund_tenant` | `release_to_host` | `split`.

### Steps

1. **List open disputes:**
   ```bash
   curl "https://api.rentars.app/api/v1/admin/disputes" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

2. **Get booking details:**
   ```bash
   curl "https://api.rentars.app/api/v1/admin/bookings?status=disputed" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

3. **Get second-admin approval** (required). Note their user ID.

4. **Resolve:**
   ```bash
   curl -X POST https://api.rentars.app/api/v1/admin/disputes/<BOOKING_ID>/resolve \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>" \
     -H "X-Approval-Actor: <APPROVING_ADMIN_USER_ID>" \
     -H "Content-Type: application/json" \
     -d '{
       "resolution_note": "Evidence reviewed. Host provided check-in confirmation. Releasing to host.",
       "outcome": "release_to_host"
     }'
   ```
   Valid `outcome` values: `refund_tenant` | `release_to_host` | `split`.

5. **Verify** the booking status changed to `dispute_resolved`.

6. **Check audit log** for `dispute.resolve` entry with both actor IDs.

7. **Notify both parties** by email with the resolution summary.

### Escrow settlement
- `refund_tenant` — TrustlessWork escrow cancelled → USDC returned to tenant wallet.
- `release_to_host` — TrustlessWork escrow released → USDC sent to host wallet.
- `split` — Currently handled by resolving to host and issuing a separate manual refund (Runbook 5).

---

## Runbook 5 — Manual Refund Approval

**Scope required:** `admin:refunds:approve`  
**Roles:** `admin`, `finance`  
**Risk:** HIGH — financial; dual approval required  
**Reversible:** No — USDC on Stellar is irreversible

### When to use
- Dispute resolved in tenant's favour with partial reimbursement.
- Goodwill refund approved by product team.
- Billing error correction.

### Pre-approval checklist

- [ ] Confirm the booking ID and current status.
- [ ] Verify the refund amount does not exceed `total_price` on the booking.
- [ ] Obtain written approval from a second `admin` or `finance` role holder.
- [ ] Create a ticket in your financial tracking system and note the ticket ID.

### Steps

1. **Get booking details** to confirm `total_price`:
   ```bash
   curl "https://api.rentars.app/api/v1/admin/bookings" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

2. **Approve the refund:**
   ```bash
   curl -X POST https://api.rentars.app/api/v1/admin/refunds/approve \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>" \
     -H "X-Approval-Actor: <APPROVING_ADMIN_USER_ID>" \
     -H "Content-Type: application/json" \
     -d '{
       "booking_id": "<BOOKING_ID>",
       "refund_amount": 125.50,
       "reason": "Partial refund per dispute resolution TICKET-1234. Approved by finance lead."
     }'
   ```

3. **Verify** response includes `"message": "Refund approved."` and both actor IDs.

4. **Check audit log:**
   ```bash
   curl "https://api.rentars.app/api/v1/admin/audit-logs?targetId=<BOOKING_ID>" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```
   Confirm `manual_refund_approved` entry with `dual_approval: true`.

5. **Reconciliation:** Record the refund in your financial reconciliation sheet with the audit log entry ID.

---

## Runbook 6 — Emergency: Revoke All Admin Sessions

**Scope required:** Shell / infrastructure access  
**Risk:** HIGH — revokes ALL user sessions platform-wide  
**Reversible:** Yes (issue new tokens after rotating secret back or to a new value)

### When to use
- Suspected admin credential compromise.
- JWT secret leak.

### Steps

1. **Rotate `JWT_SECRET`** in your deployment environment (Fly.io secret, AWS Parameter Store, etc.):
   ```bash
   # Example: Fly.io
   fly secrets set JWT_SECRET=$(openssl rand -hex 32) --app rentars-backend
   ```
   This immediately invalidates **all** existing JWTs. Users will need to log in again.

2. **Rotate `ADMIN_JWT_SECRET`** if set separately:
   ```bash
   fly secrets set ADMIN_JWT_SECRET=$(openssl rand -hex 32) --app rentars-backend
   ```

3. **Verify** the backend restarted and is healthy:
   ```bash
   curl https://api.rentars.app/health
   ```

4. **Re-issue** admin tokens to verified admin staff.

5. **Audit** recent `admin.*` entries in the audit log for any actions taken with compromised credentials:
   ```bash
   curl "https://api.rentars.app/api/v1/admin/audit-logs?limit=200" \
     -H "Authorization: Bearer <NEW_ADMIN_JWT>"
   ```

---

## Runbook 7 — Reconciliation Review

**Scope required:** `admin:reconciliation:read`  
**Roles:** `admin`, `finance`  
**Risk:** Low (read-only)

### Periodic reconciliation steps (recommended: weekly)

1. **Export bookings for the period:**
   ```bash
   curl "https://api.rentars.app/api/v1/admin/bookings?status=Completed" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```

2. **Cross-check with TrustlessWork** escrow settlement records for the same period. Every `Completed` booking should have a corresponding released escrow.

3. **Check for orphaned escrows** — bookings with `status = Cancelled` but `escrow_id` not null. These should have been cancelled on TrustlessWork. If any are stuck, raise a TrustlessWork support ticket.

4. **Review manual refunds** approved in the period:
   ```bash
   curl "https://api.rentars.app/api/v1/admin/audit-logs?action=payment.confirmed" \
     -H "Authorization: Bearer <YOUR_ADMIN_JWT>"
   ```
   Filter for `meta.action = manual_refund_approved`.

5. **Platform fee reconciliation:** Total platform revenue = sum of `platform_fee` across all `Completed` bookings in the period (fee = `total_price × 0.05`).

---

## Monitoring & Alerting

| Signal | Source | Action |
|---|---|---|
| `openDisputes > 10` | Admin dashboard | Assign moderator to review queue |
| Rate-limit `total > 100` in 1h | `GET /admin/rate-limits` | Investigate for DDoS or scraping |
| `audit_logs` gap > 1h | Log aggregation | Check backend health |
| Failed `payment.confirmed` | Audit log | Check TrustlessWork status page |
| Unexpected `admin.*` action outside business hours | Audit log alert | Treat as potential credential compromise; follow Runbook 6 |

---

## Adding a New Admin User

```sql
-- 1. Find or create the user account
SELECT id, email, role FROM users WHERE email = 'newadmin@example.com';

-- 2. Assign the least-privilege role needed
UPDATE users
SET role = 'moderator'   -- or: support, finance, admin
WHERE id = '<USER_ID>';

-- 3. Verify
SELECT id, email, role FROM users WHERE id = '<USER_ID>';
```

The user's next login will produce a JWT with the new role claim. There is no need to restart the backend.

---

## Removing an Admin User

```sql
UPDATE users SET role = 'tenant' WHERE id = '<USER_ID>';
```

New privileged API requests are blocked immediately. Existing tokens expire within 15 minutes. For immediate revocation, follow Runbook 6.

---

## See Also

- [`docs/RECOVERY_RUNBOOK.md`](./RECOVERY_RUNBOOK.md) — Cross-component recovery runbook (DB, storage, Redis, contracts, RPC, email, frontend) with owners, RTO/RPO targets, and the monthly nonproduction drill. Runbook 6 above is the JWT-secret-rotation step referenced from the recovery runbook's §3 dual-approval table.
- [`docs/backup-restore-verification.md`](./backup-restore-verification.md) — Database-only restore drill detail.
- [`docs/INCIDENT_REVIEW_TEMPLATE.md`](./INCIDENT_REVIEW_TEMPLATE.md) — Post-incident review template used by the recovery drill retrospective.
