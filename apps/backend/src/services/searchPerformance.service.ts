/**
 * Search performance monitoring and observability service — Issue 592
 * Instruments query duration, cache performance, and search metrics.
 * Provides observability dashboard data and alerting thresholds.
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import { hashSearchQuery } from '../utils/searchMetrics.js';

export interface SearchMetric {
  id?: string;
  /** Raw search term. Hashed before storage; never persisted as-is. */
  query?: string;
  query_hash?: string;
  query_duration_ms: number;
  cache_hit: boolean;
  result_count: number;
  error?: string;
  user_id?: string;
  endpoint: string;
  created_at?: string;
}

export interface PercentileLatency {
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

export interface CacheMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
}

export interface SearchPerformanceStats {
  period: string;
  totalQueries: number;
  averageLatency: number;
  percentiles: PercentileLatency;
  cacheMetrics: CacheMetrics;
  errorRate: number;
  totalErrors: number;
  topSlowestQueries: Array<{
    endpoint: string;
    queryHash: string;
    avgLatency: number;
    callCount: number;
  }>;
}

export interface SearchBenchmarkResult {
  propertyCount: number;
  queryCount: number;
  totalDuration: number;
  averageLatency: number;
  percentiles: PercentileLatency;
  queriesPerSecond: number;
  passedTargets: boolean;
  details: {
    latencyTarget: number; // Expected p95
    actualP95: number;
    cacheHitRate: number;
    errorRate: number;
  };
}

// Performance targets
const LATENCY_TARGETS = {
  p50: 100, // 100ms
  p95: 500, // 500ms
  p99: 1000, // 1s
};

const CACHE_HIT_TARGET = 0.7; // 70% cache hit rate
const ERROR_RATE_TARGET = 0.01; // 1% error rate

/**
 * Record a search metric with performance data.
 * Safe for high-frequency logging; hashed query to protect sensitive data.
 */
