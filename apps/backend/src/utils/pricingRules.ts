/**
 * Pure pricing-rule logic for nightly rates (#926). No I/O, so every rule here is
 * unit-testable without a database.
 *
 * Precedence, applied to each night:
 *  1. Blocked special events, host blocks and reserving bookings make the night
 *     unavailable. Pricing does not apply to an unavailable night.
 *  2. At most one seasonal rule applies to a night. Creation rejects overlapping
 *     seasonal rules, so this is a safeguard for data written before that check.
 *     If overlapping rules exist anyway, the winner is the earliest start date,
 *     then the lowest id. The result is the same on every read.
 *  3. At most one priced special event applies to a night, under the same rule.
 *  4. The nightly rate is base × seasonal multiplier × event multiplier, rounded
 *     to cents once per night. Totals are sums of whole cents, so no floating-point
 *     drift accumulates across nights.
 *  5. A rate outside [MIN_NIGHTLY_PRICE, MAX_NIGHTLY_PRICE], or a multiplier
 *     outside [MIN_PRICE_MULTIPLIER, MAX_PRICE_MULTIPLIER], is out of policy. A
 *     quote for that stay is rejected. The rate is never silently clamped.
 */

export const MIN_PRICE_MULTIPLIER = 0.1;
export const MAX_PRICE_MULTIPLIER = 10;
export const MIN_NIGHTLY_PRICE = 1;
export const MAX_NIGHTLY_PRICE = 10_000;

/** A dated rule: a half-open [start_date, end_date) range with a multiplier. */
export interface DatedRule {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  price_multiplier?: number | null;
}

/** A rule that contributed to a night's price. Shown to hosts to explain a rate. */
export interface AppliedRule {
  kind: 'seasonal' | 'event';
  id: string;
  name: string;
  multiplier: number;
}

export function isValidMultiplier(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_PRICE_MULTIPLIER &&
    value <= MAX_PRICE_MULTIPLIER
  );
}

/** Parse a YYYY-MM-DD or ISO date. Returns null when the value is not a real date. */
export function parseRuleDate(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Stable ordering for rules: earliest start first, then id. */
export function sortRules<T extends DatedRule>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => {
    if (a.start_date !== b.start_date) return a.start_date < b.start_date ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The winning rule covering a night (YYYY-MM-DD), by the precedence above. */
export function ruleForNight<T extends DatedRule>(
  rules: readonly T[],
  night: string
): T | undefined {
  return sortRules(rules).find((r) => night >= r.start_date && night < r.end_date);
}

/** Whether two half-open date ranges share a night. */
export function datesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** The first existing rule that overlaps a candidate, or undefined if none does. */
export function findOverlappingRule<T extends DatedRule>(
  candidate: { start_date: string; end_date: string },
  existing: readonly T[]
): T | undefined {
  return sortRules(existing).find((r) =>
    datesOverlap(candidate.start_date, candidate.end_date, r.start_date, r.end_date)
  );
}

/** Whole cents for a dollar amount, rounded half away from zero. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Nightly price in cents for a base rate and the multipliers that apply.
 * Returns null when the base rate or a multiplier is not a finite number.
 */
export function nightlyPriceCents(baseRate: number, multipliers: readonly number[]): number | null {
  if (!Number.isFinite(baseRate) || multipliers.some((m) => !Number.isFinite(m))) return null;
  return toCents(baseRate * multipliers.reduce((acc, m) => acc * m, 1));
}

/** Whether a nightly price in cents is outside the allowed range. */
export function isNightlyPriceOutOfPolicy(priceCents: number | null): boolean {
  if (priceCents === null) return true;
  return priceCents < MIN_NIGHTLY_PRICE * 100 || priceCents > MAX_NIGHTLY_PRICE * 100;
}
