# Rentars Database Schema

## Overview

Rentars uses PostgreSQL for identity, listings, bookings, availability, wallet authentication, blockchain audit logs, and sync tracking.

## Entity relationship diagram

```mermaid
erDiagram
  users ||--o{ properties : owns
  users ||--o{ bookings : books
  properties ||--o{ bookings : receives
  properties ||--o{ availability_ranges : has
  users ||--o| profiles : has

  users {
    uuid id PK
    varchar email UNIQUE NOT NULL
    varchar password_hash
    varchar stellar_address
    timestamp created_at
    timestamp updated_at
  }

  profiles {
    uuid id PK
    uuid user_id UNIQUE FK
    varchar stellar_address
    varchar display_name
    varchar avatar_url
    text bio
    varchar phone
    boolean verified
    timestamp created_at
    timestamp updated_at
  }

  properties {
    uuid id PK
    uuid owner_id FK
    varchar title NOT NULL
    text description
    varchar location
    decimal price_per_night NOT NULL
    int max_guests
    timestamp created_at
    timestamp updated_at
  }

  bookings {
    uuid id PK
    uuid property_id FK
    uuid tenant_id FK
    date check_in NOT NULL
    date check_out NOT NULL
    decimal total_price NOT NULL
    varchar status
    varchar escrow_id
    varchar blockchain_booking_id
    varchar blockchain_status
    timestamp created_at
    timestamp updated_at
  }
```

## Tables

### users

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | User identifier |
| email | VARCHAR(255) | UNIQUE, NOT NULL | Login email |
| password_hash | VARCHAR(255) | Nullable | Password hash |
| stellar_address | VARCHAR(56) | Nullable | Linked Stellar wallet address |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

Indexes:
- `idx_users_stellar_address (stellar_address)`

### properties

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Property identifier |
| owner_id | UUID | NOT NULL, FK users(id), ON DELETE CASCADE | Property owner |
| title | VARCHAR(255) | NOT NULL | Property title |
| description | TEXT | Nullable | Property description |
| location | VARCHAR(255) | Nullable | Property location |
| price_per_night | DECIMAL(10,2) | NOT NULL, CHECK > 0 | Nightly price |
| max_guests | INT | DEFAULT 1 | Maximum guests |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

Indexes:
- `idx_properties_owner_id (owner_id)`

### bookings

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Booking identifier |
| property_id | UUID | NOT NULL, FK properties(id), ON DELETE CASCADE | Referenced property |
| tenant_id | UUID | NOT NULL, FK users(id), ON DELETE CASCADE | Tenant user |
| check_in | DATE | NOT NULL | Check-in date |
| check_out | DATE | NOT NULL, CHECK > check_in | Check-out date |
| total_price | DECIMAL(10,2) | NOT NULL, CHECK > 0 | Total booking price |
| status | VARCHAR(50) | DEFAULT 'pending' | Booking status |
| escrow_id | VARCHAR(255) | Nullable | Escrow contract identifier |
| blockchain_booking_id | VARCHAR(255) | Nullable | On-chain booking identifier |
| blockchain_status | VARCHAR(50) | Nullable | On-chain status |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

Indexes:
- `idx_bookings_property_id (property_id)`
- `idx_bookings_tenant_id (tenant_id)`
- `idx_bookings_escrow_id (escrow_id)`
- `idx_bookings_blockchain_booking_id (blockchain_booking_id)`

### availability_ranges

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Availability identifier |
| property_id | UUID | NOT NULL, FK properties(id), ON DELETE CASCADE | Referenced property |
| start_date | DATE | NOT NULL | Availability start date |
| end_date | DATE | NOT NULL | Availability end date |
| is_available | BOOLEAN | DEFAULT TRUE | Availability state |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

Indexes:
- `idx_availability_ranges_property_id (property_id)`

### profiles

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Profile identifier |
| user_id | UUID | NOT NULL, UNIQUE, FK users(id), ON DELETE CASCADE | Referenced user |
| stellar_address | VARCHAR(56) | Nullable | Linked Stellar wallet address |
| display_name | VARCHAR(255) | Nullable | Display name |
| avatar_url | VARCHAR(255) | Nullable | Avatar URL |
| bio | TEXT | Nullable | Bio |
| phone | VARCHAR(20) | Nullable | Phone number |
| verified | BOOLEAN | DEFAULT FALSE | Verification flag |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update timestamp |

Indexes:
- `idx_profiles_user_id (user_id)`
- `idx_profiles_stellar_address (stellar_address)`

### blockchain_logs

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Log identifier |
| operation | VARCHAR(100) | NOT NULL | Blockchain operation name |
| input_json | JSONB | Nullable | Operation input payload |
| result_json | JSONB | Nullable | Operation output payload |
| error_message | TEXT | Nullable | Error details |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Log timestamp |