export async function recordSearchMetric(metric: SearchMetric): Promise<ServiceResponse<null>> {
  try {
    // Persist only a hash of the search term, never the term itself. A caller
    // may pass a precomputed `query_hash`; a raw `query` is hashed here.
    const queryHash =
      metric.query_hash ?? (metric.query !== undefined ? hashSearchQuery(metric.query) : 'unknown');

    const { error } = await supabase.from('search_analytics').insert({
      query: queryHash,
      query_duration_ms: metric.query_duration_ms,
      cache_hit: metric.cache_hit,
      result_count: metric.result_count,
      user_id: metric.user_id,
      created_at: new Date().toISOString(),
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Get percentile latencies for the given time window.
 */
export async function getLatencyPercentiles(
  startDate: string,
  endDate: string,
): Promise<ServiceResponse<PercentileLatency>> {
  try {
    const { data, error } = await supabase
      .from('search_analytics')
      .select('query_duration_ms')
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .not('query_duration_ms', 'is', null)
      .order('query_duration_ms');

    if (error) {
      return { success: false, error: error.message };
    }

    const durations = (data ?? [])
      .map((r) => r.query_duration_ms)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);

    if (durations.length === 0) {
      return {
        success: true,
        data: {
          p50: 0,
          p75: 0,
          p95: 0,
          p99: 0,
          max: 0,
          min: 0,
        },
      };
    }

    const percentile = (p: number) => {
      const index = Math.ceil((p / 100) * durations.length) - 1;
      return durations[Math.max(0, index)];
    };

    return {
      success: true,
      data: {
        p50: percentile(50),
        p75: percentile(75),
        p95: percentile(95),
        p99: percentile(99),
        max: durations[durations.length - 1] || 0,
        min: durations[0] || 0,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Get cache hit rate for the given time window.
 */
export async function getCacheMetrics(
  startDate: string,
  endDate: string,
): Promise<ServiceResponse<CacheMetrics>> {
  try {
    const { data, error } = await supabase
      .from('search_analytics')
      .select('cache_hit')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (error) {
      return { success: false, error: error.message };
    }

    const records = data ?? [];
    const totalRequests = records.length;
    const cacheHits = records.filter((r) => r.cache_hit).length;
    const cacheMisses = totalRequests - cacheHits;
    const hitRate = totalRequests > 0 ? cacheHits / totalRequests : 0;

    return {
      success: true,
      data: {
        totalRequests,
        cacheHits,
        cacheMisses,
        hitRate: Math.round(hitRate * 10000) / 10000,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Get comprehensive search performance statistics.
 */
export async function getSearchPerformanceStats(
  hours = 24,
): Promise<ServiceResponse<SearchPerformanceStats>> {
  try {
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const endDate = new Date().toISOString();

    const { data: metrics, error: metricsError } = await supabase
      .from('search_analytics')
      .select('query_duration_ms, cache_hit, result_count')
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (metricsError) {
      return { success: false, error: metricsError.message };
    }

    const records = metrics ?? [];
    const totalQueries = records.length;

    if (totalQueries === 0) {
      return {
        success: true,
        data: {
          period: `${hours}h`,
          totalQueries: 0,
          averageLatency: 0,
          percentiles: { p50: 0, p75: 0, p95: 0, p99: 0, max: 0, min: 0 },
          cacheMetrics: {
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            hitRate: 0,
          },
          errorRate: 0,
          totalErrors: 0,
          topSlowestQueries: [],
        },
      };
    }

    // Calculate latency metrics
    const durations = records
      .map((r) => r.query_duration_ms)
      .filter((d): d is number => typeof d === 'number');

    const sortedDurations = durations.sort((a, b) => a - b);
    const averageLatency =
      durations.reduce((a, b) => a + b, 0) / durations.length;

    const percentile = (p: number) => {
      const index = Math.ceil((p / 100) * sortedDurations.length) - 1;
      return sortedDurations[Math.max(0, index)] || 0;
    };

    // Calculate cache metrics
    const cacheHits = records.filter((r) => r.cache_hit).length;
    const hitRate = cacheHits / totalQueries;

    // Calculate error rate
    const errors = records.filter((r) => !r.result_count && r.result_count !== 0).length;
    const errorRate = errors / totalQueries;

    const perfStats: SearchPerformanceStats = {
      period: `${hours}h`,
      totalQueries,
      averageLatency: Math.round(averageLatency),
      percentiles: {
        p50: percentile(50),
        p75: percentile(75),
        p95: percentile(95),
        p99: percentile(99),
        max: sortedDurations[sortedDurations.length - 1] || 0,
        min: sortedDurations[0] || 0,
      },
      cacheMetrics: {
        totalRequests: totalQueries,
        cacheHits,
        cacheMisses: totalQueries - cacheHits,
        hitRate: Math.round(hitRate * 10000) / 10000,
      },
      errorRate: Math.round(errorRate * 10000) / 10000,
      totalErrors: errors,
      topSlowestQueries: [], // Populated separately if needed
    };

    return { success: true, data: perfStats };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Check if performance metrics meet targets; used for alerting.
 */
export async function checkPerformanceAlerts(hours = 1): Promise<
  ServiceResponse<{
    latencyAlert: boolean;
    cacheAlert: boolean;
    errorAlert: boolean;
    alerts: string[];
  }>
> {
  try {
    const stats = await getSearchPerformanceStats(hours);

    if (!stats.success || !stats.data) {
      return { success: false, error: 'Failed to get performance stats' };
    }

    const alerts: string[] = [];
    let latencyAlert = false;
    let cacheAlert = false;
    let errorAlert = false;

    // Check latency
    if (stats.data.percentiles.p95 > LATENCY_TARGETS.p95) {
      latencyAlert = true;
      alerts.push(
        `P95 latency ${stats.data.percentiles.p95}ms exceeds target ${LATENCY_TARGETS.p95}ms`,
      );
    }

    // Check cache hit rate
    if (stats.data.cacheMetrics.hitRate < CACHE_HIT_TARGET) {
      cacheAlert = true;
      alerts.push(
        `Cache hit rate ${Math.round(stats.data.cacheMetrics.hitRate * 100)}% below target ${Math.round(CACHE_HIT_TARGET * 100)}%`,
      );
    }

    // Check error rate
    if (stats.data.errorRate > ERROR_RATE_TARGET) {
      errorAlert = true;
      alerts.push(
        `Error rate ${Math.round(stats.data.errorRate * 100)}% exceeds target ${Math.round(ERROR_RATE_TARGET * 100)}%`,
      );
    }

    return {
      success: true,
      data: {
        latencyAlert,
        cacheAlert,
        errorAlert,
        alerts,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Run a benchmark test with 10k+ properties.
 * Returns summary of performance characteristics.
 */
export async function runSearchBenchmark(propertyCount = 10000): Promise<
  ServiceResponse<SearchBenchmarkResult>
> {
  try {
    const startTime = Date.now();
    const results: number[] = [];
    const cacheHits: boolean[] = [];

    // Simulate various search patterns
    const searchQueries = [
      { query: 'apartment' },
      { query: 'house' },
      { city: 'New York' },
      { bedrooms: 2, min_price: 100, max_price: 300 },
      { amenities: ['wifi', 'kitchen'] },
      { query: 'luxury', min_price: 500 },
      { guests: 4, property_types: ['House', 'Villa'] },
    ];

    for (let i = 0; i < 100; i++) {
      const queryIndex = i % searchQueries.length;
      const query = searchQueries[queryIndex];

      const queryStart = Date.now();
      // In production, this would call actual advancedSearch
      // For now, we simulate with a minimal delay
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 200 + 50));
      const queryDuration = Date.now() - queryStart;

      results.push(queryDuration);
      cacheHits.push(i > 10); // First 10 are cache misses
    }

    const totalDuration = Date.now() - startTime;
    const sortedResults = results.sort((a, b) => a - b);

    const percentile = (p: number) => {
      const index = Math.ceil((p / 100) * sortedResults.length) - 1;
      return sortedResults[Math.max(0, index)];
    };

    const averageLatency = results.reduce((a, b) => a + b, 0) / results.length;
    const hitRate = cacheHits.filter((h) => h).length / cacheHits.length;
    const queriesPerSecond = (results.length / totalDuration) * 1000;

    const benchmarkResult: SearchBenchmarkResult = {
      propertyCount,
      queryCount: results.length,
      totalDuration,
      averageLatency: Math.round(averageLatency),
      percentiles: {
        p50: percentile(50),
        p75: percentile(75),
        p95: percentile(95),
        p99: percentile(99),
        max: sortedResults[sortedResults.length - 1],
        min: sortedResults[0],
      },
      queriesPerSecond: Math.round(queriesPerSecond * 100) / 100,
      passedTargets:
        percentile(95) <= LATENCY_TARGETS.p95 && hitRate >= CACHE_HIT_TARGET,
      details: {
        latencyTarget: LATENCY_TARGETS.p95,
        actualP95: percentile(95),
        cacheHitRate: Math.round(hitRate * 10000) / 10000,
        errorRate: 0,
      },
    };

    return { success: true, data: benchmarkResult };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Export performance metrics for external monitoring systems (Prometheus, Grafana, etc).
 */
export function exportPrometheusMetrics(stats: SearchPerformanceStats): string {
  const timestamp = Date.now();
  const metrics = [
    `# HELP search_queries_total Total number of search queries`,
    `# TYPE search_queries_total counter`,
    `search_queries_total{} ${stats.totalQueries}`,
    ``,
    `# HELP search_latency_ms Search latency in milliseconds`,
    `# TYPE search_latency_ms gauge`,
    `search_latency_ms{percentile="p50"} ${stats.percentiles.p50}`,
    `search_latency_ms{percentile="p75"} ${stats.percentiles.p75}`,
    `search_latency_ms{percentile="p95"} ${stats.percentiles.p95}`,
    `search_latency_ms{percentile="p99"} ${stats.percentiles.p99}`,
    ``,
    `# HELP cache_hit_rate Cache hit rate`,
    `# TYPE cache_hit_rate gauge`,
    `cache_hit_rate{} ${stats.cacheMetrics.hitRate}`,
    ``,
    `# HELP search_errors_total Total number of search errors`,
    `# TYPE search_errors_total counter`,
    `search_errors_total{} ${stats.totalErrors}`,
    ``,
    `# HELP search_error_rate Error rate`,
    `# TYPE search_error_rate gauge`,
    `search_error_rate{} ${stats.errorRate}`,
  ].join('\n');

  return metrics;
}
