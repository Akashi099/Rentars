'use client';

/**
 * Web Vitals reporting — sends Core Web Vitals to analytics endpoint.
 * 
 * Reports:
 * - LCP (Largest Contentful Paint)
 * - FID (First Input Delay) / INP (Interaction to Next Paint)
 * - CLS (Cumulative Layout Shift)
 * - TTFB (Time to First Byte)
 * 
 * Data is sampled at 10% by default to reduce backend load.
 */

import { onCLS, onFID, onLCP, onTTFB, onINP, type Metric } from 'web-vitals';

const SAMPLE_RATE = 0.1; // Report 10% of sessions
const API_ENDPOINT = '/api/v1/web-vitals';

function shouldReport(): boolean {
  return Math.random() < SAMPLE_RATE;
}

function sendToAnalytics(metric: Metric): void {
  if (!shouldReport()) return;

  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    path: window.location.pathname,
    timestamp: Date.now(),
  });

  // Use sendBeacon if available (survives page unload)
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon(API_ENDPOINT, blob);
  } else {
    // Fallback to fetch with keepalive
    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch((err) => {
      // Silent failure — don't break the app if analytics fail
      if (process.env.NODE_ENV === 'development') {
        console.warn('Failed to report Web Vitals:', err);
      }
    });
  }
}

export function reportWebVitals(): void {
  try {
    onCLS(sendToAnalytics);
    onFID(sendToAnalytics);
    onLCP(sendToAnalytics);
    onTTFB(sendToAnalytics);
    onINP(sendToAnalytics);
  } catch (err) {
    // Silent failure
    if (process.env.NODE_ENV === 'development') {
      console.warn('Failed to initialize Web Vitals reporting:', err);
    }
  }
}
