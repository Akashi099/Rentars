/**
 * Probe scheduler — runs synthetic monitoring probes on configured cron schedules.
 */

import { getProbeConfig, type ProbeSuite } from '@/config/probes.js';
import { runAllProbes, runProbeSuite } from './probe.service.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

interface ScheduledJob {
  suite: ProbeSuite;
  intervalId: NodeJS.Timeout;
  nextRun: Date;
}

const scheduledJobs: ScheduledJob[] = [];

function parseCron(cron: string): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } {
  const parts = cron.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  };
}

function parseCronField(field: string, min: number, max: number): number {
  if (field === '*') return -1;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step;
  }
  const val = parseInt(field, 10);
  if (isNaN(val) || val < min || val > max) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  return val;
}

function getNextRunTime(cron: string, from: Date = new Date()): Date {
  const parsed = parseCron(cron);
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (parsed.minute >= 0) {
    if (next.getMinutes() >= parsed.minute) {
      next.setHours(next.getHours() + 1);
    }
    next.setMinutes(parsed.minute);
  } else if (typeof parsed.minute === 'number' && parsed.minute > 0) {
    const step = parsed.minute;
    const currentMinute = next.getMinutes();
    const nextMinute = Math.ceil((currentMinute + 1) / step) * step;
    if (nextMinute >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMinute % 60);
    } else {
      next.setMinutes(nextMinute);
    }
  } else {
    next.setMinutes(next.getMinutes() + 1);
  }

  if (parsed.hour >= 0 && next.getHours() !== parsed.hour) {
    if (next.getHours() > parsed.hour) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(parsed.hour);
  }

  return next;
}

function scheduleSuite(suite: ProbeSuite): NodeJS.Timeout {
  const config = getProbeConfig();
  const nextRun = getNextRunTime(suite.schedule);
  const delay = Math.max(0, nextRun.getTime() - Date.now());

  structuredLog({
    level: 'info',
    message: `Scheduled probe suite: ${suite.name}`,
    timestamp: new Date().toISOString(),
    suite: suite.name,
    schedule: suite.schedule,
    nextRun: nextRun.toISOString(),
    delayMs: delay,
  });

  const runAndReschedule = async () => {
    try {
      await runProbeSuite(suite, config);
    } catch (err) {
      structuredLog({
        level: 'error',
        message: `Probe suite ${suite.name} execution failed`,
        timestamp: new Date().toISOString(),
        suite: suite.name,
        error: String(err),
      });
    }

    const next = getNextRunTime(suite.schedule);
    const nextDelay = Math.max(0, next.getTime() - Date.now());

    setTimeout(runAndReschedule, nextDelay);
  };

  return setTimeout(runAndReschedule, delay);
}

export function startProbeScheduler(): void {
  const config = getProbeConfig();

  if (!config.enabled) {
    structuredLog({
      level: 'info',
      message: 'Probe scheduler not started (probes disabled)',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const suites = getEnabledSuites(config);

  for (const suite of suites) {
    const intervalId = scheduleSuite(suite);
    scheduledJobs.push({ suite, intervalId, nextRun: getNextRunTime(suite.schedule) });
  }

  structuredLog({
    level: 'info',
    message: 'Probe scheduler started',
    timestamp: new Date().toISOString(),
    suites: suites.map((s) => s.name),
  });
}

export function stopProbeScheduler(): void {
  for (const job of scheduledJobs) {
    clearTimeout(job.intervalId);
  }
  scheduledJobs.length = 0;
  structuredLog({
    level: 'info',
    message: 'Probe scheduler stopped',
    timestamp: new Date().toISOString(),
  });
}

export function getScheduledJobs(): ReadonlyArray<{ suite: string; nextRun: string }> {
  return scheduledJobs.map((job) => ({
    suite: job.suite.name,
    nextRun: job.nextRun.toISOString(),
  }));
}

function getEnabledSuites(config: ReturnType<typeof getProbeConfig>) {
  return config.enabled ? config.suites : [];
}