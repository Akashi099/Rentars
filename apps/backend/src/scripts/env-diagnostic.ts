#!/usr/bin/env bun
/**
 * Environment diagnostic script — reports missing configuration without exposing values.
 * 
 * Usage:
 *   bun run scripts/env-diagnostic.ts
 */

import 'dotenv/config';

const REQUIRED_VARS = [
  'PORT',
  'NODE_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'CORS_ORIGIN',
];

const OPTIONAL_VARS = [
  'REDIS_URL',
  'STELLAR_NETWORK',
  'STELLAR_RPC_URL',
  'PROPERTY_LISTING_CONTRACT_ID',
  'BOOKING_CONTRACT_ID',
  'TRUSTLESS_WORK_API_URL',
  'TRUSTLESS_WORK_API_KEY',
  'GEOCODING_API_KEY',
  'HCAPTCHA_SECRET_KEY',
  'HCAPTCHA_ENABLED',
  'METRICS_TOKEN',
];

console.log('\n📋 Backend Environment Configuration Diagnostic\n');
console.log('━'.repeat(60));
console.log('\nRequired Configuration:');

let hasErrors = false;

for (const key of REQUIRED_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ❌ ${key}: MISSING`);
    hasErrors = true;
  } else {
    // Mask sensitive values
    const displayValue = key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD')
      ? '[REDACTED]'
      : value.substring(0, 30) + (value.length > 30 ? '...' : '');
    console.log(`  ✅ ${key}: ${displayValue}`);
  }
}

console.log('\nOptional Configuration:');

for (const key of OPTIONAL_VARS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ⚪ ${key}: NOT SET`);
  } else {
    const displayValue = key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD')
      ? '[REDACTED]'
      : value.substring(0, 30) + (value.length > 30 ? '...' : '');
    console.log(`  ✅ ${key}: ${displayValue}`);
  }
}

console.log('\n━'.repeat(60));

if (hasErrors) {
  console.log('\n❌ Configuration incomplete. Fix missing required variables.\n');
  process.exit(1);
} else {
  console.log('\n✅ All required configuration present.\n');
  process.exit(0);
}
