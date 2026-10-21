import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import {
  getHostLedgerBalance,
  recordBookingSettlement,
  type PeriodFilter,
} from './ledger.service.js';

const PLATFORM_FEE_RATE = 0.05;

export interface EarningsSummary {
  gross: number;
  platform_fees: number;
  net: number;
  pending: number;
  released: number;
}

export class EarningsService {
  async getHostEarnings(
    hostId: string,
    from: string,
    to: string,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!from || !to) return { success: false, error: 'from and to date range are required' };
    if (new Date(to) < new Date(from)) {
      return { success: false, error: 'to must be on or after from' };
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .not('status', 'eq', 'Cancelled')
      .gte('created_at', from)
      .lte('created_at', to);

    if (error) return { success: false, error: error.message };

    let gross = 0;
    let pending = 0;
    let released = 0;

    for (const row of (data ?? []) as Array<{ total_price: number; status: string }>) {
      const price = Number(row.total_price) || 0;
      gross += price;
      if (row.status === 'Confirmed' || row.status === 'Completed') {
        released += price;
      } else {
        pending += price;
      }
    }

    const platform_fees = Math.round(gross * PLATFORM_FEE_RATE * 100) / 100;
    const net = Math.round((gross - platform_fees) * 100) / 100;
    const releasedNet = Math.round(released * 0.95 * 100) / 100;
    const pendingNet = Math.round(pending * 0.95 * 100) / 100;

    return {
      success: true,
      data: {
        gross: Math.round(gross * 100) / 100,
        platform_fees,
        net,
        pending: pendingNet,
        released: releasedNet,
      },
    };
  }

  /**
   * Reconciled earnings — derives the host's balance from the append-only ledger
   * (#770).  This is the auditable view: every credit and debit is sourced from
   * a settlement event, not a mutable summary row.
   */
  async getReconciledEarnings(
    hostId: string,
    filter: PeriodFilter,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!filter.from || !filter.to) {
      return { success: false, error: 'from and to date range are required' };
    }

    // Derive balance from the ledger (credits − debits)
    const balanceResult = await getHostLedgerBalance(hostId, filter);
    if (!balanceResult.success || !balanceResult.data) {
      return { success: false, error: balanceResult.error };
    }

    const balance = balanceResult.data;

    // Fetch pending vs released from bookings table (for the pending/released split)
    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .not('status', 'eq', 'Cancelled')
      .gte('created_at', filter.from)
      .lte('created_at', filter.to);

    if (error) return { success: false, error: error.message };

    let pending = 0;
    let released = 0;

    for (const row of (data ?? []) as Array<{ total_price: number; status: string }>) {
      const price = Number(row.total_price) || 0;
      if (row.status === 'Confirmed' || row.status === 'Completed') {
        released += price;
      } else {
        pending += price;
      }
    }

    return {
      success: true,
      data: {
        gross: balance.total_credits,
        platform_fees: balance.total_debits,
        net: balance.net,
        pending: Math.round(pending * 0.95 * 100) / 100,
        released: Math.round(released * 0.95 * 100) / 100,
      },
    };
  }
}

// Re-export ledger helpers for convenience
export { recordBookingSettlement };
