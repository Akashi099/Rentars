# Security Exception Process

## Purpose

Some findings from dependency audits or secret-scanning jobs are low-risk,
require third-party remediation, or are intentional false positives.  This
document defines the process for suppressing a finding without hiding genuine
risks.

## Raising an exception

1. **Open a GitHub issue** with the label `security-exception`.
2. Include the following fields in the issue body:

   | Field | Description |
   |-------|-------------|
   | **Tool** | `yarn audit`, `cargo audit`, `gitleaks`, or `trivy` |
   | **Finding ID** | CVE number, advisory ID, or rule name |
   | **Affected component** | Package name and version |
   | **Severity** | Critical / High / Medium / Low |
   | **Reason for exception** | Why the finding does not represent a real risk in this deployment |
   | **Expiry date** | Max 90 days from today; set to the upstream patch ETA if known |
   | **Owner** | GitHub username of the person accountable for follow-up |

3. Link the issue number in the suppression configuration (see below).
4. The issue must be approved by a maintainer with the `security` team membership.

## Adding a suppression

### yarn audit — `.yarn-audit-suppressions.json` (root)
Add an entry with the advisory ID and issue link:
```json
{
  "advisories": [
    {
      "id": 123456,
      "reason": "Not exploitable in our deployment — see #999",
      "expires": "2027-03-01"
    }
  ]
}
```

### cargo audit — `.cargo/audit.toml`
```toml
[[advisories.ignore]]
id = "RUSTSEC-2023-0001"
# reason: not exploitable in our deployment — see #999
# expires: 2027-03-01
```

### gitleaks — `.gitleaks.toml` (root)
Add the path or regex to the global `[allowlist]` with a comment referencing
the exception issue.

### trivy (container) — `.trivyignore`
```
# REASON: not exploitable — see #999 | EXPIRES: 2027-03-01
CVE-2023-12345
```

## Expired exceptions

The `security-scan` CI job (`dependency-scan` step) checks expiry dates and
fails if an exception has passed its expiry date without being renewed or
resolved.  Expired exceptions are NOT silently ignored.

## Severity thresholds

| Severity | Action |
|----------|--------|
| Critical | Must be resolved or excepted within **7 days** |
| High | Must be resolved or excepted within **30 days** |
| Medium | Tracked; exception allowed with 90-day expiry |
| Low / Informational | Exception allowed; no expiry required |

## What this process does NOT cover

Suppressions apply only to the specific finding ID.  A suppression for CVE-X
does not suppress CVE-Y in the same package, even if they share a root cause.
