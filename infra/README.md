# Rentars — Infrastructure as Code

This directory contains the declarative infrastructure configuration for all
Rentars environments.  It is the authoritative source for environment topology,
secret references, network layout, and service configuration.

> **Operator procedures live elsewhere.** This file describes *what* the
> infrastructure is. For *how* to deploy, verify, and roll back, see:
> - [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — staging/testnet deployment guide,
>   prerequisites, verification steps, and production limitations.
> - [`../docs/RECOVERY_RUNBOOK.md`](../docs/RECOVERY_RUNBOOK.md) — incident
>   response, backup restore, and failover procedures.
>
> Capabilities described here are **code-complete** unless explicitly marked
> **deployment-verified**. Real-network and mainnet steps are gated and require
> operator approval.

---

## Directory layout

```
infra/
├── README.md                  ← this file
├── environments/
│   ├── staging/
│   │   ├── .env.staging        ← non-secret staging env overrides (committed)
│   │   └── secrets.reference.md ← documents every secret key; values in provider
│   └── production/
│       ├── .env.production     ← non-secret production env overrides (committed)
│       └── secrets.reference.md
├── docker-compose.staging.yml  ← full staging stack (api + redis + nginx)
├── docker-compose.prod.yml     ← production stack (symlinked from apps/backend)
└── terraform/
    ├── main.tf                 ← provider config, backend state
    ├── variables.tf            ← input variable declarations
    ├── outputs.tf              ← output values (URLs, IPs, ARNs)
    ├── staging.tfvars          ← staging-specific variable values (non-secret)
    ├── production.tfvars       ← production-specific variable values (non-secret)
    └── modules/
        ├── networking/         ← VPC, subnets, security groups
        ├── compute/            ← Container service (ECS Fargate / Fly.io / GKE)
        ├── redis/              ← Managed Redis (ElastiCache / Upstash / Memorystore)
        ├── cdn/                ← CDN + WAF rules (CloudFront / Cloudflare)
        └── monitoring/         ← Alerting, log aggregation, uptime checks
```

---

## Environments

| Environment | Purpose | Frontend URL | Backend API URL | Supabase project |
|---|---|---|---|---|
| `local` | Developer workstation | `http://localhost:3000` | `http://localhost:3001` | Local Supabase CLI (`supabase start`) |
| `staging` | Pre-production validation | `https://staging.rentars.app` | `https://api.staging.rentars.app` | Separate staging Supabase project |
| `production` | Live user traffic | `https://rentars.app` | `https://api.rentars.app` | Production Supabase project |

Each environment uses a **distinct Supabase project**; never point staging or
local tooling at the production project. The local stack is started with the
Supabase CLI and its ports are defined in `supabase/config.toml` (API `54321`,
DB `54322`, Studio `54323`).

### Service ports

| Service | Local port | Notes |
|---|---|---|
| Frontend (`apps/web`) | `3000` | Next.js dev server |
| Backend API (`apps/backend`) | `3001` | Bun HTTP server |
| Redis | `6379` | Local Docker Compose only |
| Nginx (reverse proxy) | `80` / `443` | Staging/production stacks only |
| Supabase API / DB / Studio | `54321` / `54322` / `54323` | Local Supabase CLI |

Ports in `docker-compose.staging.yml` and `docker-compose.prod.yml` must match
this table; update both files and this table together.

---

## Secret management

**No plaintext secret values are committed to this repository.**

All secrets (API keys, JWT secrets, database passwords, TLS certificates) are
stored in a secrets provider and referenced by name.  See each environment's
`secrets.reference.md` for the full list of required keys and the provider path
where each value lives.

The committed `.env.staging` / `.env.production` files contain **non-secret
overrides only** (ports, log levels, feature flags, public URLs). Any key whose
name matches `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_TOKEN`, or `DATABASE_URL`
must appear only in `secrets.reference.md` and the provider — never in a
committed file. Local developer secrets belong in an untracked `.env.local`
(git-ignored); use the committed `.env.example` templates as the starting point.

Recommended providers (choose one per deployment target):
- **AWS Secrets Manager** — inject via ECS task definition `secrets:` block
- **GitHub Actions Secrets** — inject as `env:` in workflow steps
- **Fly.io Secrets** — inject via `fly secrets set KEY=VALUE`
- **Docker Secrets** (Swarm) — inject via `secrets:` in Compose v3.1+

---

## CI plan validation

Every PR that modifies `infra/terraform/**` triggers the `infra-plan` CI job
(see `.github/workflows/infra-plan.yml`).  The job runs `terraform plan` in
dry-run mode and posts a diff summary as a PR comment.

- Destructive changes (resource deletions, replacement) are highlighted in red.
- The job fails if any `destroy` or `replace` action targets a stateful resource
  (database, Redis, storage bucket).
- Plans are uploaded as CI artifacts for 30 days.

**Never apply Terraform changes directly from a local machine against staging or
production.**  All applies run via the `infra-apply` job which requires manual
approval from the `infra-approvers` team.

---

## Updating base-image digests

Base-image digest pins live in `apps/backend/Dockerfile` and `apps/web/Dockerfile`.
To update them:

```bash
# Backend
docker pull oven/bun:1.2-alpine
docker inspect oven/bun:1.2-alpine --format '{{index .RepoDigests 0}}'

# Frontend
docker pull node:20.19-alpine
docker inspect node:20.19-alpine --format '{{index .RepoDigests 0}}'
```

Update the digest comments and `@sha256:...` references in both Dockerfiles,
then open a PR.  The `image-scan` CI step will re-scan the new image before merge.

---

## Manual exceptions (managed services)

The following resources cannot be fully managed via Terraform because they are
controlled through vendor dashboards:

| Resource | Vendor | Manual steps | Tracked in |
|---|---|---|---|
| Supabase project | Supabase | Project creation, extensions, connection pooler | `environments/*/secrets.reference.md` |
| Stellar contract deployment | Stellar / Soroban | `soroban contract deploy` CLI (gated; see `../DEPLOYMENT.md`) | `apps/contracts/DEPLOY.md` |
| Trustless Work API key | Trustless Work | Dashboard key rotation | Secrets provider |
| DNS records | Cloudflare / Route 53 | Manual zone delegation | Ops Notion page |
| TLS certificates | Let's Encrypt / ACM | Auto-renewed via ACME | n/a |

### Deployment verification status

| Capability | Status | Verified by |
|---|---|---|
| Local stack (Compose + Supabase CLI) | **Deployment-verified** | `../DEPLOYMENT.md` local section |
| Staging stack (Compose + migrations) | **Deployment-verified** | `../DEPLOYMENT.md` staging section |
| Terraform plan/apply pipeline | Code-complete | `infra-plan` / `infra-apply` CI jobs |
| Production stack | **Not deployment-verified** | Requires gated operator run |
| Mainnet contract deployment | **Gated** | Operator approval + `../DEPLOYMENT.md` |
