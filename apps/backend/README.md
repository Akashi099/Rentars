# Rentars Backend API

A Node.js/Express backend for Rentars, a decentralized rental platform built on Stellar Soroban smart contracts with TrustlessWork escrow integration.

## Overview

Rentars is a rental platform that enables property owners to list rentals and tenants to book them using cryptocurrency. The platform leverages:

- **Stellar Soroban** for smart contract-based property listings and bookings
- **TrustlessWork** for secure escrow payments between tenants and landlords
- **Supabase** for data persistence and authentication
- **Redis** for caching and session management

## Prerequisites

- Node.js 20+
- npm (the backend workspace uses npm scripts; see `package.json`)
- Docker and Docker Compose (for local development)
- A Supabase project (or the local Supabase stack via `supabase start`)
- Stellar testnet account (for blockchain interactions; mainnet is gated, see below)

## Installation

```bash
# From the repository root, install all workspace dependencies
npm install

# Copy the backend environment template
cp apps/backend/.env.example apps/backend/.env.local

# Edit apps/backend/.env.local with your configuration
```

All commands below are run from `apps/backend/` unless stated otherwise.
=======

## Environment Variables

The authoritative list lives in `apps/backend/.env.example`. Copy it to `.env.local`
and fill in values; never commit real secrets. The table below summarizes the keys.

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `NODE_ENV` | Environment (development/test/production) | No |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes |
| `JWT_SECRET` | Secret for JWT token signing | Yes |
| `REDIS_URL` | Redis connection URL | No |
| `CORS_ORIGIN` | Allowed CORS origins | No |
| `STELLAR_NETWORK` | Stellar network (`testnet`; `mainnet` is gated) | No |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | No |
| `PROPERTY_LISTING_CONTRACT_ID` | Property listing smart contract ID | No |
| `BOOKING_CONTRACT_ID` | Booking smart contract ID | No |
| `TRUSTLESS_WORK_API_URL` | TrustlessWork API URL | No |
| `TRUSTLESS_WORK_API_KEY` | TrustlessWork API key | No |
| `GEOCODING_API_KEY` | Geocoding API key (optional) | No |

## Running Locally

### With Node.js

```bash
# Development with hot reload
npm run dev

# Production build
npm run build
npm start
```

### With Docker

```bash
# Development (from the repository root)
docker-compose up -d

# Production (from the repository root)
docker-compose -f docker-compose.prod.yml up -d
```

The API runs at `http://localhost:3000` (port 3000, matching `PORT` in `.env.example`).
=======

## API Reference

### Health Check

```bash
curl -X GET http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "service": "Rentars API 🚀",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok",
    "redis": "ok",
    "blockchain": "ok"
  }
}
```

### Authentication

#### Register

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}'
```

#### Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password123"}'
```

#### Get Current User

```bash
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <token>"
```

### Properties

#### List Properties

```bash
curl -X GET "http://localhost:3000/api/v1/properties?page=1&limit=10"
```

#### Get Property

```bash
curl -X GET http://localhost:3000/api/v1/properties/<property_id>
```

#### Create Property (Owner only)

```bash
curl -X POST http://localhost:3000/api/v1/properties \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Cozy Apartment",
    "description": "A nice place to stay",
    "address": "123 Main St",
    "city": "New York",
    "country": "USA",
    "pricePerNight": "100",
    "images": ["https://example.com/image.jpg"]
  }'
```

#### Update Property

```bash
curl -X PUT http://localhost:3000/api/v1/properties/<property_id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"pricePerNight": "120"}'
```

#### Delete Property

```bash
curl -X DELETE http://localhost:3000/api/v1/properties/<property_id> \
  -H "Authorization: Bearer <token>"
```

### Bookings

#### List Bookings

```bash
curl -X GET http://localhost:3000/api/v1/bookings \
  -H "Authorization: Bearer <token>"
```

#### Get Booking

```bash
curl -X GET http://localhost:3000/api/v1/bookings/<booking_id> \
  -H "Authorization: Bearer <token>"
```

#### Create Booking

```bash
curl -X POST http://localhost:3000/api/v1/bookings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "propertyId": "<property_id>",
    "startDate": "2024-06-01",
    "endDate": "2024-06-05"
  }'
```

#### Confirm Booking

```bash
curl -X POST http://localhost:3000/api/v1/bookings/<booking_id>/confirm \
  -H "Authorization: Bearer <token>"
```

#### Cancel Booking

```bash
curl -X POST http://localhost:3000/api/v1/bookings/<booking_id>/cancel \
  -H "Authorization: Bearer <token>"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Layer                             │
│  (Express Routes → Controllers → Services → Validators)     │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────────┐
        │ Supabase │   │  Redis   │   │  Blockchain  │
        │   (DB)   │   │ (Cache)  │   │  (Soroban)   │
        └──────────┘   └──────────┘   └──────────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  TrustlessWork   │
                                    │    (Escrow)      │
                                    └──────────────────┘
```

