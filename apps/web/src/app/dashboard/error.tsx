'use client';

import { ErrorContent } from '@/components/error/ErrorContent';

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  return <ErrorContent error={error} reset={reset} context="dashboard-error" />;
}
