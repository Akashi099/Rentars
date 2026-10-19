/**
 * Sort clauses for property search results (issue #749).
 *
 * Every clause list ends with the unique `id` column. Without it, listings that
 * share a price, rating or creation timestamp have no defined order, so
 * consecutive pages can repeat or skip items. Adding `id` makes the order total
 * and therefore stable across pages for unchanged data.
 */

export interface SearchOrderOptions {
  ascending: boolean;
  nullsFirst?: boolean;
}

export interface SearchOrderClause {
  column: string;
  options: SearchOrderOptions;
}

/**
 * Compare two rows by an ordered clause list, mirroring how Postgres orders
 * `ORDER BY`. A null value follows `nullsFirst` when set; otherwise it sorts
 * the way Postgres does by default (last for ascending, first for descending).
 * Used to model the database order for fixture-based pagination tests.
 */
export function compareSearchRows<T extends Record<string, unknown>>(
  a: T,
  b: T,
  clauses: readonly SearchOrderClause[]
): number {
  for (const { column, options } of clauses) {
    const av = a[column];
    const bv = b[column];
    if (av === bv) continue;

    const nullsFirst = options.nullsFirst ?? !options.ascending;
    if (av == null || bv == null) {
      const aIsNull = av == null;
      return aIsNull === nullsFirst ? -1 : 1;
    }

    const cmp = av < bv ? -1 : 1;
    return options.ascending ? cmp : -cmp;
  }
  return 0;
}

export function buildSearchOrderClauses(sortBy: string | undefined): SearchOrderClause[] {
  const clauses: SearchOrderClause[] = [];

  switch (sortBy) {
    case 'price_asc':
      clauses.push({ column: 'price_per_night', options: { ascending: true } });
      break;
    case 'price_desc':
      clauses.push({ column: 'price_per_night', options: { ascending: false } });
      break;
    case 'rating':
      clauses.push(
        { column: 'average_rating', options: { ascending: false, nullsFirst: false } },
        { column: 'review_count', options: { ascending: false, nullsFirst: false } }
      );
      break;
    default:
      clauses.push({ column: 'created_at', options: { ascending: false } });
      break;
  }

  clauses.push({ column: 'id', options: { ascending: true } });
  return clauses;
}
