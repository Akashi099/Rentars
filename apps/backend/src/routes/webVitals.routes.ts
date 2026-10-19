import { type Request, type Response, Router } from 'express';
import { structuredLog } from '../middleware/logging.middleware.js';

const router = Router();

interface WebVitalMetric {
  name: string;
  value: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  delta?: number;
  id: string;
  navigationType?: string;
  path: string;
  timestamp: number;
}

/**
 * POST /api/v1/web-vitals
 * 
 * Receives Core Web Vitals from frontend RUM (Real User Monitoring).
 * Logs metrics for analysis and alerting.
 * 
 * @openapi
 * /api/v1/web-vitals:
 *   post:
 *     tags: [Monitoring]
 *     summary: Report Web Vitals metrics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, value, id, path, timestamp]
 *             properties:
 *               name:
 *                 type: string
 *                 enum: [CLS, FID, LCP, TTFB, INP]
 *               value:
 *                 type: number
 *               rating:
 *                 type: string
 *                 enum: [good, needs-improvement, poor]
 *               delta:
 *                 type: number
 *               id:
 *                 type: string
 *               navigationType:
 *                 type: string
 *               path:
 *                 type: string
 *               timestamp:
 *                 type: number
 *     responses:
 *       204:
 *         description: Metric recorded
 *       400:
 *         description: Invalid metric data
 */
router.post('/web-vitals', (req: Request, res: Response) => {
  const metric = req.body as WebVitalMetric;

  // Basic validation
  if (!metric.name || typeof metric.value !== 'number' || !metric.path) {
    return res.status(400).json({ error: 'Invalid metric data' });
  }

  // Log for analysis (could be sent to monitoring service)
  structuredLog({
    level: 'info',
    message: 'Web Vitals metric',
    timestamp: new Date(metric.timestamp).toISOString(),
    metricName: metric.name,
    metricValue: metric.value,
    metricRating: metric.rating,
    path: metric.path,
    navigationType: metric.navigationType,
  });

  // Return 204 No Content (success with no response body)
  res.status(204).end();
});

export default router;
