# Quarterly Backlog Triage Process

> Established per [Issue #843](https://github.com/Rentars/Rentars/issues/843)

## Purpose

The repository accumulates TODO material, implementation notes, and operational
gaps. Without recurring triage, stale or completed work obscures current risk.
This document defines the cadence, roles, labels, and artifacts that keep the
backlog healthy.

---

## Label Taxonomy

Labels are grouped by prefix. Every active tracker item **must** carry at least
one label from each group.

### Priority (`prio:`)

| Label | Meaning |
|-------|---------|
| `prio:P0` | Launch blocker — must land before next release |
| `prio:P1` | High — target current sprint |
| `prio:P2` | Medium — target current quarter |
| `prio:P3` | Low — backlog candidate, not committed |

### Scope (`scope:`)

| Label | Meaning |
|-------|---------|
| `scope:backend` | Backend / API / database |
| `scope:frontend` | Web frontend / UI |
| `scope:blockchain` | Stellar / Soroban contracts |
| `scope:infra` | CI/CD, Docker, infrastructure |
| `scope:security` | Security, auth, RLS |
| `scope:docs` | Documentation only |

### Status (`status:`)

| Label | Meaning |
|-------|---------|
| `status:triage` | Awaiting initial triage (fresh issue) |
| `status:ready` | Triaged, ready for work |
| `status:in-progress` | Actively being worked |
| `status:blocked` | Blocked by a dependency |
| `status:review` | In code review / QA |
| `status:stale` | No activity for 90+ days — candidate for closure |
| `status:dupe` | Duplicate of another issue |

### Ownership (`owner:`)

| Label | Meaning |
|-------|---------|
| `owner:unassigned` | No owner yet — must be assigned during triage |
| `owner:backend` | Backend team owner |
| `owner:frontend` | Frontend team owner |
| `owner:blockchain` | Blockchain team owner |
| `owner:devops` | DevOps / infra owner |

---

## Triage Cadence

### Weekly ( Mondays )

- Review new issues tagged `status:triage`.
- Assign owner, priority, and scope labels.
- Remove `status:triage` and replace with `status:ready` (or close as dupe / wontfix).

### Quarterly ( last week of each quarter )

The quarterly review is the core of this process. Each quarter-end:

1. **Inventory all open issues** — pull the full list and sort by `prio:` label.
2. **Close duplicates and completed items** — attach the closing PR or commit
   reference. Record rationale in the close comment.
3. **Mark stale** — any item with no activity for 90+ days gets `status:stale`.
   After another 30 days with no activity, close with a comment explaining why.
4. **Review dependencies** — check `depends-on:` links. If a blocker has been
   resolved, move the dependent item to `status:ready`.
5. **Review launch blockers** — every `prio:P0` item is confirmed as still
   blocking or downgraded with recorded rationale.
6. **Record roadmap decisions** — update [BACKLOG_TRACKER.md](./BACKLOG_TRACKER.md)
   with what was reviewed, closed, reprioritized, and why.
7. **Reliability metrics review** — examine incident count, p95 latency, error
   rate, and uptime for the quarter. Create or update issues for any regressions.

### Quarterly Review Record

Each quarterly review adds a section to [BACKLOG_TRACKER.md](./BACKLOG_TRACKER.md)
with the following structure:

```markdown
## Q4 2026 Review — 2026-12-20

**Reviewer(s):** @lead1, @lead2
**Issues reviewed:** N
**Issues closed:** X (duplicates: Y, stale: Z, completed: W)
**Launch blockers confirmed:** K
**New issues created:** M

### Decisions
- Closed #123 — duplicate of #100 (rationale: same root cause)
- Downgraded #200 from P0 → P2 (rationale: workaround deployed)
- Created #300 — reliability regression in search latency

### Reliability Metrics
- Incidents this quarter: 3 (down from 5)
- p95 API latency: 180ms (target: <200ms)
- Uptime: 99.97% (target: 99.9%)
```

---

## Dependency Tracking

Dependencies are tracked via GitHub's "Linked issues" feature and the
`depends-on:` prefix in issue descriptions:

```markdown
depends-on: #123, #456
```

During triage, the reviewer verifies that linked blockers are still open. If a
blocker has been closed, the dependent issue is moved to `status:ready`.

---

## Acceptance Criteria Checklist

Every active tracker item must satisfy:

- [ ] **Owner** — assigned to a team member or `owner:` label
- [ ] **Priority** — one `prio:` label
- [ ] **Scope** — one `scope:` label
- [ ] **Next action** — the most recent comment describes the next concrete step
- [ ] **Dependencies** — blockers are linked and visible (or "none")

Items missing any of these after two weekly triage cycles are escalated.
