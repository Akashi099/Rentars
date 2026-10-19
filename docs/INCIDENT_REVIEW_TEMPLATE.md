# Incident Review Template

Use this template for every qualifying production incident (see [severity criteria](#severity-criteria) below).
Complete each section as the incident unfolds and finalise it within **72 hours** of resolution.

The goal of this process is blameless learning: we investigate systems and decisions, not individuals.
Sensitive data (keys, PII, internal URLs) must be redacted before the document is shared or stored.

---

## Incident metadata

| Field | Value |
|---|---|
| **Incident ID** | INC-YYYY-NNN |
| **Title** | Short description, e.g. "Escrow service unavailable — bookings rejected" |
| **Severity** | P1 / P2 / P3 / P4 — see [Severity criteria](#severity-criteria) |
| **Status** | Investigating → Mitigated → Resolved → Review complete |
| **Incident start** | YYYY-MM-DD HH:MM UTC |
| **Incident end (mitigated)** | YYYY-MM-DD HH:MM UTC |
| **Incident end (resolved)** | YYYY-MM-DD HH:MM UTC |
| **Total duration** | H h M m |
| **Incident commander** | @github-handle |
| **Technical lead** | @github-handle |
| **Reviewers** | @handle1, @handle2 |
| **Related alerts / links** | PagerDuty alert, Sentry issue, Stellar status link, etc. |
| **Related release** | Git SHA or deploy ID if correlated with a deployment |

---

## Severity criteria

| Severity | Description | Examples |
|---|---|---|
| **P1 — Critical** | Complete service loss or data integrity at risk; all users affected | API 100 % down, escrow funds at risk, auth system broken |
| **P2 — High** | Core flow broken for a significant user segment; no workaround | Booking creation failing, search returning 500s for >10 % of requests |
| **P3 — Medium** | Degraded experience; workaround exists | Slow search (>3 s p99), non-critical notifications missing |
| **P4 — Low** | Minor issue; minimal user impact | UI label wrong, one metric missing from dashboard |

Incidents at P1 or P2 **must** produce a completed review.
P3 incidents should produce a review; P4 incidents may use a lightweight summary instead.

---

## 1. Impact

> What did users experience? Quantify where possible.

- **Users affected**: e.g. "~40 % of booking attempts" or "all users on mainnet"
- **Flows affected**: e.g. booking creation, search, escrow release, login
- **Revenue impact**: e.g. estimated USDC locked / lost, bookings blocked
- **Data integrity**: Was any data corrupted or lost? (yes / no — detail if yes)
- **External visibility**: Did users report it publicly (social media, support tickets)?

---

## 2. Timeline

Provide a chronological account of events. Use UTC timestamps.

| UTC timestamp | Event |
|---|---|
| YYYY-MM-DD HH:MM | First alert fired / first user report |
| HH:MM | Incident commander paged |
| HH:MM | Investigation begins |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Service restored (mitigated) |
| HH:MM | Incident fully resolved |
| HH:MM | Communication sent to users (if applicable) |

---

## 3. Detection

> How was the incident detected? Was detection timely?

- **Detection method**: alert, user report, health check, manual observation
- **Alert that fired** (or should have fired): metric name, threshold, tool
- **Time between start and detection**: e.g. 4 minutes
- **Was detection fast enough?** If not, what gap exists?

---

## 4. Response

> What actions were taken to mitigate and resolve the incident?

### Mitigation steps
1. Step one
2. Step two
3. …

### Communication
- Internal: how and when was the on-call team notified?
- External: was a status-page update or user notification sent? When?

### Tools used
- Runbook referenced: link to the relevant section of [`RUNBOOKS.md`](../apps/backend/RUNBOOKS.md)
- Log queries used: paste key queries
- Dashboards consulted: list dashboard URLs or names

---

## 5. Root cause analysis

> What was the **direct cause** of the incident?
> What were the **contributing factors** (process, tooling, code, configuration) that allowed it to happen?

### Direct cause
One or two sentences describing the immediate technical cause.

### Contributing factors
Use a 5-Whys or fishbone approach. List each factor:

- Factor 1: e.g. "No alerting on Trustless Work API timeout"
- Factor 2: e.g. "Retry logic used fixed delay instead of exponential backoff"
- Factor 3: …

### What went well
- …

### What could have gone better
- …

---

## 6. Action items

Each action item must have an owner and a due date.
Track completion in the next operational meeting.

| # | Action | Owner | Due date | Issue/PR link | Status |
|---|---|---|---|---|---|
| 1 | Add alert: `escrow_failures_total > 5 in 5 m` | @handle | YYYY-MM-DD | #issue | Open |
| 2 | Implement exponential backoff in escrow retry | @handle | YYYY-MM-DD | #issue | Open |
| 3 | Add runbook section for X scenario | @handle | YYYY-MM-DD | #issue | Open |

---

## 7. Sensitive data handling

Confirm the following before sharing or storing this document:

- [ ] No private keys, seed phrases, or API tokens are included.
- [ ] No user PII (names, emails, wallet addresses of real users) is included — use counts or anonymised identifiers only.
- [ ] Internal infrastructure URLs or IP addresses are redacted.
- [ ] Log excerpts are trimmed to include only what is necessary for the analysis.

---

## 8. Sign-off

| Role | Name | Date |
|---|---|---|
| Incident commander | | |
| Technical lead | | |
| Engineering manager (P1/P2) | | |

---

## Appendix (optional)

Attach or link:
- Relevant log excerpts (redacted)
- Metric graphs from the incident window
- Blockchain transaction IDs involved
- Rollback diff or hotfix PR link
