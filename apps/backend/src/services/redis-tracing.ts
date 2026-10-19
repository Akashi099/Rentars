/**
 * Redis instrumentation for distributed tracing.
 *
 * Wraps Redis client commands to create child spans.
 */

import { createClient, RedisClientType } from 'redis';
import { startSpan, endSpan, addSpanAttribute, addSpanEvent, recordSpanError, SpanKind } from '@/config/tracing.js';
import { env } from '@/config/env.js';

let redisClient: RedisClientType | null = null;

export function getRedisClient(): RedisClientType | null {
  return redisClient;
}

export async function initRedisTracing(): Promise<RedisClientType | null> {
  if (!env.REDIS_URL) return null;

  redisClient = createClient({ url: env.REDIS_URL });

  redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await redisClient.connect();

  return redisClient;
}

export async function closeRedisTracing(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

interface RedisCommandOptions {
  command: string;
  key?: string;
  args?: unknown[];
}

export async function tracedRedisCommand<T>(
  options: RedisCommandOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const span = startSpan(`redis.${options.command.toLowerCase()}`, SpanKind.CLIENT, {
    'db.system': 'redis',
    'db.operation': options.command,
    'db.redis.key': options.key ?? '',
  });

  if (options.args && options.args.length > 0) {
    span.attributes['db.redis.args_count'] = options.args.length;
  }

  addSpanEvent('redis.command.start', { command: options.command, key: options.key });

  try {
    const result = await fn();
    addSpanEvent('redis.command.end', { command: options.command });
    endSpan(span);
    return result;
  } catch (err) {
    recordSpanError(err instanceof Error ? err : new Error(String(err)));
    endSpan(span, { code: 'error', message: String(err) });
    throw err;
  }
}

export const tracedRedis = {
  get: (key: string) => tracedRedisCommand({ command: 'GET', key }, () => redisClient!.get(key)),
  set: (key: string, value: string, options?: { EX?: number; PX?: number }) =>
    tracedRedisCommand({ command: 'SET', key }, () => redisClient!.set(key, value, options)),
  del: (key: string) => tracedRedisCommand({ command: 'DEL', key }, () => redisClient!.del(key)),
  exists: (key: string) => tracedRedisCommand({ command: 'EXISTS', key }, () => redisClient!.exists(key)),
  expire: (key: string, seconds: number) =>
    tracedRedisCommand({ command: 'EXPIRE', key }, () => redisClient!.expire(key, seconds)),
  incr: (key: string) => tracedRedisCommand({ command: 'INCR', key }, () => redisClient!.incr(key)),
  decr: (key: string) => tracedRedisCommand({ command: 'DECR', key }, () => redisClient!.decr(key)),
  hget: (key: string, field: string) =>
    tracedRedisCommand({ command: 'HGET', key }, () => redisClient!.hGet(key, field)),
  hset: (key: string, field: string, value: string) =>
    tracedRedisCommand({ command: 'HSET', key }, () => redisClient!.hSet(key, field, value)),
  hgetall: (key: string) =>
    tracedRedisCommand({ command: 'HGETALL', key }, () => redisClient!.hGetAll(key)),
  sadd: (key: string, member: string) =>
    tracedRedisCommand({ command: 'SADD', key }, () => redisClient!.sAdd(key, member)),
  smembers: (key: string) =>
    tracedRedisCommand({ command: 'SMEMBERS', key }, () => redisClient!.sMembers(key)),
  zadd: (key: string, score: number, member: string) =>
    tracedRedisCommand({ command: 'ZADD', key }, () => redisClient!.zAdd(key, { score, value: member })),
  zrange: (key: string, start: number, stop: number) =>
    tracedRedisCommand({ command: 'ZRANGE', key }, () => redisClient!.zRange(key, start, stop)),
  eval: (script: string, numKeys: number, ...keys: string[]) =>
    tracedRedisCommand({ command: 'EVAL', key: keys.join(',') }, () => redisClient!.eval(script, { keys, arguments: [] })),
  ping: () => tracedRedisCommand({ command: 'PING' }, () => redisClient!.ping()),
};

export function addRedisAttributes(attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    addSpanAttribute(`redis.${key}`, value);
  }
}