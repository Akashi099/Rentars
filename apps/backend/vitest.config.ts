import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: false,
          include: ['src/**/*.{test,spec}.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/*.testnet.{test,spec}.ts',
            '**/certification/**',
          ],
        },
        resolve: {
          alias: {
            '@': path.resolve(__dirname, './src'),
          },
        },
      },
      {
        test: {
          name: 'stellar-testnet-certification',
          environment: 'node',
          globals: false,
          include: [
            'src/**/*.testnet.{test,spec}.ts',
            'src/**/certification/**/*.{test,spec}.ts',
            'test/certification/**/*.{test,spec}.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // Certification runs against a real network and disposable accounts;
          // allow generous timeouts for provisioning, funding, and confirmation.
          testTimeout: 120_000,
          hookTimeout: 180_000,
          teardownTimeout: 60_000,
          // Run sequentially to keep testnet account provisioning and cleanup
          // deterministic and avoid collisions between certification cases.
          fileParallelism: false,
          sequence: {
            concurrent: false,
          },
          // Env-gated execution: the suite only runs when explicitly enabled.
          // When disabled, all certification files are skipped.
          env: {
            STELLAR_CERTIFICATION_ENABLED:
              process.env.STELLAR_CERTIFICATION_ENABLED ?? 'false',
          },
        },
        resolve: {
          alias: {
            '@': path.resolve(__dirname, './src'),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});