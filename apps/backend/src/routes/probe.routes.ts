/**
 * Probe management and results API.
 *
 * Provides endpoints to:
 * - Trigger probe runs manually
 * - View probe results and status
 * - Get probe scheduler status
 */

import { type Request, type Response, Router } from 'express';
import { supabase } from '@/config/supabase.js';
import { getProbeConfig, getEnabledSuites, getSuiteByName } from '@/config/probes.js';
import { runProbeSuite, runAllProbes } from '@/services/probe.service.js';
import { startProbeScheduler, stopProbeScheduler, getScheduledJobs } from '@/services/probe-scheduler.js';
import { structuredLog } from '@/middleware/logging.middleware.js';
import { authorizeRole } from '@/middleware/authorizeRole.middleware.js';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  const config = getProbeConfig();
  const jobs = getScheduledJobs();

  res.json({
    enabled: config.enabled,
    location: config.location,
    deploymentVersion: config.deploymentVersion,
    suites: getEnabledSuites(config).map((s) => ({
      name: s.name,
      description: s.description,
      schedule: s.schedule,
      alertThreshold: s.alertThreshold,
      targets: s.targets.map((t) => t.name),
    })),
    scheduledJobs: jobs,
  });
});

router.post('/run', authorizeRole('admin'), async (req: Request, res: Response) => {
  const { suite } = req.body as { suite?: string };

  try {
    if (suite) {
      const suiteConfig = getSuiteByName(getProbeConfig(), suite);
      if (!suiteConfig) {
        res.status(404).json({ error: `Suite not found: ${suite}` });
        return;
      }
      const results = await runProbeSuite(suiteConfig);
      res.json({ suite: suiteConfig.name, results });
    } else {
      await runAllProbes();
      res.json({ message: 'All probe suites triggered' });
    }
  } catch (err) {
    structuredLog({
      level: 'error',
      message: 'Manual probe run failed',
      timestamp: new Date().toISOString(),
      error: String(err),
    });
    res.status(500).json({ error: 'Probe execution failed' });
  }
});

router.get('/results', async (req: Request, res: Response) => {
  const { suite, location, limit = '50', since } = req.query as {
    suite?: string;
    location?: string;
    limit?: string;
    since?: string;
  };

  const config = getProbeConfig();
  const probeLocation = location ?? config.location;

  let query = supabase
    .from('probe_results')
    .select('*')
    .eq('location', probeLocation)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit, 10));

  if (suite) {
    query = query.eq('suite_name', suite);
  }

  if (since) {
    query = query.gte('created_at', since);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ results: data ?? [] });
});

router.get('/results/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('probe_results')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    res.status(404).json({ error: 'Result not found' });
    return;
  }

  res.json(data);
});

router.post('/scheduler/start', authorizeRole('admin'), (_req: Request, res: Response) => {
  startProbeScheduler();
  res.json({ message: 'Probe scheduler started' });
});

router.post('/scheduler/stop', authorizeRole('admin'), (_req: Request, res: Response) => {
  stopProbeScheduler();
  res.json({ message: 'Probe scheduler stopped' });
});

router.get('/scheduler/jobs', (_req: Request, res: Response) => {
  res.json({ jobs: getScheduledJobs() });
});

router.get('/health', async (_req: Request, res: Response) => {
  const config = getProbeConfig();
  const location = config.location;

  const { data, error } = await supabase
    .from('probe_results')
    .select('suite_name, overall_success, created_at')
    .eq('location', location)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    res.status(503).json({ error: error.message });
    return;
  }

  const suiteStatus = new Map<string, { lastRun: string; success: boolean; consecutiveFailures: number }>();

  for (const row of data ?? []) {
    if (!suiteStatus.has(row.suite_name)) {
      suiteStatus.set(row.suite_name, {
        lastRun: row.created_at,
        success: row.overall_success,
        consecutiveFailures: 0,
      });
    }
    const status = suiteStatus.get(row.suite_name)!;
    if (!row.overall_success) {
      status.consecutiveFailures++;
    } else {
      status.consecutiveFailures = 0;
    }
  }

  const degraded = Array.from(suiteStatus.values()).some(
    (s) => s.consecutiveFailures >= getSuiteByName(config, Array.from(suiteStatus.keys())[0])?.alertThreshold.consecutiveFailures ?? 3,
  );

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    location,
    deploymentVersion: config.deploymentVersion,
    suites: Array.from(suiteStatus.entries()).map(([suite, status]) => ({
      suite,
      lastRun: status.lastRun,
      lastSuccess: status.success,
      consecutiveFailures: status.consecutiveFailures,
    })),
  });
});

export default router;