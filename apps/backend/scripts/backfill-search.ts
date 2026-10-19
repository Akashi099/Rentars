/**
 * Backfills search data (search_vector, location) for existing properties (#747).
 *
 * Calls backfill_search_batch() in a loop. Each call commits its own batch, so the
 * script can be stopped and re-run at any point and it resumes where the remaining
 * rows are. Rows locked by a live write are skipped by the database and picked up
 * on a later pass.
 *
 * Usage (from apps/backend):
 *   bun run scripts/backfill-search.ts --dry-run
 *   bun run scripts/backfill-search.ts --batch-size 500 --sleep-ms 200
 *
 * Flags:
 *   --dry-run          Print how many rows still need search data, then exit.
 *   --batch-size <n>   Rows per batch (default 500, max 5000).
 *   --sleep-ms <n>     Pause between batches to limit load on the primary (default 200).
 *   --max-batches <n>  Safety cap for one run (default 10000).
 */

import { supabase } from '../src/config/supabase.js';

interface Options {
  dryRun: boolean;
  batchSize: number;
  sleepMs: number;
  maxBatches: number;
}

function parseOptions(argv: string[]): Options {
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${flag} must be a positive integer`);
    }
    return value;
  };

  const batchSize = read('--batch-size', 500);
  if (batchSize > 5000) throw new Error('--batch-size must be at most 5000');

  return {
    dryRun: argv.includes('--dry-run'),
    batchSize,
    sleepMs: read('--sleep-ms', 200),
    maxBatches: read('--max-batches', 10_000),
  };
}

/** Rows that still need search data. Mirrors the predicate inside backfill_search_batch(). */
async function countRemaining(): Promise<number> {
  const { count, error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .or('search_vector.is.null,and(location.is.null,latitude.not.is.null,longitude.not.is.null)');

  if (error) throw new Error(`Failed to count remaining rows: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const remaining = await countRemaining();
  console.log(`[backfill-search] ${remaining} row(s) need search data`);

  if (options.dryRun || remaining === 0) return;

  let processed = 0;
  for (let batch = 1; batch <= options.maxBatches; batch++) {
    const { data, error } = await supabase.rpc('backfill_search_batch', {
      p_batch_size: options.batchSize,
    });

    if (error) {
      // Progress is committed batch by batch, so a re-run resumes from here.
      throw new Error(`backfill_search_batch failed on batch ${batch}: ${error.message}`);
    }

    const touched = Number(data ?? 0);
    if (touched === 0) {
      console.log(
        `[backfill-search] complete: ${processed} row(s) processed in ${batch - 1} batch(es)`
      );
      return;
    }

    processed += touched;
    console.log(`[backfill-search] batch ${batch}: ${touched} row(s), ${processed} total`);
    await new Promise((resolve) => setTimeout(resolve, options.sleepMs));
  }

  const left = await countRemaining();
  throw new Error(
    `Stopped after ${options.maxBatches} batch(es) with ${left} row(s) remaining. Re-run to continue.`
  );
}

main().catch((err: unknown) => {
  console.error(`[backfill-search] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
