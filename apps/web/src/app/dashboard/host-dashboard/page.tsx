'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useHostDashboard } from '@/hooks/useHostDashboard';
import DashboardSummaryCards from '@/components/dashboard/DashboardSummaryCards';
import HostPropertiesTable from '@/components/dashboard/HostPropertiesTable';
import {
  DashboardSummarySkeleton,
  EmptyState,
  ErrorState,
  SkeletonRegion,
  TableRowsSkeleton,
} from '@/components/ui';
import BookingStats from './components/BookingStats';
import EarningsSummary from './components/EarningsSummary';
import PaymentMethods from './components/PaymentMethods';
import PayoutHistory from './components/PayoutHistory';
import RecentTransactions from './components/RecentTransactions';
import AvailableBalance from './components/AvailableBalance';
import AddPropertyModal from './components/AddPropertyModal';
import EarningsTrendChart from './components/EarningsTrendChart';
import ComparativeGrowth from './components/ComparativeGrowth';
import OccupancyInsights from './components/OccupancyInsights';
import OccupancyHeatmap from './components/OccupancyHeatmap';
import ExportReportButton from './components/ExportReportButton';
import { mockHostData } from './mockData';

export default function HostDashboard() {
  const [showAddProperty, setShowAddProperty] = useState(false);
  const {
    summary,
    properties,
    isLoadingSummary,
    isLoadingProperties,
    summaryError,
    propertiesError,
    refetchSummary,
    refetchProperties,
    updatePropertyStatus,
  } = useHostDashboard();

  const handleAddProperty = () => {
    setShowAddProperty(false);
    // Refresh both after adding
    refetchSummary();
    refetchProperties();
  };

  // For heatmap we use real property ids only when the properties request
  // succeeded; while loading or after an error we fall back to mock data
  // rather than presenting stale/partial results as confirmed.
  const heatmapProperties =
    !propertiesError && properties.length > 0
      ? properties.map((p) => ({ id: p.id, title: p.title }))
      : mockHostData.properties.map((p) => ({ id: p.id, title: p.title }));

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 py-8">
      <div className="max-w-7xl mx-auto px-4 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Host Dashboard</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Manage your properties and earnings
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ExportReportButton
              monthlyMetrics={mockHostData.monthlyMetrics}
              payoutHistory={mockHostData.payoutHistory}
            />
            <button
              onClick={() => setShowAddProperty(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition"
            >
              <Plus size={20} aria-hidden="true" />
              Add Property
            </button>
          </div>
        </div>

        {/* ── Real API: Dashboard Summary ────────────────────────────────── */}
        {/* Loading / error / empty / success are four distinct states: the
            skeleton mirrors the real cards' dimensions (no layout shift),
            errors are announced and retry-safe, and "no data" is never
            reported as an error. */}
        {isLoadingSummary ? (
          <SkeletonRegion label="Loading dashboard summary" className="min-h-0">
            <DashboardSummarySkeleton />
          </SkeletonRegion>
        ) : summaryError ? (
          <ErrorState
            variant="inline"
            message={`Could not load dashboard summary: ${summaryError}`}
            onRetry={refetchSummary}
            retryLabel="Retry"
            retrying={isLoadingSummary}
          />
        ) : summary ? (
          <DashboardSummaryCards summary={summary} />
        ) : (
          <EmptyState
            title="No summary data yet"
            description="Once your property gets bookings, revenue and occupancy totals will appear here."
            action={
              <button
                type="button"
                onClick={refetchSummary}
                className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                Refresh
              </button>
            }
          />
        )}

        {/* Available Balance (kept from existing earnings flow). Only the
            confirmed summary value is shown; otherwise we fall back to the
            placeholder earnings figure rather than a stale API value. */}
        <AvailableBalance
          amount={
            !summaryError && summary
              ? summary.net_revenue
              : mockHostData.earningsStats.pendingPayout
          }
          onWithdraw={() => {}}
        />

        {/* Booking Stats — use real active count only on confirmed success */}
        <BookingStats
          activeBookings={
            !summaryError && summary
              ? summary.active_bookings
              : mockHostData.bookingStats.activeBookings
          }
          completedBookings={mockHostData.bookingStats.completedBookings}
          cancelledBookings={mockHostData.bookingStats.cancelledBookings}
          totalReviews={mockHostData.bookingStats.totalReviews}
        />

        {/* Earnings breakdown with period selector */}
        <EarningsSummary />

        {/* Analytics charts (keep mock for now — charting needs historical data) */}
        <EarningsTrendChart data={mockHostData.monthlyMetrics} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ComparativeGrowth metrics={mockHostData.monthlyMetrics} />
          <OccupancyInsights occupancy={mockHostData.occupancy} />
        </div>

        {/* Occupancy heatmap */}
        {heatmapProperties.length > 0 && (
          <OccupancyHeatmap properties={heatmapProperties} />
        )}

        {/* ── Real API: Properties Table ─────────────────────────────────── */}
        <section aria-labelledby="properties-heading">
          <div className="flex items-center justify-between mb-3">
            <h2
              id="properties-heading"
              className="text-lg font-semibold text-gray-900 dark:text-white"
            >
              Your Properties
            </h2>
            <Link
              href="/list"
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              List a new property →
            </Link>
          </div>

          {isLoadingProperties ? (
            <SkeletonRegion label="Loading your properties">
              <TableRowsSkeleton rows={3} />
            </SkeletonRegion>
          ) : propertiesError ? (
            <ErrorState
              variant="inline"
              message={propertiesError}
              onRetry={refetchProperties}
              retryLabel="Retry"
              retrying={isLoadingProperties}
            />
          ) : properties.length === 0 ? (
            <EmptyState
              title="No properties yet"
              description="Add your first property to start receiving bookings and tracking performance."
              action={
                <button
                  type="button"
                  onClick={() => setShowAddProperty(true)}
                  className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Add a property
                </button>
              }
            />
          ) : (
            <HostPropertiesTable
              properties={properties}
              onStatusChange={updatePropertyStatus}
            />
          )}
        </section>

        {/* Transactions and Payouts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <RecentTransactions transactions={mockHostData.recentTransactions} />
          <PayoutHistory payouts={mockHostData.payoutHistory} />
        </div>

        {/* Payment Methods */}
        <PaymentMethods onAddMethod={() => {}} />
      </div>

      <AddPropertyModal
        isOpen={showAddProperty}
        onClose={() => setShowAddProperty(false)}
        onSubmit={handleAddProperty}
      />
    </main>
  );
}
