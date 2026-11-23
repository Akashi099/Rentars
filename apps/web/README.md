# Rentars Web Frontend

A Next.js 15 decentralized rental platform frontend built on the Stellar blockchain.

> **Source of truth:** This file documents the frontend workspace only. For repository-wide setup, environment templates, ports, migrations, and deployment, follow the [root README](../../README.md) and [DEPLOYMENT.md](../../DEPLOYMENT.md). Do not duplicate those instructions here.

## Overview

The Rentars frontend is a modern React application that enables property owners to list rentals and tenants to book properties using USDC via the Stellar blockchain. It integrates with the Freighter wallet for secure blockchain interactions and connects to the Express backend for data persistence.

### Key Features

- Property browsing with grid/list views
- Freighter wallet integration for Stellar payments
- Role-based access control (owner/tenant)
- Real-time booking status updates
- Property listing creation and management
- Escrow status monitoring
- Dashboard for owners and tenants

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 20 | Runtime |
| Yarn | >= 1.22 | Package manager |
| Freighter Wallet | Latest | Browser crypto wallet |

### Required Accounts

1. **Freighter Wallet** - Install the [Freighter browser extension](https://www.freighter.app/)
2. **Stellar Testnet Account** - Fund via [Stellar Lab](https://laboratory.stellar.org/)
3. **Supabase Project** - For backend data storage

---

## Installation

Repository-wide installation (workspace bootstrap, backend, contracts) is documented in the [root README](../../README.md). To work on the frontend only:

```bash
# From the repository root
yarn install

# Or install just the web workspace
cd apps/web && yarn install
```

---

## Environment Variables

Copy the template and fill in values — never commit real secrets:

```bash
cd apps/web
cp .env.example .env.local
```

The template lives at `apps/web/.env.example`. Required keys (names only; see the template for placeholders):

- `NEXT_PUBLIC_API_URL` — backend base URL (local backend runs on port 3000)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase project credentials
- `NEXT_PUBLIC_STELLAR_NETWORK` — `testnet` for local development
- `NEXT_PUBLIC_STELLAR_HORIZON_URL`, `NEXT_PUBLIC_STELLAR_RPC_URL` — Stellar endpoints
- `NEXT_PUBLIC_RENTARS_CONTRACT_ADDRESS`, `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` — deployed contract IDs

Mainnet values are gated: only set them for a reviewed production deployment (see [DEPLOYMENT.md](../../DEPLOYMENT.md)).

---

## Running Locally

### Development Server

```bash
cd apps/web
yarn dev
```

The frontend runs on **http://localhost:3001** (the backend runs on port 3000). Start the backend first — see the [root README](../../README.md) for the backend dev command.

### Production Build

```bash
cd apps/web
yarn build
yarn start
```

---

## Project Structure

```
apps/web/
├── public/                     # Static assets
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/            # Auth pages (login, register)
│   │   │   ├── login/
│   │   │   └── register/
│   │   ├── (dashboard)/       # Protected dashboard routes
│   │   │   ├── dashboard/     # Owner dashboard
│   │   │   └── my-bookings/   # Tenant bookings
│   │   ├── properties/        # Property browsing
│   │   │   ├── [id]/          # Property detail page
│   │   │   └── create/        # List new property
│   │   ├── layout.tsx         # Root layout
│   │   ├── page.tsx           # Home page
│   │   └── error.tsx          # Error boundary
│   │
│   ├── components/            # React components
│   │   ├── ui/                # Base UI components (Button, Input, Card)
│   │   ├── property/          # Property-related components
│   │   │   ├── PropertyCard.tsx
│   │   │   ├── PropertyGrid.tsx
│   │   │   ├── PropertyList.tsx
│   │   │   ├── PropertyDetail.tsx
│   │   │   └── PriceDisplay.tsx
│   │   ├── booking/           # Booking components
│   │   │   ├── BookingCard.tsx
│   │   │   ├── BookingForm.tsx
│   │   │   ├── EscrowStatus.tsx
│   │   │   └── PaymentStatus.tsx
│   │   ├── wallet/            # Wallet integration
│   │   │   ├── WalletConnect.tsx
│   │   │   ├── WalletButton.tsx
│   │   │   └── WalletModal.tsx
│   │   └── layout/            # Layout components
│   │       ├── Header.tsx
│   │       ├── Footer.tsx
│   │       ├── Sidebar.tsx
│   │       └── Navbar.tsx
│   │
│   ├── hooks/                 # React hooks
│   │   ├── stellar/           # Stellar-specific hooks
│   │   │   ├── useFreighter.ts
│   │   │   ├── useSoroban.ts
│   │   │   └── useAccount.ts
│   │   ├── auth/              # Auth hooks
│   │   │   ├── useAuth.ts
│   │   │   └── useSession.ts
│   │   ├── useWallet.ts       # Main wallet hook
│   │   ├── useProperties.ts   # Property data fetching
│   │   ├── useBookingDetails.ts
│   │   ├── useEscrowStatus.ts
│   │   ├── usePaymentStatus.ts
│   │   ├── useUserRole.tsx
│   │   ├── useDashboard.ts
│   │   └── useRealTimeUpdates.ts
│   │
│   ├── lib/                   # Utilities and configs
│   │   ├── supabase.ts        # Supabase client
│   │   ├── stellar.ts         # Stellar SDK setup
│   │   ├── contracts.ts       # Contract ABIs
│   │   └── utils.ts           # Helper functions
│   │
│   ├── services/              # API services
│   │   ├── api.ts             # Base API client
│   │   ├── property.service.ts
│   │   ├── booking.service.ts
│   │   └── auth.service.ts
│   │
│   ├── types/                 # TypeScript definitions
│   │   ├── property.ts
│   │   ├── booking.ts
│   │   ├── user.ts
│   │   └── stellar.ts
│   │
│   ├── constants/             # App constants
│   │   ├── config.ts
│   │   └── chains.ts
│   │
│   ├── validations/           # Form validation schemas
│   │   ├── property.validation.ts
│   │   └── booking.validation.ts
│   │
│   └── tests/                 # Test utilities
│
├── package.json
├── next.config.ts
├── tailwind.config.js
├── tsconfig.json
└── vitest.config.ts
```

---

## Key Components

### PropertyCard

Displays property preview with image, title, price, and location.

```tsx
import { PropertyCard } from '@/components/property/PropertyCard';

<PropertyCard 
  property={property} 
  onBook={() => handleBook(property.id)}
  onViewDetails={() => router.push(`/properties/${property.id}`)}
/>
```

### BookingForm

Form for creating bookings with date selection and price calculation.

```tsx
import { BookingForm } from '@/components/booking/BookingForm';

<BookingForm 
  propertyId={propertyId}
  pricePerNight={price}
  onSubmit={handleBookingSubmit}
/>
```

### WalletButton

Connect/disconnect Freighter wallet with balance display.

```tsx
import { WalletButton } from '@/components/wallet/WalletButton';

<WalletButton 
  onConnect={handleWalletConnect}
  onDisconnect={handleWalletDisconnect}
/>
```

### EscrowStatus

Monitors on-chain escrow status for bookings.

```tsx
import { EscrowStatus } from '@/components/booking/EscrowStatus';

<EscrowStatus 
  bookingId={bookingId}
  onStatusChange={handleStatusUpdate}
/>
```

### PaymentStatus

Displays the current payment lifecycle state for a booking.

```tsx
import { PaymentStatus } from '@/components/booking/PaymentStatus';

<PaymentStatus bookingId={bookingId} />
```

### PriceDisplay

Formats and renders USDC prices consistently.

```tsx
import { PriceDisplay } from '@/components/property/PriceDisplay';

<PriceDisplay amount={property.pricePerNight} currency="USDC" />
```

---

## Hooks Reference

### useWallet

Main hook for Freighter wallet integration.

```typescript
const { 
  address,           // Connected wallet address
  connected,        // Connection status
  connect,          // Connect wallet
  disconnect,       // Disconnect wallet
  balance,          // USDC balance
  network,          // Current network (testnet/mainnet)
  isLoading         // Loading state
} = useWallet();
```

### useProperties

Fetches and filters properties.

```typescript
const { 
  properties,       // Property array
  loading,          // Loading state
  error,            // Error message
  refetch           // Refresh properties
} = useProperties(filters);
```

### useBookingDetails

Fetches booking details with escrow status.

```typescript
const { 
  booking, 
  escrowStatus,     // 'pending' | 'locked' | 'released' | 'refunded'
  confirmRental,    // Confirm and release escrow
  cancelBooking     // Cancel and refund
} = useBookingDetails(bookingId);
```

### useEscrowStatus

Watches on-chain escrow contract status.

```typescript
const {
  status,
  amount,
  lastUpdated,
  refresh
} = useEscrowStatus(bookingId);
```

### usePaymentStatus

Tracks payment lifecycle state for a booking.

```typescript
const {
  paymentStatus,    // 'pending' | 'submitted' | 'confirmed' | 'failed'
  isLoading,
  refresh
} = usePaymentStatus(bookingId);
```

### useUserRole

Determines current user role (owner/tenant/guest).

```typescript
const { 
  role,             // 'owner' | 'tenant' | 'guest'
  isOwner,
  isTenant,
  isLoading 
} = useUserRole();
```

---

## Freighter Wallet Integration

### Overview

Rentars uses Freighter for Stellar wallet integration. Users connect their wallet to:
- Sign booking transactions
- Authorize USDC escrow payments
- Confirm rental completion

### Connection Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │  Frontend   │     │  Freighter  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  1. Click Connect │                   │
       │──────────────────>│                   │
       │                   │  2. Request Access│
       │                   │──────────────────>│
       │                   │<─────────────────│
       │                   │  3. User Approves│
       │<──────────────────│                   │
       │  4. Show Address  │                   │
```

### Implementation

```typescript
import { useFreighter } from '@/hooks/stellar/useFreighter';

// Connect wallet
const { connect, address, isConnected } = useFreighter();

const handleConnect = async () => {
  await connect();
};

// Sign transaction
const handleSign = async (transaction: Transaction) => {
  const { signedTx } = await freighterApi.signTransaction(
    transaction.toXDR(),
    { network: 'testnet' }
  );
  return Transaction.fromXDR(signedTx, 'testnet');
};
```

### Sign Transaction

When creating bookings or confirming rentals:

```typescript
const signAndSubmit = async (transaction: Transaction) => {
  try {
    // Get signature from Freighter
    const { signedTxXdr } = await window.freighterApi.signTransaction(
      transaction.toXDR(),
      { network: networkPassphrase }
    );
    
    // Submit to network
    const result = await server.submitTransaction(
      Transaction.fromXDR(signedTxXdr, networkPassphrase)
    );
    
    return result;
  } catch (error) {
    console.error('Transaction failed:', error);
    throw error;
  }
};
```

### Network Configuration

```typescript
// stellar.ts
export const stellarConfig = {
  testnet: {
    networkPassphrase: Network.TESTNET_NETWORK_PASSPHRASE,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    networkPassphrase: Network.PUBLIC_NETWORK_PASSPHRASE,
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://soroban-rpc.stellar.org',
  }
};
```

> Mainnet configuration is gated. Do not enable it without a reviewed deployment plan — see [DEPLOYMENT.md](../../DEPLOYMENT.md).

---

## Stellar Context

### Testnet vs Mainnet

| Environment | Network | RPC URL | Use Case |
|-------------|---------|---------|----------|
| Testnet | Testnet | soroban-testnet.stellar.org | Development |
| Mainnet | Public | soroban-rpc.stellar.org | Production |

### Transaction Flow

1. **List Property**: Owner calls `list_property` contract fn
2. **Book Property**: Tenant calls `book_property`, USDC locked in escrow
3. **Confirm Rental**: Owner calls `confirm_rental`, escrow released
4. **Cancel Booking**: Either party can cancel, escrow refunded

### Contract Addresses

```
Rentars Contract: CA7X2... (testnet)
USDC Token:       CBGDS... (testnet)
```

---

## Passkey Integration

> **Note**: Passkey integration is planned for future release. Currently uses Freighter wallet only.

The frontend will support passkey-based authentication for a passwordless experience:

```typescript
// Planned passkey implementation
import { createPasskeyCredential } from '@/lib/passkey';

const registerWithPasskey = async (email: string) => {
  const credential = await createPasskeyCredential(email);
  // Store credential on backend
  await api.registerPasskey({ email, credential });
};
```

---

## Role-Based Access Control

### Roles

| Role | Capabilities |
|------|-------------|
| `guest` | Browse properties, view details |
| `tenant` | Book properties, view own bookings |
| `owner` | List properties, manage listings, view bookings |
| `admin` | All capabilities + system management |

### Access Checks

```typescript
// Route protection
const ProtectedRoute = ({ children, requiredRole }) => {
  const { user, role } = useAuth();
  
  if (!user || (requiredRole && role !== requiredRole)) {
    return <Navigate to="/login" />;
  }
  
  return children;
};

// Usage
<ProtectedRoute requiredRole="owner">
  <CreatePropertyForm />
</ProtectedRoute>
```

### Owner Dashboard

```
┌─────────────────────────────────────────────────┐
│  Owner Dashboard                                 │
├─────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ Listed  │ │ Pending │ │ Earnings │           │
│  │  12     │ │  3      │ │ 2,450 USDC│          │
│  └─────────┘ └─────────┘ └─────────┘           │
│                                                 │
│  My Properties                                  │
│  ┌─────────────────────────────────────────┐   │
│  │ 🌟 Modern Downtown Apt    $150/night   │   │
│  │    Pending: 2  |  Active               │   │
│  └─────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────┐   │
│  │ 🌟 Cozy Studio          $80/night      │   │
│  │    Pending: 0  |  Active               │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Testing

### Unit Tests

```bash
cd apps/web
yarn test --run
```

### End-to-End Tests

```bash
cd apps/web
yarn e2e
```

E2E tests require the backend and frontend to be running (see [root README](../../README.md) for the local stack).

### Test Coverage

Minimum coverage thresholds:
- Statements: 70%
- Branches: 65%
- Functions: 70%
- Lines: 70%

---

## Building for Production

### Build

```bash
cd apps/web
yarn build
```

### Deployment

Deployment prerequisites, environment configuration, Docker setup, and staging/testnet verification steps are documented in [DEPLOYMENT.md](../../DEPLOYMENT.md). Mainnet deployment is gated and requires a reviewed plan; this README does not provide mainnet instructions.

---

## Screenshots

### Home Page

```
┌─────────────────────────────────────────────────────────────────┐
│  🔗 Rentars                              [Connect Wallet]       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Find Your Perfect Rental                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🔍 Search properties...                    [Search]     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Featured Properties                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  [Image]     │  │  [Image]     │  │  [Image]     │         │
│  │              │  │              │  │              │         │
│  │  Downtown    │  │  Beach House │  │  Mountain    │         │
│  │  $150/night  │  │  $200/night  │  │  $95/night   │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Property Detail

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Back    Modern Downtown Apartment         [Connect Wallet]  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────┐  │
│  │                     │  │  $150 / night                   │  │
│  │   [Property Image]  │  │  ★★★★★ (24 reviews)            │  │
│  │                     │  │                                 │  │
│  │                     │  │  Location: San Francisco, CA    │  │
│  │                     │  │  2 bed • 1 bath • 4 guests      │  │
│  └─────────────────────┘  │                                 │  │
│                           │  [Check In]   [Check Out]        │  │
│  Description:             │                                 │  │
│  Beautiful modern apt...  │  ┌───────────────────────────┐  │  │
│                           │  │      Book Now             │  │  │
│  Amenities:               │  └───────────────────────────┘  │  │
│  ✓ WiFi  ✓ Kitchen       │                                 │  │
│  ✓ Parking  ✓ AC         │                                 │  │
│                           └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Wallet Connection Issues

1. **Freighter not installed**: Install from [freighter.app](https://www.freighter.app/)
2. **Network mismatch**: Ensure wallet network matches app network
3. **Account not funded**: Get testnet XLM from [Stellar Lab](https://laboratory.stellar.org/)

### Build Errors

```bash
# Clear cache and rebuild
rm -rf .next
yarn build
```

### API Connection

Ensure backend is running on port 3000 before starting frontend.

---

## Related Documentation

- [Root README](../../README.md) — repository setup, workspace structure, ports, migrations, and test commands
- [DEPLOYMENT.md](../../DEPLOYMENT.md) — staging/testnet deployment guide and production limitations
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — contribution workflow and checklists
- [Backend README](../backend/README.md)
- [Contract Overview](../contracts/CONTRACT_OVERVIEW.md)
- [Design System](./DESIGN_SYSTEM.md)
