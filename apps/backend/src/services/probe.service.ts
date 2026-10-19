/**
 * Synthetic monitoring probe runner.
 *
 * Executes configured probe suites on a schedule, records results,
 * and triggers alerts on repeated failures.
 */

import { performance } from 'node:perf_hooks';
import { supabase } from '@/config/supabase.js';
import { structuredLog } from '@/middleware/logging.middleware.js';
import { incCounter } from '@/middleware/metrics.middleware.js';
import {
  getProbeConfig,
  type ProbeConfig,
  type ProbeSuite,
  type ProbeTarget,
  type ProbeResult,
  type ProbeResponse,
} from '@/config/probes.js';

interface ProbeContext {
  token?: string;
  bookingId?: string;
  variables: Record<string, string>;
}

function interpolate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function executeTarget(
  target: ProbeTarget,
  context: ProbeContext,
  deploymentVersion: string,
  location: string,
): Promise<ProbeResult> {
  const startMs = performance.now();
  let response: ProbeResponse;

  try {
    const url = interpolate(target.url, context.variables);
    const headers: Record<string, string> = {
      'User-Agent': 'Rentars-Probe/1.0',
      ...target.headers,
    };

    Object.entries(headers).forEach(([k, v]) => {
      headers[k] = interpolate(v, context.variables);
    });

    let body: string | undefined;
    if (target.body) {
      const interpolatedBody: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(target.body)) {
        interpolatedBody[k] = typeof v === 'string' ? interpolate(v, context.variables) : v;
      }
      body = JSON.stringify(interpolatedBody);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), target.timeoutMs);

    const res = await fetch(url, {
      method: target.method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const rawBody = await res.text();
    let responseBody: unknown = rawBody;
    if (res.headers.get('content-type')?.includes('application/json')) {
      try {
        responseBody = JSON.parse(rawBody);
      } catch {
        responseBody = rawBody;
      }
    }

    response = {
      status: res.status,
      body: responseBody,
      headers: Object.fromEntries(res.headers.entries()),
      durationMs: performance.now() - startMs,
    };
  } catch (err) {
    response = {
      status: 0,
      body: null,
      headers: {},
      durationMs: performance.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let success = response.status === target.expectedStatus;
  if (success && target.validate) {
    try {
      success = target.validate(response);
    } catch {
      success = false;
    }
  }

  const result: ProbeResult = {
    target,
    response,
    success,
    timestamp: new Date().toISOString(),
    deploymentVersion,
    location,
  };

  return result;
}

async function authenticateTestAccount(
  suite: ProbeSuite,
  config: ProbeConfig,
  context: ProbeContext,
): Promise<boolean> {
  if (!suite.testAccount) return true;

  const loginTarget = suite.targets.find((t) => t.name === 'auth_login') ?? suite.targets[0];
  const body = {
    email: suite.testAccount.email,
    password: suite.testAccount.password,
  };

  const targetWithBody: ProbeTarget = { ...loginTarget, body };
  const result = await executeTarget(targetWithBody, context, config.deploymentVersion, config.location);

  if (result.success && result.response.body && typeof result.response.body === 'object') {
    const token = (result.response.body as { token?: string }).token;
    if (token) {
      context.token = token;
      context.variables.token = token;
      return true;
    }
  }

  return false;
}

async function runBookingWriteProbe(
  suite: ProbeSuite,
  config: ProbeConfig,
  context: ProbeContext,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const authOk = await authenticateTestAccount(suite, config, context);
  if (!authOk) {
    structuredLog({
      level: 'error',
      message: 'Booking probe authentication failed',
      timestamp: new Date().toISOString(),
      suite: suite.name,
      location: config.location,
    });
    return results;
  }

  for (const target of suite.targets) {
    if (target.name === 'auth_login') continue;

    const result = await executeTarget(target, context, config.deploymentVersion, config.location);
    results.push(result);

    if (target.name === 'booking_create' && result.success) {
      const bookingId = (result.response.body as { id?: string })?.id;
      if (bookingId) {
        context.bookingId = bookingId;
        context.variables.bookingId = bookingId;
      }
    }

    if (!result.success) {
      break;
    }
  }

  return results;
}

export async function runProbeSuite(
  suite: ProbeSuite,
  config: ProbeConfig = getProbeConfig(),
): Promise<ProbeResult[]> {
  const context: ProbeContext = { variables: {} };
  const results: ProbeResult[] = [];

  if (suite.name === 'booking_write_probe') {
    const writeResults = await runBookingWriteProbe(suite, config, context);
    return writeResults;
  }

  if (suite.testAccount) {
    const authOk = await authenticateTestAccount(suite, config, context);
    if (!authOk) {
      structuredLog({
        level: 'error',
        message: 'Probe authentication failed',
        timestamp: new Date().toISOString(),
        suite: suite.name,
        location: config.location,
      });
      return results;
    }
  }

  for (const target of suite.targets) {
    const result = await executeTarget(target, context, config.deploymentVersion, config.location);
    results.push(result);

    if (!result.success) {
      structuredLog({
        level: 'warn',
        message: 'Probe target failed',
        timestamp: new Date().toISOString(),
        suite: suite.name,
        target: target.name,
        status: result.response.status,
        expected: target.expectedStatus,
        error: result.response.error,
        durationMs: result.response.durationMs,
        deploymentVersion: config.deploymentVersion,
        location: config.location,
      });
      break;
    }
  }

  return results;
}

async function recordProbeResults(
  suiteName: string,
  results: ProbeResult[],
  config: ProbeConfig,
): Promise<void> {
  const overallSuccess = results.every((r) => r.success);
  const failedTargets = results.filter((r) => !r.success).map((r) => r.target.name);

  try {
    await supabase.from('probe_results').insert({
      suite_name: suiteName,
      location: config.location,
      deployment_version: config.deploymentVersion,
      overall_success: overallSuccess,
      failed_targets: failedTargets,
      results_json: results.map((r) => ({
        target: r.target.name,
        success: r.success,
        status: r.response.status,
        duration_ms: r.response.durationMs,
        error: r.response.error,
      })),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    structuredLog({
      level: 'error',
      message: 'Failed to persist probe results',
      timestamp: new Date().toISOString(),
      suite: suiteName,
      error: String(err),
    });
  }

  incCounter(probeRunsTotal, { suite: suiteName, outcome: overallSuccess ? 'success' : 'failure' });
  for (const result of results) {
    incCounter(probeTargetTotal, {
      suite: suiteName,
      target: result.target.name,
      outcome: result.success ? 'success' : 'failure',
    });
    observeHistogram(probeDurationSeconds, { suite: suiteName, target: result.target.name }, result.response.durationMs / 1000);
  }
}

async function checkAlertThreshold(suite: ProbeSuite, config: ProbeConfig): Promise<void> {
  const { consecutiveFailures, windowMinutes } = suite.alertThreshold;
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();

  try {
    const { data, error } = await supabase
      .from('probe_results')
      .select('overall_success, created_at')
      .eq('suite_name', suite.name)
      .eq('location', config.location)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(consecutiveFailures);

    if (error || !data || data.length < consecutiveFailures) return;

    const recentFailures = data.filter((r) => !r.overall_success).length;
    if (recentFailures >= consecutiveFailures) {
      structuredLog({
        level: 'error',
        message: 'Probe alert threshold exceeded',
        timestamp: new Date().toISOString(),
        suite: suite.name,
        location: config.location,
        consecutiveFailures: recentFailures,
        windowMinutes,
        deploymentVersion: config.deploymentVersion,
        alert: true,
      });

      incCounter(probeAlertsTotal, { suite: suite.name, location: config.location });
    }
  } catch (err) {
    structuredLog({
      level: 'error',
      message: 'Failed to check probe alert threshold',
      timestamp: new Date().toISOString(),
      suite: suite.name,
      error: String(err),
    });
  }
}

export async function runAllProbes(config: ProbeConfig = getProbeConfig()): Promise<void> {
  if (!config.enabled) {
    structuredLog({
      level: 'debug',
      message: 'Probes disabled, skipping run',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const suites = getEnabledSuites(config);

  for (const suite of suites) {
    try {
      const results = await runProbeSuite(suite, config);
      await recordProbeResults(suite.name, results, config);
      await checkAlertThreshold(suite, config);
    } catch (err) {
      structuredLog({
        level: 'error',
        message: 'Probe suite crashed',
        timestamp: new Date().toISOString(),
        suite: suite.name,
        error: String(err),
      });
      incCounter(probeRunsTotal, { suite: suite.name, outcome: 'error' });
    }
  }
}

function createCounter(name: string, help: string) {
  return { name, help, type: 'counter' as const };
}

function createHistogram(name: string, help: string, buckets: number[]) {
  return { name, help, type: 'histogram' as const, buckets };
}

const probeRunsTotal = createCounter(
  'probe_runs_total',
  'Total number of probe suite executions, labelled by suite and outcome.',
);

const probeTargetTotal = createCounter(
  'probe_target_total',
  'Total number of individual probe target executions, labelled by suite, target, and outcome.',
);

const probeDurationSeconds = createHistogram(
  'probe_duration_seconds',
  'Probe target execution latency in seconds, labelled by suite and target.',
  [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
);

const probeAlertsTotal = createCounter(
  'probe_alerts_total',
  'Total number of probe alert threshold breaches, labelled by suite and location.',
);

export { createCounter, createHistogram, probeRunsTotal, probeTargetTotal, probeDurationSeconds, probeAlertsTotal };