Indexes:
- `idx_blockchain_logs_operation (operation)`
- `idx_blockchain_logs_created_at (created_at)`

### wallet_challenges

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Challenge identifier |
| stellar_address | VARCHAR(56) | NOT NULL | Wallet address being verified |
| challenge | VARCHAR(255) | NOT NULL, UNIQUE | Challenge text |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| expires_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes' | Expiration timestamp |
| used | BOOLEAN | DEFAULT FALSE | Usage flag |

Indexes:
- `idx_wallet_challenges_stellar_address (stellar_address)`
- `idx_wallet_challenges_challenge (challenge)`

### sync_log

| Column | Type | Constraints | Description |
|---|---|---|---|
| id | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Sync entry identifier |
| entity_type | TEXT | NOT NULL, CHECK IN ('property','booking') | Synced entity kind |
| entity_id | TEXT | NOT NULL | Synced entity identifier |
| status | TEXT | NOT NULL, CHECK IN ('success','failed','skipped') | Sync result |
| error_message | TEXT | Nullable | Failure details |
| synced_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Sync execution timestamp |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Entry creation timestamp |

Indexes:
- `idx_sync_log_entity (entity_type, entity_id, synced_at DESC)`
- `idx_sync_log_status (status, synced_at DESC)`

## Row level security policies

RLS is enabled on:
- `profiles`
- `properties`
- `bookings`

### profiles
- `Users can read their own profile` (SELECT): `auth.uid() = id`
- `Users can update their own profile` (UPDATE): `auth.uid() = id`
- `Users can insert their own profile` (INSERT): `auth.uid() = id`

### properties
- `Owners can insert properties` (INSERT): `auth.uid() = owner_id`
- `Owners can update their own properties` (UPDATE): `auth.uid() = owner_id`
- `Owners can delete their own properties` (DELETE): `auth.uid() = owner_id`
- `All authenticated users can read properties` (SELECT): `auth.role() = 'authenticated'`

### bookings
- `Tenants can read their own bookings` (SELECT): `auth.uid() = tenant_id`
- `Owners can read bookings for their properties` (SELECT): property owner lookup through `properties`
- `System can insert bookings` (INSERT): `WITH CHECK (true)`
- `Tenants can update their own bookings` (UPDATE): `auth.uid() = tenant_id`
- `Tenants can delete their own bookings` (DELETE): `auth.uid() = tenant_id`

## Triggers and PostgreSQL functions

### Functions
- `update_updated_at_column()`: sets `NEW.updated_at = CURRENT_TIMESTAMP` before row updates
- `create_booking_atomic(p_property_id, p_tenant_id, p_check_in, p_check_out, p_total_price)`: inserts booking after overlap validation
- `confirm_booking_atomic(p_booking_id, p_escrow_id, p_blockchain_booking_id)`: confirms booking and stores blockchain references

### Triggers
- `update_users_updated_at` on `users`
- `update_properties_updated_at` on `properties`
- `update_bookings_updated_at` on `bookings`
- `update_availability_ranges_updated_at` on `availability_ranges`

All triggers execute `update_updated_at_column()` `BEFORE UPDATE` for each row.

## Migrations

### Authoritative migration command

`setup.sql` is the single authoritative source of truth for the database schema.
It applies all migrations in the correct order (see `MIGRATIONS_NAMING.md` for the
canonical ordering of files with shared prefixes).

```bash
# Apply the full schema from scratch — aborts immediately on any SQL error
cd apps/backend/database
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -f setup.sql
```

This is the **same command CI uses**. Running it locally reproduces the exact CI schema.

> **Do not** apply migrations piecemeal by hand unless you are adding a single new
> file. Always use `setup.sql` for a fresh database. See `MIGRATIONS_NAMING.md` for
> the naming convention and how to add new migrations.

### Validate migration filenames

```bash
# Detects duplicate prefixes and out-of-order files
cd apps/backend
bun run validate:migrations

# Report only (no failing exit code)
bun run validate:migrations --dry-run
```

### Seed local data

```bash
cd apps/backend && bun run db:seed
```

Populates a realistic local dataset (users, properties, availability, bookings, reviews, wishlists,
notifications) using stable UUIDs — idempotent and safe to re-run.

### Rollback strategy

No down-migration files are currently committed. Rollback can be handled by restoring from backup or running manual `DROP` statements in reverse dependency order.

Manual rollback example:

```bash
psql -U postgres -d rentars <<'SQL'
BEGIN;
DROP TABLE IF EXISTS sync_log;
DROP TABLE IF EXISTS wallet_challenges;
DROP TABLE IF EXISTS blockchain_logs;
DROP TABLE IF EXISTS availability_ranges;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;
COMMIT;
SQL
```
