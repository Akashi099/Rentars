/**
 * Database instrumentation for distributed tracing.
 *
 * Wraps Supabase queries to create child spans with query metadata.
 */

import { supabase } from '@/config/supabase.js';
import { startSpan, endSpan, addSpanAttribute, addSpanEvent, recordSpanError, SpanKind } from '@/config/tracing.js';

interface QueryOptions {
  table?: string;
  operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';
  query?: string;
  params?: unknown;
}

export async function tracedQuery<T>(
  operation: QueryOptions['operation'],
  table: string,
  fn: () => Promise<{ data: T | null; error: Error | null }>,
  options: Partial<QueryOptions> = {},
): Promise<{ data: T | null; error: Error | null }> {
  const span = startSpan(`db.${operation}`, SpanKind.CLIENT, {
    'db.system': 'postgresql',
    'db.operation': operation,
    'db.table': table,
    'db.statement': options.query ?? '',
  });

  addSpanEvent('db.query.start', { table, operation });

  try {
    const result = await fn();

    if (result.error) {
      span.attributes['db.error'] = result.error.message;
      span.status = { code: 'error', message: result.error.message };
      addSpanEvent('db.query.error', { error: result.error.message });
    } else {
      addSpanEvent('db.query.end', { rowCount: Array.isArray(result.data) ? result.data.length : 1 });
    }

    endSpan(span);
    return result;
  } catch (err) {
    recordSpanError(err instanceof Error ? err : new Error(String(err)));
    endSpan(span, { code: 'error', message: String(err) });
    throw err;
  }
}

export const tracedSupabase = {
  from: (table: string) => {
    const builder = supabase.from(table);

    const wrapMethod = (method: string) => {
      const original = builder[method].bind(builder);
      return async (...args: unknown[]) => {
        return tracedQuery(
          method as QueryOptions['operation'],
          table,
          () => original(...args),
          { table, operation: method as QueryOptions['operation'] },
        );
      };
    };

    return {
      ...builder,
      select: wrapMethod('select'),
      insert: wrapMethod('insert'),
      update: wrapMethod('update'),
      delete: wrapMethod('delete'),
      upsert: wrapMethod('upsert'),
    };
  },

  rpc: async (fnName: string, params?: unknown) => {
    return tracedQuery(
      'rpc',
      fnName,
      () => supabase.rpc(fnName, params),
      { table: fnName, operation: 'rpc', query: `rpc:${fnName}` },
    );
  },
};

export function addDbAttributes(attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    addSpanAttribute(`db.${key}`, value);
  }
}