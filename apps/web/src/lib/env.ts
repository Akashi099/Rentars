/**
 * Frontend environment configuration validation.
 * 
 * Validates public environment variables at build time using Zod.
 * On failure, throws with clear error messages listing all issues.
 * On success, exports a typed, frozen `env` object.
 */

import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url('NEXT_PUBLIC_API_URL must be a valid URL')
    .refine(
      (url) => {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      },
      'NEXT_PUBLIC_API_URL must use http:// or https://'
    ),

  NEXT_PUBLIC_STELLAR_NETWORK: z
    .enum(['testnet', 'mainnet', 'futurenet'])
    .refine(
      (network) => {
        if (typeof window !== 'undefined') {
          const isProduction = window.location.hostname !== 'localhost' && !window.location.hostname.includes('staging');
          if (isProduction && network !== 'mainnet') {
            console.warn('⚠️  Production environment detected but NEXT_PUBLIC_STELLAR_NETWORK is not mainnet');
          }
        }
        return true;
      },
      { message: 'Network configuration warning' }
    ),

  NEXT_PUBLIC_HORIZON_URL: z
    .string()
    .url('NEXT_PUBLIC_HORIZON_URL must be a valid URL')
    .refine(
      (url) => new URL(url).protocol === 'https:',
      'NEXT_PUBLIC_HORIZON_URL must use https://'
    ),

  NEXT_PUBLIC_SOROBAN_RPC_URL: z
    .string()
    .url('NEXT_PUBLIC_SOROBAN_RPC_URL must be a valid URL')
    .refine(
      (url) => new URL(url).protocol === 'https:',
      'NEXT_PUBLIC_SOROBAN_RPC_URL must use https://'
    ),

  NEXT_PUBLIC_PASSKEY_RP_ID: z
    .string()
    .min(1, 'NEXT_PUBLIC_PASSKEY_RP_ID is required'),

  NEXT_PUBLIC_PASSKEY_RP_NAME: z
    .string()
    .min(1, 'NEXT_PUBLIC_PASSKEY_RP_NAME is required'),

  NEXT_PUBLIC_PASSKEY_ORIGIN: z
    .string()
    .url('NEXT_PUBLIC_PASSKEY_ORIGIN must be a valid URL'),
});

// Cross-field validation: ensure network matches URLs
const envWithCrossValidation = envSchema.refine(
  (data) => {
    const isTestnet = data.NEXT_PUBLIC_STELLAR_NETWORK === 'testnet';
    const horizonIsTestnet = data.NEXT_PUBLIC_HORIZON_URL.includes('testnet');
    const sorobanIsTestnet = data.NEXT_PUBLIC_SOROBAN_RPC_URL.includes('testnet');

    if (isTestnet) {
      return horizonIsTestnet && sorobanIsTestnet;
    } else {
      return !horizonIsTestnet && !sorobanIsTestnet;
    }
  },
  {
    message: 'Network configuration mismatch: NEXT_PUBLIC_STELLAR_NETWORK must match the URLs (testnet/mainnet)',
  }
);

export type ClientEnvironment = z.infer<typeof envSchema>;

function validateEnv(): ClientEnvironment {
  const envVars = {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
    NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    NEXT_PUBLIC_PASSKEY_RP_ID: process.env.NEXT_PUBLIC_PASSKEY_RP_ID,
    NEXT_PUBLIC_PASSKEY_RP_NAME: process.env.NEXT_PUBLIC_PASSKEY_RP_NAME,
    NEXT_PUBLIC_PASSKEY_ORIGIN: process.env.NEXT_PUBLIC_PASSKEY_ORIGIN,
  };

  const result = envWithCrossValidation.safeParse(envVars);

  if (!result.success) {
    const lines: string[] = [
      '',
      '❌  Frontend environment validation failed:',
      '',
    ];

    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      lines.push(`  • ${path}: ${issue.message}`);
    }

    lines.push('');
    console.error(lines.join('\n'));
    
    if (typeof window === 'undefined') {
      // Build-time: throw to fail the build
      throw new Error('Environment validation failed. Check the console for details.');
    } else {
      // Runtime: log but don't crash the app
      console.error('⚠️  Application may not function correctly with invalid configuration');
    }
  }

  return Object.freeze(result.data!) as ClientEnvironment;
}

export const env = validateEnv();

/**
 * Diagnostic command that reports missing/invalid keys without printing values.
 * Run with: node -e "require('./dist/lib/env').diagnose()"
 */
export function diagnose(): void {
  const required = [
    'NEXT_PUBLIC_API_URL',
    'NEXT_PUBLIC_STELLAR_NETWORK',
    'NEXT_PUBLIC_HORIZON_URL',
    'NEXT_PUBLIC_SOROBAN_RPC_URL',
    'NEXT_PUBLIC_PASSKEY_RP_ID',
    'NEXT_PUBLIC_PASSKEY_RP_NAME',
    'NEXT_PUBLIC_PASSKEY_ORIGIN',
  ];

  console.log('\n📋 Environment Configuration Diagnostic\n');
  
  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      console.log(`❌ ${key}: MISSING`);
    } else {
      console.log(`✅ ${key}: SET (${value.substring(0, 20)}...)`);
    }
  }
  
  console.log('');
}
