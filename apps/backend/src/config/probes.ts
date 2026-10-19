/**
 * Synthetic monitoring probe configuration.
 *
 * Defines external health checks that run from outside the cluster to validate
 * real user paths: frontend load, API health, auth, search, and booking journeys.
 */

export interface ProbeTarget {
  name: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus: number;
  timeoutMs: number;
  validate?: (response: ProbeResponse) => boolean;
}

export interface ProbeResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  durationMs: number;
  error?: string;
}

export interface ProbeResult {
  target: ProbeTarget;
  response: ProbeResponse;
  success: boolean;
  timestamp: string;
  deploymentVersion?: string;
  location: string;
}

export interface ProbeSuite {
  name: string;
  description: string;
  targets: ProbeTarget[];
  schedule: string; // cron expression
  alertThreshold: {
    consecutiveFailures: number;
    windowMinutes: number;
  };
  testAccount?: {
    email: string;
    password: string;
  };
}

export interface ProbeConfig {
  enabled: boolean;
  location: string;
  deploymentVersion: string;
  suites: ProbeSuite[];
  authTokenTtlMinutes: number;
  defaultTimeoutMs: number;
}

export const defaultProbeConfig: ProbeConfig = {
  enabled: process.env.PROBES_ENABLED === 'true',
  location: process.env.PROBE_LOCATION ?? 'external',
  deploymentVersion: process.env.DEPLOYMENT_VERSION ?? 'unknown',
  authTokenTtlMinutes: 15,
  defaultTimeoutMs: 10000,
  suites: [
    {
      name: 'frontend_load',
      description: 'Verify frontend loads and critical assets are reachable',
      schedule: '*/2 * * * *', // every 2 minutes
      alertThreshold: { consecutiveFailures: 3, windowMinutes: 10 },
      targets: [
        {
          name: 'frontend_root',
          url: `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}/`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 10000,
          validate: (res) =>
            typeof res.body === 'string' && (res.body as string).includes('Rentars'),
        },
        {
          name: 'frontend_health',
          url: `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}/api/health`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
      ],
    },
    {
      name: 'api_health',
      description: 'Verify backend API health and dependencies',
      schedule: '*/1 * * * *', // every minute
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 5 },
      targets: [
        {
          name: 'api_health',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/health`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'status' in res.body &&
            (res.body as { status: string }).status === 'ok',
        },
        {
          name: 'api_properties_list',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?limit=1`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
        {
          name: 'api_search',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?city=Test&limit=1`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
      ],
    },
    {
      name: 'auth_journey',
      description: 'Verify authentication flow with test account',
      schedule: '*/5 * * * *', // every 5 minutes
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 15 },
      testAccount: {
        email: process.env.PROBE_TEST_EMAIL ?? 'probe-test@rentars.local',
        password: process.env.PROBE_TEST_PASSWORD ?? 'ProbeTest123!',
      },
      targets: [
        {
          name: 'auth_login',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/auth/login`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          expectedStatus: 200,
          timeoutMs: 10000,
          validate: (res) =>
            res.body &&
            typeof res.body === 'object' &&
            'token' in res.body,
        },
      ],
    },
    {
      name: 'booking_read_journey',
      description: 'Verify read-only booking journey (list property, view details)',
      schedule: '*/10 * * * *', // every 10 minutes
      alertThreshold: { consecutiveFailures: 2, windowMinutes: 20 },
      targets: [
        {
          name: 'booking_list_properties',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties?limit=5`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
        {
          name: 'booking_view_property',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/properties/probe-test-property`,
          method: 'GET',
          expectedStatus: 200,
          timeoutMs: 5000,
        },
      ],
    },
    {
      name: 'booking_write_probe',
      description: 'Isolated test booking creation and cancellation (no real funds)',
      schedule: '*/30 * * * *', // every 30 minutes
      alertThreshold: { consecutiveFailures: 1, windowMinutes: 60 },
      testAccount: {
        email: process.env.PROBE_BOOKING_EMAIL ?? 'probe-booking@rentars.local',
        password: process.env.PROBE_BOOKING_PASSWORD ?? 'ProbeBooking123!',
      },
      targets: [
        {
          name: 'booking_auth',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/auth/login`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          expectedStatus: 200,
          timeoutMs: 10000,
        },
        {
          name: 'booking_create',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/bookings`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{token}}' },
          body: {
            propertyId: 'probe-test-property',
            startDate: new Date(Date.now() + 86400000).toISOString().split('T')[0], // tomorrow
            endDate: new Date(Date.now() + 172800000).toISOString().split('T')[0], // day after tomorrow
            guestCount: 1,
          },
          expectedStatus: 201,
          timeoutMs: 30000,
        },
        {
          name: 'booking_cancel',
          url: `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1/bookings/{{bookingId}}/cancel`,
          method: 'POST',
          headers: { Authorization: 'Bearer {{token}}' },
          expectedStatus: 200,
          timeoutMs: 10000,
        },
      ],
    },
  ],
};

export function getProbeConfig(): ProbeConfig {
  return defaultProbeConfig;
}

export function getEnabledSuites(config: ProbeConfig): ProbeSuite[] {
  return config.enabled ? config.suites : [];
}

export function getSuiteByName(config: ProbeConfig, name: string): ProbeSuite | undefined {
  return config.suites.find((s) => s.name === name);
}