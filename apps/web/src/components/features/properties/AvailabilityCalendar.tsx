'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Trash2, Plus, X } from 'lucide-react';

interface AvailabilityRange {
  id: string;
  start_date: string;
  end_date: string;
  reason?: string;
}

interface AvailabilityCalendarProps {
  propertyId: string;
  onClose?: () => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Zero-pad a number to two digits. */
const pad = (n: number) => String(n).padStart(2, '0');

/** Build an ISO date string from year / month (1-based) / day. */
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * AvailabilityCalendar lets hosts block date ranges on their properties.
 * Blocked ranges are highlighted and prevent tenant booking.
 */
export default function AvailabilityCalendar({ propertyId, onClose }: AvailabilityCalendarProps) {
  const [ranges, setRanges] = useState<AvailabilityRange[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Mini-calendar navigation — hosts can browse months to check blocked dates.
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth() + 1); // 1-based

  const today = new Date().toISOString().split('T')[0];

  // Live region for mini-calendar month-change announcements.
  const announceRef = useRef<HTMLDivElement>(null);

  const announce = useCallback((message: string) => {
    if (!announceRef.current) return;
    announceRef.current.textContent = '';
    requestAnimationFrame(() => {
      if (announceRef.current) announceRef.current.textContent = message;
    });
  }, []);

  // ── Data fetching ────────────────────────────────────────────────────────────
  const fetchRanges = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/v1/properties/${propertyId}/availability`);
    if (res.ok) setRanges(await res.json());
  }, [propertyId]);

  useEffect(() => { fetchRanges(); }, [fetchRanges]);

  // ── Blocked-date set (recomputed from ranges) ────────────────────────────────
  const blockedDates = new Set<string>();
  for (const range of ranges) {
    const start = new Date(range.start_date);
    const end = new Date(range.end_date);
    // Step in UTC days to match the UTC date keys below. Local setDate can shift a
    // blocked night in zones away from UTC, and DST changes can skip or repeat one.
    for (const d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      blockedDates.add(d.toISOString().split('T')[0]);
    }
  }

  // ── Month navigation ─────────────────────────────────────────────────────────
  const goToPrevMonth = () => {
    setCalYear((y) => (calMonth === 1 ? y - 1 : y));
    setCalMonth((m) => (m === 1 ? 12 : m - 1));
  };

  const goToNextMonth = () => {
    setCalYear((y) => (calMonth === 12 ? y + 1 : y));
    setCalMonth((m) => (m === 12 ? 1 : m + 1));
  };

  const monthLabel = new Date(calYear, calMonth - 1).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });

  useEffect(() => {
    announce(`Showing ${monthLabel}`);
  }, [calYear, calMonth, announce, monthLabel]);

  // ── Keyboard navigation for the mini-calendar grid ───────────────────────────
  // The mini-calendar is display-only (hosts use the form inputs to block dates),
  // so only PageUp/PageDown month navigation is needed here.
  const handleCalendarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'PageUp') { e.preventDefault(); goToPrevMonth(); }
    if (e.key === 'PageDown') { e.preventDefault(); goToNextMonth(); }
  };

  // ── Form handlers ────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    setError('');
    if (!startDate || !endDate) { setError('Both dates are required'); return; }
    if (startDate >= endDate) { setError('Start date must be before end date'); return; }

    setLoading(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const res = await fetch(`${API_URL}/api/v1/properties/${propertyId}/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ start_date: startDate, end_date: endDate, reason }),
    });
    setLoading(false);

    if (!res.ok) {
      const body = await res.json();
      setError(body.error || 'Failed to block dates');
      return;
    }

    setStartDate(''); setEndDate(''); setReason('');
    fetchRanges();
  };

  const handleDelete = async (rangeId: string) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    await fetch(`${API_URL}/api/v1/properties/${propertyId}/availability/${rangeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    fetchRanges();
  };

  // ── Mini-calendar layout ─────────────────────────────────────────────────────
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const firstDay = new Date(calYear, calMonth - 1, 1).getDay(); // 0 = Sunday
  const daysOfWeek = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  // Build week rows: leading null cells + day entries.
  type CellEntry = { dateStr: string; day: number } | null;
  const cells: CellEntry[] = [
    ...Array<CellEntry>(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({
      day: i + 1,
      dateStr: toISO(calYear, calMonth, i + 1),
    })),
  ];
  const weeks: CellEntry[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7).concat(Array(7 - cells.slice(i, i + 7).length).fill(null)));
  }

  const calHeadingId = `avail-cal-heading-${propertyId}`;

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-6 space-y-6">
      {/* Hidden live region */}
      <div ref={announceRef} aria-live="polite" aria-atomic="true" className="sr-only" />

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Calendar size={20} aria-hidden="true" />
          Availability Calendar
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close availability calendar"
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={20} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* ── Mini calendar ─────────────────────────────────────────────────── */}
      <section aria-label={`Blocked dates calendar — ${monthLabel}`}>
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={goToPrevMonth}
            aria-label="Previous month"
            className="p-1 rounded hover:bg-gray-100 transition"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <p
            id={calHeadingId}
            className="font-medium text-sm text-gray-700"
          >
            {monthLabel}
          </p>
          <button
            onClick={goToNextMonth}
            aria-label="Next month"
            className="p-1 rounded hover:bg-gray-100 transition"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Calendar grid — display-only, PageUp/Down to navigate months */}
        <div
          role="grid"
          aria-labelledby={calHeadingId}
          aria-readonly="true"
          onKeyDown={handleCalendarKeyDown}
          tabIndex={0}
          aria-label={`${monthLabel} blocked dates — use Page Up/Down to change months`}
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 rounded"
        >
          {/* Column headers */}
          <div role="row" className="grid grid-cols-7 gap-1 text-xs text-center">
            {daysOfWeek.map((d) => (
              <div
                key={d}
                role="columnheader"
                aria-label={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][daysOfWeek.indexOf(d)]}
                className="font-semibold text-gray-500 py-1"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Week rows */}
          {weeks.map((week, wi) => (
            <div key={wi} role="row" className="grid grid-cols-7 gap-1 text-xs text-center">
              {week.map((cell, ci) => {
                if (!cell) {
                  return (
                    <div
                      key={`e-${wi}-${ci}`}
                      role="gridcell"
                      aria-hidden="true"
                      className="py-1"
                    />
                  );
                }

                const { dateStr, day } = cell;
                const isBlocked = blockedDates.has(dateStr);
                const isPast = dateStr < today;

                const dateLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('default', {
                  weekday: 'long', month: 'long', day: 'numeric',
                });
                const statusLabel = isBlocked
                  ? `${dateLabel}, blocked`
                  : isPast
                  ? `${dateLabel}, past`
                  : `${dateLabel}, available`;

                return (
                  <div
                    key={dateStr}
                    role="gridcell"
                    aria-label={statusLabel}
                    aria-disabled={isPast}
                    className={[
                      'py-1 rounded text-xs',
                      isBlocked
                        ? 'bg-red-200 text-red-700 font-semibold'
                        : isPast
                        ? 'text-gray-300'
                        : 'bg-gray-50 text-gray-700',
                    ].join(' ')}
                  >
                    {day}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
          <span className="w-3 h-3 rounded bg-red-200 inline-block" aria-hidden="true" />
          Blocked
        </div>
      </section>

      {/* ── Add range form ─────────────────────────────────────────────────── */}
      <section aria-label="Block a date range">
        <p className="font-medium text-sm text-gray-800 mb-3" id="block-range-label">
          Block a date range
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600 mb-1 block" htmlFor="avail-start">
                Start date
              </label>
              <input
                id="avail-start"
                type="date"
                min={today}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-describedby={error ? 'avail-error' : undefined}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600 mb-1 block" htmlFor="avail-end">
                End date
              </label>
              <input
                id="avail-end"
                type="date"
                min={startDate || today}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-describedby={error ? 'avail-error' : undefined}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-600 mb-1 block" htmlFor="avail-reason">
              Reason (optional)
            </label>
            <input
              id="avail-reason"
              type="text"
              placeholder="e.g. maintenance, personal use"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p id="avail-error" className="text-red-600 text-xs" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handleAdd}
            disabled={loading}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-2 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            <Plus size={16} aria-hidden="true" />
            {loading ? 'Blocking…' : 'Block dates'}
          </button>
        </div>
      </section>

      {/* ── Existing ranges ────────────────────────────────────────────────── */}
      {ranges.length > 0 && (
        <section aria-label="Blocked date ranges">
          <p className="font-medium text-sm text-gray-800 mb-2">Blocked ranges</p>
          <ul className="space-y-1">
            {ranges.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between bg-red-50 border border-red-100 rounded px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{r.start_date}</span>
                  {' → '}
                  <span className="font-medium">{r.end_date}</span>
                  {r.reason && (
                    <span className="text-gray-500 ml-2">({r.reason})</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(r.id)}
                  className="text-red-500 hover:text-red-700 ml-2 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 rounded"
                  aria-label={`Remove block from ${r.start_date} to ${r.end_date}`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
