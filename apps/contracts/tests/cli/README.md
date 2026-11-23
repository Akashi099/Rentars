# Rentars Contract CLI Test Suite

Shell-based integration tests that deploy the three Rentars Soroban contracts to the Stellar testnet and exercise every public function via `stellar contract invoke`.

---

## Directory Structure

```
tests/cli/
├── README.md                   ← You are here
├── setup.sh                    ← Fund accounts, deploy contracts, persist state
├── run-all-tests.sh            ← Execute all suites sequentially
├── test-property-listing.sh    ← PropertyListing contract tests
├── test-booking.sh             ← Booking contract tests
├── test-review.sh              ← Review contract tests
├── test-booking-lifecycle.sh   ← End-to-end full booking lifecycle test
└── utils/
    ├── network-config.sh       ← Network URLs, identity names, WASM paths
    └── test-helpers.sh         ← assert_success / assert_failure / print_summary
```

A hidden `.test-state.env` file is written by `setup.sh` and read by every test script. It stores the deployed contract IDs and account addresses so you don't have to pass them manually.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) | ≥ 21 | `cargo install --locked stellar-cli --features opt` |
| [Rust](https://rustup.rs) | stable (≥ 1.81) | `rustup update stable` |
| `wasm32-unknown-unknown` target | — | `rustup target add wasm32-unknown-unknown` |
| `curl` | any | pre-installed on most systems |
| `bash` | ≥ 4 | pre-installed on Linux/macOS |

> **Windows users:** run these scripts inside WSL2 or Git Bash.

### Funded testnet accounts

`setup.sh` creates and funds four identities via Friendbot:

| Identity | Role |
|---|---|
| `rentars-admin` | Contract admin, confirms/completes bookings |
| `rentars-owner` | Property listing owner |
| `rentars-tenant` | Booking tenant |
| `rentars-reviewer` | Review submitter |

The lifecycle test (`test-booking-lifecycle.sh`) uses all four identities.
If any account runs out of XLM after repeated test runs, re-fund with
`./setup.sh --skip-build` (skips the slow cargo build but re-funds accounts).

> **Secrets:** identities are generated locally by `setup.sh` and stored by the
> Stellar CLI in its own keystore (default `~/.config/stellar`). Never commit
> `.test-state.env`, keystore files, or secret keys. The scripts only persist
> public contract IDs and account addresses in `.test-state.env`.

---

## Quick Start

```bash
# 1. Navigate to the CLI test directory
cd apps/contracts/tests/cli

# 2. Make scripts executable
chmod +x setup.sh run-all-tests.sh test-*.sh

# 3. Run everything (setup + all suites, including the lifecycle test)
./run-all-tests.sh
```

That's it. `run-all-tests.sh` calls `setup.sh` automatically on the first run.

---

## Running Individual Suites

```bash
# Setup only (deploy contracts, fund accounts)
./setup.sh

# Individual test suites
./test-property-listing.sh
./test-booking.sh
./test-review.sh
./test-booking-lifecycle.sh
```

### Skipping Steps

```bash
# Skip cargo build (use existing WASM artefacts)
./run-all-tests.sh --skip-build

# Skip Friendbot funding (accounts already funded)
./run-all-tests.sh --skip-fund

# Skip setup entirely (contracts already deployed)
./run-all-tests.sh --skip-setup
```

---

## Configuration

All network settings live in `utils/network-config.sh`. Override any value by exporting the variable before running:

```bash
# Use a custom RPC endpoint
export STELLAR_RPC_URL="https://my-custom-rpc.example.com"

# Use a different network name
export STELLAR_NETWORK="futurenet"

./run-all-tests.sh
```

| Variable | Default | Description |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | Network name registered with the CLI |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network passphrase |
| `STELLAR_CLI` | `stellar` | Path to the stellar CLI binary |

These are the defaults defined in `utils/network-config.sh`; confirm them there
if the file has changed. All tests target the Stellar **testnet** only — there is
no mainnet path in this suite.

---

## Test Coverage

### `test-property-listing.sh`

| # | Test | Function |
|---|---|---|
| 1 | listing_count starts at 0 | `listing_count` |
| 2 | Create listing — happy path | `create_listing` |
| 3 | Get listing — fields, status | `get_listing` |
| 4 | Get listing — not found | `get_listing` |
| 5 | Update listing — owner | `update_listing` |
| 6 | Update listing — unauthorized | `update_listing` |
| 7 | Update listing — zero price | `update_listing` |
| 8 | Update listing — empty title | `update_listing` |
| 9 | Create listing — zero price | `create_listing` |
| 10 | Create listing — negative price | `create_listing` |
| 11 | Create listing — empty title | `create_listing` |
| 12 | Status: Active → Inactive → Rented → Active | `update_status` |
| 13 | Status update — unauthorized | `update_status` |
| 14 | Minimum price (1 stroop) | `create_listing` |
| 15 | Single-char title | `create_listing` |

### `test-booking.sh`

| # | Test | Function |
|---|---|---|
| 1 | booking_count starts at 0 | `booking_count` |
| 2 | Double-initialize rejection | `initialize` |
| 3 | Create booking — happy path | `create_booking` |
| 4 | Create booking — invalid dates (equal, reversed) | `create_booking` |
| 5 | Create booking — zero / negative price | `create_booking` |
| 6 | Overlap prevention (exact, partial) | `create_booking` |
| 7 | Adjacent booking allowed | `create_booking` |
| 8 | Same dates, different property | `create_booking` |
| 9 | check_availability — empty property | `check_availability` |
| 10 | check_availability — blocked | `check_availability` |
| 11 | get_property_bookings — populated / empty | `get_property_bookings` |
| 12 | Cancel booking — tenant | `cancel_booking` |
| 13 | Cancel booking — unauthorized | `cancel_booking` |
| 14 | Cancel booking — already cancelled | `cancel_booking` |
| 15 | check_availability after cancel | `check_availability` |
| 16 | Cancelled slot can be rebooked | `create_booking` |
| 17 | Status: Pending → Confirmed → Completed | `update_status` |
| 18 | Invalid transition: Pending → Completed | `update_status` |
| 19 | Invalid transition: Cancelled → Confirmed | `update_status` |
| 20 | update_status — unauthorized | `update_status` |
| 21 | set_escrow_id — admin | `set_escrow_id` |
| 22 | set_escrow_id — unauthorized | `set_escrow_id` |
| 23 | get_booking — not found | `get_booking` |

### `test-review.sh`

| # | Test | Function |
|---|---|---|
| 1 | review_count starts at 0 | `review_count` |
| 2 | get_reputation — no reviews returns 0 | `get_reputation` |
| 3 | get_reviews_for_user — empty | `get_reviews_for_user` |
| 4 | Submit review — happy path | `submit_review` |
| 5 | get_reviews_for_user — populated | `get_reviews_for_user` |
| 6 | get_reputation — single 5-star = 500 | `get_reputation` |
| 7 | All valid ratings (1–4) accepted | `submit_review` |
| 8 | get_reputation — average of 1+2+3 = 200 | `get_reputation` |
| 9 | Rating 0 rejected | `submit_review` |
| 10 | Rating 6 rejected | `submit_review` |
| 11 | Duplicate review prevention | `submit_review` |
| 12 | get_review — not found | `get_review` |
| 13 | review_count consistency | `review_count` |
| 14 | Empty comment accepted | `submit_review` |

### `test-booking-lifecycle.sh` — Full end-to-end lifecycle

Exercises the complete happy-path booking flow across all three contracts in a
single script, asserting contract state at every step.

| Step | Description | Contracts exercised |
|------|-------------|---------------------|
| 1 | Create property listing | `PropertyListing` |
| 1a–c | Assert listing Active, title, and price | `PropertyListing` |
| 2 | Create booking for that listing | `Booking` |
| 2a–e | Assert Pending status, property ref, price, index, and blocked dates | `Booking` |
| 3 | Admin confirms booking (Pending → Confirmed) | `Booking` |
| 3a–b | Assert Confirmed status | `Booking` |
| 4 | Admin completes / releases escrow (Confirmed → Completed) | `Booking` |
| 4a–b | Assert Completed status | `Booking` |
| 5 | Reviewer submits 5-star review for owner | `Review` |
| 5a–c | Assert review stored, indexed, and reputation = 500 | `Review` |
| Final | Assert listing still Active; booking still Completed | All |

---

## How It Works

### `setup.sh`

1. Verifies the `stellar` CLI is installed.
2. Registers the `testnet` network with the CLI (idempotent).
3. Generates four key pairs: `rentars-admin`, `rentars-owner`, `rentars-tenant`, `rentars-reviewer`.
4. Funds each account via [Friendbot](https://friendbot.stellar.org).
5. Runs `cargo build --target wasm32-unknown-unknown --release` from `apps/contracts/`.
6. Deploys all three contracts and captures their IDs.
7. Calls `initialize` on the Booking contract with the admin address.
8. Writes all IDs and addresses to `.test-state.env`.

### Test scripts

Each test script:
- Sources `utils/network-config.sh` and `utils/test-helpers.sh`.
- Calls `load_state` to read `.test-state.env`.
- Uses `assert_success`, `assert_failure`, and `assert_output_contains` to wrap `stellar contract invoke` calls.
- Calls `print_summary` at the end, which exits with code `1` if any assertion failed.

### `run-all-tests.sh`

Runs `setup.sh` then each test script in order. Collects per-suite pass/fail and prints a final summary. Exits with code `1` if any suite failed.

---

## Troubleshooting

**`stellar: command not found`**
Install the Stellar CLI: `cargo install --locked stellar-cli --features opt`

**`Friendbot rate limit`**
Wait a few minutes and re-run with `--skip-fund` if accounts are already funded.

**`WASM not found`**
Run without `--skip-build`, or manually: `cd apps/contracts && cargo build --target wasm32-unknown-unknown --release`

**`Contract not initialized`**
Delete `.test-state.env` and re-run `setup.sh` to redeploy and reinitialize.

**Tests fail with `HostError`**
The testnet may be congested. Wait a few seconds between retries, or increase the `wait_for_ledger` calls in the test scripts.

---

## CI Integration

The GitHub Actions workflow at `.github/workflows/contract-tests.yml` runs `cargo test` and `cargo build --target wasm32-unknown-unknown --release` for all three contracts on every push to `main` and on pull requests targeting `main`. See the [CI workflow documentation](../../../../.github/workflows/contract-tests.yml) for details.

> **Note:** CI runs the Rust unit tests and WASM build only. The shell-based
> testnet integration suites in this directory are run manually and are not
> executed by CI, since they require funded testnet accounts.
