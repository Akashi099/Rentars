'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface AnalyticsProps {
  data?: Array<{
    month: string;
    spent: number;
  }>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export default function Analytics({ data, loading = false, error = null, onRetry }: AnalyticsProps) {
  const hasData = Array.isArray(data) && data.length > 0;

  const renderBody = () => {
    if (loading) {
      return (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex flex-col items-center justify-center h-[300px] gap-3"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" aria-hidden="true" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading spending analytics…</span>
        </div>
      );
    }

    if (error) {
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center justify-center h-[300px] gap-3 text-center px-4"
        >
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            Failed to load spending analytics.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Retry
            </button>
          )}
        </div>
      );
    }

    if (!hasData) {
      return (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center justify-center h-[300px] gap-2 text-center px-4"
        >
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">No spending data yet</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Once you complete bookings, your monthly spending will appear here.
          </p>
        </div>
      );
    }

    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="spent" fill="#3b82f6" name="USDC Spent" />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Spending Analytics</h3>
      {renderBody()}
    </div>
  );
}