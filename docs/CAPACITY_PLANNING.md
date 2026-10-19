# Capacity Planning — Search and Booking

This document defines the supported throughput and latency targets for the Rentars
search and booking systems, records benchmark methodology, documents known saturation
points, and provides a worksheet for projecting scaling needs as the platform grows.

---

## 1. Scope

The systems covered are:

| System | Entry point | Primary bottleneck candidates |
|---|---|---|
| Property search | `GET /api/v1/properties/search/advanced` | PostgreSQL full-text (GIN index), Redis cache, API workers |
| Search autocomplete | `GET /api/v1/properties/search/suggestions` | PostgreSQL B-tree index, Redis |
| Booking creation | `POST /api/v1/bookings` | PostgreSQL write + row-lock, Stellar RPC call, Trustless Work escrow API |
| Booking status | `GET /api/v1/bookings/:id` | Redis cache, PostgreSQL read |
| Availability check | `GET /api/v1/availability/:propertyId` | PostgreSQL date-range query |

---

## 2. Supported throughput targets

These are the **design targets** for the current implementation.
Each target assumes the associated infrastructure tier listed in Section 4.

### 2.1 Search

| Metric | Target | Basis |
|---|---|---|
| Full-text search latency (p50) | < 50 ms | GIN index + 60 s Redis cache |
| Full-text search latency (p99) | < 200 ms | Uncached cold query with up to 50 k listings |
| Autocomplete latency (p99) | < 50 ms | B-tree prefix index |
| Geolocation radius search (p99) | < 300 ms | PostGIS `search_nearby_properties()` |
| Search cache hit rate | > 70 % | 60 s TTL on popular queries |
| Concurrent search requests | 200 req/s | 2 API worker replicas + Redis |
| Listings in catalogue | up to 50 000 | Beyond this, re-evaluate index strategy |

### 2.2 Booking

| Metric | Target | Basis |
|---|---|---|
| Booking creation latency (p50) | < 800 ms | Includes Stellar RPC + DB write |
| Booking creation latency (p99) | < 3 000 ms | Includes Trustless Work escrow call |
| Concurrent booking creation | 20 req/s | Constrained by Stellar RPC and escrow API rate limits |
| Availability check latency (p99) | < 100 ms | Indexed date-range scan |
| Booking read latency (p99) | < 100 ms | Redis cache hit |
| Bookings per property per day | up to 5 | Row-level lock duration is negligible at this rate |

---

## 3. Benchmark methodology

### 3.1 Tooling

