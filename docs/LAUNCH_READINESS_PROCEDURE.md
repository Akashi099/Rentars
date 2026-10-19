# Launch Readiness Procedure

This document describes the step-by-step process for completing, reviewing, and
archiving a launch readiness record for every production release of Rentars.

The canonical template is `LAUNCH_READINESS.md` at the repository root.
Completed records are archived at `docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md`.

---

## 1. When to use this process

Run the full readiness process for:
- Any release that touches the Stellar/Soroban contracts.
- Any change to the escrow or payment flow.
- Any release that modifies authentication, authorisation, or RLS policies.
- Major version bumps (vX.0.0).
- The first release to a new environment (e.g. mainnet).

A lightweight check (sections 1, 2, 8 only) is acceptable for:
- Minor / patch releases that are documentation or copy-only changes.
- Hotfixes applied to a single service with no schema changes (record the
  exception in the release notes).

---

## 2. Roles and responsibilities

| Role | GitHub team | Responsible sections |
|---|---|---|
| Release manager | @rentars/release | Overall coordination; final sign-off |
| Functional lead | @rentars/engineering | Section 1 — Functional |
| Security lead | @rentars/security | Section 2 — Security |
| Blockchain lead | @rentars/contracts | Section 3 — Contract |
| Payments lead | @rentars/payments | Section 4 — Payment |
| Accessibility lead | @rentars/frontend | Section 5 — Accessibility |
| Platform lead | @rentars/platform | Section 6 — Performance |
| Privacy lead | @rentars/privacy | Section 7 — Privacy |
| Infrastructure lead | @rentars/infra | Sections 8 & 9 — Monitoring & Backup |
| Support lead | @rentars/support | Section 10 — Support |

---

## 3. Step-by-step process

### Step 1 — Create the release candidate

1. Tag the release candidate commit: `git tag v<version>-rc1 <commit-sha>`.
2. Run the manifest generator:
   ```bash
   bun run release:manifest --version <version>
   ```
3. Commit the generated manifest to `docs/releases/manifest-<version>.json`.
4. Push the branch and open a release PR titled `release: v<version>`.

### Step 2 — Copy and assign the readiness record

1. Copy the template:
   ```bash
   cp LAUNCH_READINESS.md docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md
   ```
2. Fill in the **Release metadata** section with the version, commit SHA,
   manifest path, environment, planned date, release manager, and sign-off deadline.
3. Assign each section an owner (GitHub handle) and notify them via a comment
   on the release PR.

### Step 3 — Section owners complete their sections

Each owner must:

1. Work through each criterion in their section.
2. For every ✅ criterion: add a link to the supporting evidence (CI run URL,
   audit report, monitoring dashboard, PR number, or internal wiki link).
   **A checkbox without evidence is not accepted.**
3. For every ☐ that cannot be completed before launch: add a row to the
   **Open risks** table with:
   - A plain-English description of the risk.
   - Their GitHub handle as owner.
   - An honest impact assessment.
   - A concrete mitigation (not "will fix later").
   - An expiry date (when this risk must be resolved or re-reviewed).
4. Sign off with their handle and date.

### Step 4 — Release manager review

The release manager must:

1. Verify every 🔴 criterion is either ✅ or has an accepted open-risk row.
2. Confirm every open-risk row has an owner, mitigation, and expiry.
3. Confirm the `manifest-<version>.json` commit SHA matches the release candidate.
4. Confirm the `database.latest_migration` in the manifest is consistent with
   the target environment.
5. Add their final sign-off in the **Release manager sign-off** section.

### Step 5 — Commit and tag

1. Commit the completed readiness record to the release branch.
2. Create the final release tag:
   ```bash
   git tag -a v<version> <commit-sha> -m "Release v<version>"
   git push origin v<version>
   ```
3. Attach the following files to the GitHub Release notes:
   - `docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md`
   - `docs/releases/manifest-<version>.json`

### Step 6 — Post-launch

1. Complete the 48-hour monitoring checklist (Appendix B of the readiness record).
2. File GitHub issues for every accepted open risk (link back to the readiness record).
3. Confirm the release record is archived and linked from `docs/releases/rollback.md`.

---

## 4. Blocking vs advisory criteria

| Symbol | Meaning |
|---|---|
| 🔴 | **Blocking** — release is blocked until this is complete or risk-accepted with named owner and expiry. |
| 🟡 | **Advisory** — noted in the record; does not block release on its own. |

A section sign-off is valid only when:
- All 🔴 rows are either ✅ or covered by an open-risk entry.
- All open-risk entries have owner, impact, mitigation, and expiry.

---

## 5. Evidence standards

| Type | Minimum evidence |
|---|---|
| CI test pass | Link to the specific CI run (GitHub Actions run URL). |
| Manual test | Screen recording or written test report with date and tester name. |
| Audit | Link to the audit report PDF; named finding IDs for any resolved issues. |
| Monitoring | Dashboard screenshot with timestamp, or alert firing confirmation. |
| Code review | PR number; "reviewed" is not sufficient — link to the PR. |
| Drill / exercise | Written drill report with date, tester, result (pass/fail), and any gaps found. |

A generic "verified" or "done" without a link is not accepted evidence.

---

## 6. Open-risk acceptance criteria

An open risk is accepted only when ALL of the following are true:

1. **Owner** — a named individual (GitHub handle), not a team.
2. **Impact** — a specific, honest description of what happens if the risk materialises.
3. **Mitigation** — a concrete action already in place (not a promise to fix later).
4. **Expiry** — a specific date by which the risk must be resolved or re-reviewed.
5. **Tracking** — a GitHub issue filed for the risk, linked from the readiness record.

---

## 7. Archiving and retrieval

Completed readiness records are stored at:
```
docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md
```

To find the readiness record for a given version:
```bash
ls docs/releases/LAUNCH_READINESS_*.md
```

The corresponding release manifest is at:
```
docs/releases/manifest-<version>.json
```

Both files are committed to the repository and immutable after the release tag
is created.  If a post-release correction is needed, file a GitHub issue and
add a note to the existing file — do not delete or replace the original.

---

*Document owner: Platform team*
*Last updated: 2026-10-16*
*Closes: #842*
