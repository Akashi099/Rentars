# Synthetic Production Monitoring

Scheduled external probes that verify Rentars works for real users, not just that
internal health endpoints pass. Probes run from outside the deployment boundary and
check public DNS, CORS, frontend rendering, authentication, and search.

**Hard safety rule:** every probe is read-only. No probe may create bookings, hold
escrows, transfer funds, or trigger any Stellar transaction. Mutation testing is
limited to an isolated canary account and never touches real payment rails.

---

## Probe suite

| Probe | Target | Checks | Failure class reported |
|---|---|---|---|
| `site` | `GET https://<host>/` | DNS resolves, TLS valid, HTTP 200, HTML contains app root | `dns`, `tls`, `frontend` |
| `health` | `GET /health` | HTTP 200, JSON status `ok` | `api` |
| `cors` | `OPTIONS /api/v1/properties/search/advanced` from an external origin | `Access-Control-Allow-Origin` present and correct | `cors` |
| `auth` | `POST /api/v1/auth/login` with the isolated canary account | Returns a JWT; `GET /api/v1/profile` with that JWT returns 200; an invalid token returns 401 | `auth` |
| `search` | `GET /api/v1/properties/search/advanced?q=berlin` | HTTP 200, response < 2 s, result shape non-empty for seeded canary listing | `search` |

Each probe records: timestamp, probe name, failed step (if any), HTTP status,
latency, and the deployed release version (read from `/health` response
`version` field or the release manifest).

## Isolation and redaction

- Credentials live only in the CI secret store (`SYNTHETIC_CANARY_EMAIL`,
  `SYNTHETIC_CANARY_PASSWORD`). Never print them; log lines pass through a redactor
  that masks anything matching `password`, `token`, `secret`, or JWT-shaped strings.
- The canary account holds no payment methods and no escrow-capable wallet balance.
- Financial probes are structurally impossible: the probe runner has no code path
  that calls `POST /api/v1/bookings` or any escrow endpoint.

## Alerting

- A single failure pages only for `dns` and `api` (site-down classes).
- All other classes alert after 3 consecutive failed runs (5-minute schedule) to
  avoid flapping.
- The alert payload names the failed probe, the failed step, the release version,
  and links to the last 20 probe results so responders can correlate failures with
  a deployment revision.

## Running locally

```bash
# Read-only probes against a local stack (backend on :3000, web on :3001)
BASE_URL=http://localhost:3000 WEB_URL=http://localhost:3001 bash scripts/synthetic-checks.sh
```

Probes exit non-zero on failure so the script can run as a cron job or CI step.