| Tool | Purpose |
|---|---|
| [k6](https://k6.io) | HTTP load generation and scenario scripting |
| Playwright | Browser-level concurrent booking flow simulation |
| `EXPLAIN ANALYZE` (PostgreSQL) | Query plan validation per listing-count milestone |
| Supabase query performance dashboard | Slow-query identification in staging |
| `GET /metrics` (Prometheus endpoint) | Runtime histogram and counter collection |

### 3.2 Search benchmark procedure

1. Seed the staging database with a representative dataset:
   - 1 000, 10 000, and 50 000 property rows using `apps/backend/database/seed.ts`.
2. Disable Redis cache (`REDIS_ENABLED=false`) to measure raw DB performance.
3. Run k6 with the following scenario:
   ```
   Ramp up: 0 → 50 VUs over 30 s
   Steady:  50 VUs for 2 min
   Ramp up: 50 → 200 VUs over 30 s
   Steady:  200 VUs for 2 min
   Ramp down: 200 → 0 over 30 s
   ```
4. Record p50 / p95 / p99 latency and error rate at each VU level.
5. Re-enable Redis and repeat to measure cache impact.
6. Record the VU count at which p99 first exceeds the target (saturation point).

### 3.3 Booking benchmark procedure

1. Use a k6 scenario that simulates the full booking creation flow:
   - `POST /api/v1/bookings` with a real Stellar testnet keypair and a mocked
     Trustless Work API response (to isolate internal latency from third-party latency).
2. Start at 5 concurrent users, increase by 5 every 60 seconds.
3. Record the concurrency level at which:
   - p99 latency exceeds 3 000 ms, or
   - error rate exceeds 1 %.
4. Record separately: latency with and without the Stellar RPC call to isolate
   third-party contribution.

### 3.4 Redis and queue behaviour

1. **Redis cache:**
   - Run the search benchmark twice: once with `REDIS_ENABLED=false` (Section 3.2 step 2)
     and once with the cache enabled; record the p99 delta and hit rate from
     `cache_hits_total / (cache_hits_total + cache_misses_total)`.
   - Measure Redis CPU and memory during the 200 VU steady phase; note the point at
     which memory exceeds 75 % of configured max (Section 6 threshold).
2. **Queue behaviour (booking pipeline):**
   - If the async booking queue (BullMQ + Redis, Tier 3 remediation) is enabled, run the
     Section 3.3 scenario and record queue depth, worker lag, and job failure rate at
     each VU level.
   - If the queue is not yet deployed, record the synchronous-path numbers as the
     baseline and note "queue: not deployed" in the worksheet so future runs are
     comparable.
3. **Costs:** for each run, note infrastructure tier, instance sizes, and estimated
   monthly cost so scaling recommendations include a cost projection, not just latency.

### 3.5 Frequency

| Event | Action |
|---|---|
| New feature that touches search or booking | Run targeted benchmark against affected endpoint |
| Catalogue grows past 10 k / 25 k / 50 k listings | Run full search benchmark suite |
| Infrastructure tier change | Run full benchmark suite and update Section 5 |
| Quarterly | Run abbreviated benchmark (search only, 10 k listings) to detect drift |

---

## 4. Infrastructure tiers

### Tier 0 — Development / CI

| Resource | Spec |
|---|---|
| API | 1 worker, Bun local process |
| PostgreSQL | Supabase free tier (shared) |
| Redis | Single node, local Docker |
| Stellar RPC | Testnet (`soroban-testnet.stellar.org`) |

### Tier 1 — Staging / Early production (≤ 5 000 listings, ≤ 50 concurrent users)

| Resource | Spec |
|---|---|
| API | 2 replicas, 1 vCPU / 512 MB each |
| PostgreSQL | Supabase Pro (dedicated, 2 vCPU / 8 GB) |
| Redis | Managed Redis, 1 GB |
| Stellar RPC | Testnet or dedicated node |

### Tier 2 — Growth (5 000–50 000 listings, 50–200 concurrent users)

| Resource | Spec |
|---|---|
| API | 4 replicas, 2 vCPU / 1 GB each, behind a load balancer |
| PostgreSQL | Supabase Pro with read replica |
| Redis | Managed Redis cluster, 4 GB |
| Stellar RPC | Dedicated Stellar Core + RPC node (or Ankr / QuickNode SLA plan) |

### Tier 3 — Scale (> 50 000 listings or > 200 concurrent users)

At this tier, the following architectural changes should be evaluated:

- Introduce a dedicated search service (e.g. Typesense or Elasticsearch) to offload PostgreSQL.
- Move booking creation to an async queue (e.g. BullMQ + Redis) to decouple Stellar RPC latency from the HTTP response.
- Add a CDN layer in front of the Next.js frontend for static and ISR pages.
- Consider read replicas for `properties` and `bookings` tables.

---

## 5. Capacity worksheet

Update the values in the **Measured** column after each benchmark run.

### 5.1 Search

| Listing count | Cold p99 (target < 200 ms) | Cached p99 (target < 50 ms) | Max sustained RPS before p99 breaches target | Measured date |
|---|---|---|---|---|
| 1 000 | — | — | — | not yet measured |
| 10 000 | — | — | — | not yet measured |
| 25 000 | — | — | — | not yet measured |
| 50 000 | — | — | — | not yet measured |

### 5.2 Booking creation

| Concurrency (VUs) | p99 latency (ms) | Error rate (%) | Stellar RPC contribution (ms) | Measured date |
|---|---|---|---|---|
| 5 | — | — | — | not yet measured |
| 10 | — | — | — | not yet measured |
| 20 | — | — | — | not yet measured |
| 30 | — | — | — | not yet measured |

### 5.3 Headroom assumptions

| Resource | Current utilisation | Saturation point | Headroom |
|---|---|---|---|
| PostgreSQL CPU | — | — | — |
| PostgreSQL connections | — | max_connections (default 100) | — |
| Redis memory | — | configured max | — |
| API worker heap | — | container memory limit | — |
| Stellar RPC (testnet) | — | ~100 req/s (shared) | — |
| Trustless Work API | — | per-plan rate limit | — |

---

## 6. Scaling triggers and monitoring

The following metric thresholds should trigger a capacity review.
All metrics are exposed at `GET /metrics` (Prometheus format).

| Metric | Alert threshold | Action |
|---|---|---|
| `http_request_duration_seconds{route="/api/v1/properties/search/advanced"}` p99 | > 200 ms for 5 min | Investigate cache hit rate; check GIN index health |
| `http_request_duration_seconds{route="/api/v1/bookings"}` p99 | > 3 000 ms for 5 min | Check Stellar RPC latency; consider async booking queue |
| `process_heap_used_bytes / process_heap_bytes` | > 0.80 for 5 min | Scale horizontally or investigate memory leak |
| PostgreSQL connection pool saturation | > 80 % of `max_connections` | Enable pgBouncer or increase pool size |
| Redis memory utilisation | > 75 % of configured max | Increase Redis memory or review TTL values |
| Search cache hit rate (`cache_hits_total / (cache_hits_total + cache_misses_total)`) | < 50 % | Review TTL; investigate cache key distribution |

---

## 7. Known bottlenecks and remediation plans

| Bottleneck | Impact | Priority | Remediation |
|---|---|---|---|
| Stellar RPC latency (testnet shared node) | Booking p99 > 3 s when RPC is congested | High | Provision a dedicated RPC node or use a paid provider before mainnet launch |
| Trustless Work API as synchronous dependency | Booking creation blocks on external HTTP call | High | Introduce async queue: respond 202 Accepted, finalise escrow in background |
| GIN index not covering all search filter combinations | Slow queries for rarely-used filter combos at > 25 k listings | Medium | Add composite indexes after benchmark identifies slow paths |
| Redis single-node for cache | Single point of failure for cache layer | Medium | Migrate to managed Redis cluster before Tier 2 |
| No DB read replica | All reads hit the primary Supabase instance | Low (< 5 k listings) | Add read replica when Tier 2 is reached |

---

## 8. References

- Search implementation details: [`SEARCH_IMPLEMENTATION.md`](../SEARCH_IMPLEMENTATION.md)
- Operational runbooks with latency SLOs: [`apps/backend/RUNBOOKS.md`](../apps/backend/RUNBOOKS.md)
- Alerting thresholds: [RUNBOOKS.md — Alerting Thresholds Reference](../apps/backend/RUNBOOKS.md#alerting-thresholds-reference)
- **SLIs, SLOs, error budgets, and alert rules: [`docs/SLO.md`](./SLO.md)**
- Deployment infrastructure: [`DEPLOYMENT.md`](../DEPLOYMENT.md)
- Architecture overview: [`ARCHITECTURE.md`](../ARCHITECTURE.md)