### Service Layer

- **AuthService**: User authentication and JWT management
- **PropertyService**: Property CRUD operations and blockchain sync
- **BookingService**: Booking lifecycle management
- **WalletService**: Stellar wallet integration
- **SyncService**: Blockchain-to-database synchronization
- **ProfileService**: User profile management
- **LocationService**: Geocoding and location services

## Blockchain Integration

### Smart Contracts

The backend integrates with two Soroban smart contracts:

1. **PropertyListingContract**: Manages property listings on-chain
2. **BookingContract**: Manages booking state and payments

### Flow

1. Property created in database → synced to PropertyListingContract
2. Tenant creates booking → creates BookingContract entry
3. Host confirms booking → initializes TrustlessWork escrow
4. Tenant deposits funds → escrow holds funds
5. Check-in confirmed → escrow releases funds to host

## TrustlessWork Escrow Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────┐     ┌────────────┐
│  Tenant │────▶│   Backend   │────▶│Escrow   │────▶│   Host     │
│         │     │             │     │Contract │     │            │
└─────────┘     └─────────────┘     └─────────┘     └────────────┘
     │               │                   │               │
     │ 1. Book      │                   │               │
     │─────────────▶│                   │               │
     │               │ 2. Init Escrow   │               │
     │               │─────────────────▶│               │
     │               │                   │               │
     │ 3. Deposit   │                   │               │
     │─────────────▶│                   │──────────────▶│
     │               │                   │ 4. Release   │
     │               │                   │◀─────────────│
```

## Database migrations

`database/setup.sql` is the authoritative migration runner. Apply it against the target
database after starting the local Supabase stack:

```bash
# Start the local Supabase stack first
supabase start
# or, from the repository root
docker-compose up -d

# Apply the schema/migrations
psql "$DATABASE_URL" -f database/setup.sql
```

Migration files must have unique, monotonically increasing numeric prefixes; see
`database/MIGRATIONS_NAMING.md` for the naming convention.

## Local development seed data

A seed script populates the local database with a realistic dataset (users, properties,
availability, bookings, reviews, wishlists, notifications). It is **idempotent** — safe
to re-run at any time without creating duplicates.

```bash
# Start the local Supabase stack and apply database/setup.sql first (see above)

# Then seed the database
npm run db:seed
```
=======

Seeded credentials:

| Role     | Email                            | Password            |
|----------|----------------------------------|---------------------|
| Host     | seed-host@rentars-dev.local      | SeedHost@Dev2024!   |
| Tenant A | seed-tenant-a@rentars-dev.local  | SeedTenantA@Dev2024!|
| Tenant B | seed-tenant-b@rentars-dev.local  | SeedTenantB@Dev2024!|

## Testing

### Unit Tests

```bash
npm run test:unit
```

### RLS (Row Level Security) Tests

These tests connect to a running local Supabase stack as different users and verify
that cross-user data access is blocked by RLS policies.

```bash
# Start local Supabase first
supabase start

# Run RLS tests
npm run test:rls
```

### Migration filename validation

Validates that all migration files have unique, monotonically increasing numeric prefixes.
Run this before committing a new migration:

```bash
npm run validate:migrations
```

See `database/MIGRATIONS_NAMING.md` for the naming convention and documentation of
existing duplicate prefixes.

### Integration Tests

```bash
# Start test environment (from the repository root)
docker-compose up -d

# Run integration tests
npm run test:integration
```
=======

### Docker Tests

```bash
# Validate Docker setup
./tests/docker/validate.test.sh

# Run integration tests in Docker
./tests/docker/integration.test.sh
```

## Deployment

### Docker Production Build

```bash
# From apps/backend/
docker build -t rentars-backend .
docker run -d -p 3000:3000 --env-file .env.production rentars-backend
```

### Environment-Specific Configs

- `.env.example` - Template for all environments (authoritative key list)
- `.env.test` - Test environment configuration
- `.env.production.example` - Production environment template

Never commit real secrets; `.env.production` must be supplied at deploy time.

See [SECRETS.md](../../SECRETS.md) for detailed secrets management and
[DEPLOYMENT.md](../../DEPLOYMENT.md) for the staging/testnet deployment guide.

### Production limitations

The backend is code-complete for the documented API surface, but production
deployment is **not yet verified**. Mainnet Stellar/Soroban steps and real-network
escrow flows are gated and must be validated on testnet first. Treat any production
claims as unverified until the staging/testnet guide has been executed end to end.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Run linting: `npm run format-and-lint`
4. Write tests for new functionality
5. Submit a pull request

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full workflow.
=======

## License

MIT