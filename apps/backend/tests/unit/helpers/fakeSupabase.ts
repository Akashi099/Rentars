/**
 * In-memory stand-in for the subset of the supabase-js query builder used by the
 * listing, booking and pricing services. It applies filters to real row arrays,
 * so tests assert on behaviour (which rows matched, what was written) rather
 * than on a chain of mock return values.
 *
 * Supported: select, insert, update, eq, neq, is, in, gt, gte, lt, lte, not
 * (eq/is), limit, single, maybeSingle. Anything else throws, so an unsupported
 * call fails loudly instead of silently returning nothing.
 */

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

export interface FakeSupabase {
  from: (table: string) => unknown;
  tables: Record<string, Row[]>;
  /** Every query issued, in order, for asserting on what was requested. */
  log: Array<{ table: string; op: string; filters: string[] }>;
}

export function createFakeSupabase(initial: Record<string, Row[]> = {}): FakeSupabase {
  const tables: Record<string, Row[]> = { ...initial };
  const log: FakeSupabase['log'] = [];

  const cmp = (a: unknown, b: unknown) => {
    if (a === null || a === undefined) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    const predicates: Predicate[] = [];
    const described: string[] = [];
    let limitTo: number | undefined;

    const add = (desc: string, p: Predicate) => {
      described.push(desc);
      predicates.push(p);
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert(values: Row | Row[]) {
        op = 'insert';
        payload = Array.isArray(values) ? values[0] : values;
        return builder;
      },
      update(values: Row) {
        op = 'update';
        payload = values;
        return builder;
      },
      eq(col: string, value: unknown) {
        add(`${col}=${String(value)}`, (r) => r[col] === value);
        return builder;
      },
      neq(col: string, value: unknown) {
        add(`${col}!=${String(value)}`, (r) => r[col] !== value);
        return builder;
      },
      is(col: string, value: null) {
        add(`${col} is ${value}`, (r) => (r[col] ?? null) === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        add(`${col} in [${values.join(',')}]`, (r) => values.includes(r[col]));
        return builder;
      },
      gt(col: string, value: unknown) {
        add(`${col}>${String(value)}`, (r) => cmp(r[col], value) === 1);
        return builder;
      },
      gte(col: string, value: unknown) {
        add(`${col}>=${String(value)}`, (r) => {
          const c = cmp(r[col], value);
          return c !== null && c >= 0;
        });
        return builder;
      },
      lt(col: string, value: unknown) {
        add(`${col}<${String(value)}`, (r) => cmp(r[col], value) === -1);
        return builder;
      },
      lte(col: string, value: unknown) {
        add(`${col}<=${String(value)}`, (r) => {
          const c = cmp(r[col], value);
          return c !== null && c <= 0;
        });
        return builder;
      },
      not(col: string, operator: string, value: unknown) {
        if (operator === 'eq') {
          add(`${col} not eq ${String(value)}`, (r) => r[col] !== value);
        } else if (operator === 'is') {
          add(`${col} not is ${value}`, (r) => (r[col] ?? null) !== value);
        } else {
          throw new Error(`fakeSupabase: unsupported not(${operator})`);
        }
        return builder;
      },
      // Supports the comma-separated `col.is.null`, `col.eq.v`, `col.neq.v` terms.
      or(expr: string) {
        const terms = expr.split(',').map((t) => {
          const [col, op, ...rest] = t.split('.');
          const value = rest.join('.');
          if (op === 'is' && value === 'null') return (r: Row) => (r[col] ?? null) === null;
          if (op === 'eq') return (r: Row) => String(r[col]) === value;
          if (op === 'neq') return (r: Row) => String(r[col]) !== value;
          throw new Error(`fakeSupabase: unsupported or() term "${t}"`);
        });
        add(`or(${expr})`, (r) => terms.some((p) => p(r)));
        return builder;
      },
      limit(n: number) {
        limitTo = n;
        return builder;
      },
      // Both return one row (or null), matching supabase-js semantics.
      single: () => run(true),
      maybeSingle: () => run(true),
      // biome-ignore lint/suspicious/noThenProperty: supabase-js builders are awaitable; the fake mirrors that.
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return run(false).then(resolve, reject);
      },
    };

    const matched = () => rows.filter((r) => predicates.every((p) => p(r)));

    function run(single: boolean): Promise<{ data: unknown; error: null }> {
      log.push({ table, op, filters: [...described] });

      if (op === 'insert') {
        const row = { ...payload };
        rows.push(row);
        return Promise.resolve({ data: single ? row : [row], error: null });
      }

      if (op === 'update') {
        const hit = matched();
        for (const r of hit) Object.assign(r, payload);
        const out = hit.map((r) => ({ ...r }));
        return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null });
      }

      let hit = matched();
      if (limitTo !== undefined) hit = hit.slice(0, limitTo);
      const out = hit.map((r) => ({ ...r }));
      return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null });
    }

    return builder;
  }

  return { from, tables, log };
}

const FAKE_KEY = '__rentarsFakeSupabase';

/**
 * Install the fake that the module-level supabase mock delegates to.
 *
 * bun caches module instances across test files in one process, so a mock that
 * closes over one file's local variable would keep pointing at the first file's
 * fake. Going through a global means every file's mock reads the current one.
 */
export function useFakeSupabase(fake: FakeSupabase): void {
  (globalThis as Record<string, unknown>)[FAKE_KEY] = fake;
}

/** The fake installed by useFakeSupabase. Used inside mock.module factories. */
export function currentFakeSupabase(): FakeSupabase {
  const fake = (globalThis as Record<string, unknown>)[FAKE_KEY] as FakeSupabase | undefined;
  if (!fake) throw new Error('fakeSupabase: no fake installed; call useFakeSupabase first');
  return fake;
}
