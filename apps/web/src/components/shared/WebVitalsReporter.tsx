'use client';

/**
 * WebVitalsReporter — initializes Web Vitals monitoring on mount.
 * 
 * This component has no visual output and only runs on the client.
 */

import { useEffect } from 'react';
import { reportWebVitals } from '@/app/web-vitals';

export function WebVitalsReporter() {
  useEffect(() => {
    // Initialize Web Vitals reporting
    reportWebVitals();
  }, []);

  return null;
}
