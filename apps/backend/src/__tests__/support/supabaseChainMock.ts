/**
 * Shared Supabase test double for listing lifecycle tests.
 *
 * Each table's rows are seeded per test through `tables`. Filters are ignored,
 * so a test seeds exactly the rows it wants the service to see. `single` and
 * `maybeSingle` return the first row, and awaiting a chain returns every row
 * with a count.
 */

import { vi } from 'vitest';

export const tables: Record<string, Array<Record<string, unknown>>> = {};

export function resetTables(): void {
  for (const key of Object.keys(tables)) delete tables[key];
}

function rowsFor(table: string): Array<Record<string, unknown>> {
  return tables[table] ?? [];
}

function chainFor(table: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const method of [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte',
    'is', 'in', 'not', 'or', 'order', 'limit', 'ilike', 'contains',
  ]) {
    chain[method] = vi.fn(passthrough);
  }
  chain.single = vi.fn(async () => ({ data: rowsFor(table)[0] ?? null, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: rowsFor(table)[0] ?? null, error: null }));
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: rowsFor(table), error: null, count: rowsFor(table).length }).then(resolve, reject);
  return chain;
}

export const supabaseMock = {
  from: (table: string) => chainFor(table),
  rpc: vi.fn(),
};
