import { describe, expect, it } from 'bun:test';

// env.ts validates at import time and calls process.exit(1) on failure, so each
// case runs in a child process with its own environment.
const base: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  JWT_SECRET: 'test_jwt_secret_min_32_chars_long',
  PREF_TOKEN_SECRET: 'test_pref_token_secret_min_32_chars',
  FRONTEND_URL: 'https://rentars.app',
  STELLAR_NETWORK: 'testnet',
};

async function loadEnv(extra: Record<string, string | undefined>): Promise<number> {
  const env: Record<string, string> = { ...base, PATH: process.env.PATH ?? '' };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  const proc = Bun.spawn(['bun', '-e', "await import('./src/config/env.ts')"], {
    cwd: `${import.meta.dir}/../..`,
    env,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.exited;
}

describe('env: production CORS origins', () => {
  it('rejects production when CORS_ORIGIN is not set explicitly', async () => {
    expect(await loadEnv({ NODE_ENV: 'production', CORS_ORIGIN: undefined })).toBe(1);
  });

  it('rejects production origins that are not https', async () => {
    expect(await loadEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'http://app.rentars.com' })).toBe(
      1
    );
  });

  it('accepts explicit https origins in production', async () => {
    expect(await loadEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://app.rentars.com' })).toBe(
      0
    );
  });

  it('keeps the localhost default outside production', async () => {
    expect(await loadEnv({ NODE_ENV: 'development', CORS_ORIGIN: undefined })).toBe(0);
  });
});
