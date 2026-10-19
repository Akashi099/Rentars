import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXIT_CODES,
  evaluate,
  evaluateMode,
  evaluateResume,
  parsePolicy,
  parseSnapshot,
} from './release-health-gate';

const policy = parsePolicy(
  JSON.parse(readFileSync(resolve(import.meta.dir, '../docs/releases/health-gates.json'), 'utf-8'))
);

const healthy = {
  error_rate: [0.01, 0.01],
  latency_p99_ms: [200, 300],
  transaction_failure_ratio: [0, 0.001],
  db_pool_usage_ratio: [0.4],
  redis_evictions_per_second: [0],
  contract_invocation_failure_ratio: [0, 0],
};

function withMetric(name: string, values: number[]) {
  return { ...healthy, [name]: values };
}

// Five windows (the longest recovery rule in the policy) at or below every
// recovery threshold.
const recovered = {
  error_rate: [0.01, 0.01, 0.01, 0.01, 0.01],
  latency_p99_ms: [300, 300, 300, 300, 300],
  transaction_failure_ratio: [0, 0, 0, 0, 0],
  db_pool_usage_ratio: [0.5, 0.5, 0.5, 0.5, 0.5],
  redis_evictions_per_second: [0, 0, 0, 0, 0],
  contract_invocation_failure_ratio: [0, 0, 0, 0, 0],
};

describe('release health gate: evaluate', () => {
  it('proceeds when every gate is within threshold', () => {
    const result = evaluate(policy, healthy);
    expect(result.decision).toBe('proceed');
    expect(result.gates.every((g) => g.status === 'ok')).toBe(true);
  });

  it('pauses when the error rate breaches for two consecutive windows', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.01, 0.06, 0.08]));
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('breached');
  });

  it('does not breach a two-window gate on a single high window', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.09, 0.01]));
    expect(result.decision).toBe('proceed');
  });

  it('rolls back when transaction failures breach', () => {
    const result = evaluate(policy, withMetric('transaction_failure_ratio', [0.03, 0.04]));
    expect(result.decision).toBe('rollback');
  });

  it('rolls back in preference to pausing when both kinds breach', () => {
    const result = evaluate(policy, {
      ...withMetric('error_rate', [0.2, 0.2]),
      ...{ contract_invocation_failure_ratio: [0.5, 0.5] },
    });
    expect(result.decision).toBe('rollback');
  });

  it('fails closed to pause when a gate has no data', () => {
    const { error_rate: _omitted, ...withoutErrorRate } = healthy;
    const result = evaluate(policy, withoutErrorRate);
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('insufficient_data');
  });

  it('fails closed to pause when a gate has fewer windows than required', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.01]));
    expect(result.decision).toBe('pause');
  });

  it('pauses on pool exhaustion after a single window', () => {
    const result = evaluate(policy, withMetric('db_pool_usage_ratio', [0.95]));
    expect(result.decision).toBe('pause');
  });
});

describe('release health gate: resume', () => {
  it('allows resume once every recovery rule has held for its windows', () => {
    const result = evaluateResume(policy, recovered);
    expect(result.decision).toBe('proceed');
  });

  it('keeps a paused rollout paused while recovery is incomplete', () => {
    const result = evaluateResume(policy, {
      ...recovered,
      error_rate: [0.01, 0.01, 0.03, 0.01, 0.01],
    });
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('recovering');
  });

  it('holds when there are fewer recovery windows than the policy requires', () => {
    const result = evaluateResume(policy, { ...recovered, error_rate: [0.01, 0.01] });
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('recovering');
  });

  it('never resumes while a rollback gate is breached', () => {
    const result = evaluateResume(policy, {
      ...recovered,
      transaction_failure_ratio: [0.05, 0.05, 0.05, 0.05, 0.05],
    });
    expect(result.decision).toBe('rollback');
  });

  it('dispatches on mode', () => {
    expect(evaluateMode(policy, recovered, 'resume').decision).toBe('proceed');
    expect(evaluateMode(policy, recovered, 'evaluate').decision).toBe('proceed');
    expect(
      evaluateMode(policy, { ...recovered, error_rate: [0.01, 0.01, 0.01, 0.01, 0.2] }, 'resume')
        .decision
    ).toBe('pause');
  });
});

describe('release health gate: exit codes', () => {
  it('maps decisions to the documented exit codes', () => {
    expect(EXIT_CODES).toEqual({ proceed: 0, pause: 10, rollback: 20 });
  });
});

describe('release health gate: input validation', () => {
  it('rejects a policy without gates', () => {
    expect(() => parsePolicy({ policy_version: '1' })).toThrow('gates array');
  });

  it('rejects an unknown action', () => {
    const bad = {
      policy_version: '1',
      gates: [{ name: 'x', threshold: 1, consecutive_windows: 1, action: 'page', recovery: null }],
    };
    expect(() => parsePolicy(bad)).toThrow('action must be');
  });

  it('rejects a snapshot with non-numeric samples', () => {
    expect(() => parseSnapshot({ error_rate: [0.01, 'high'] })).toThrow('finite numbers');
  });

  it('rejects a snapshot that is not an object', () => {
    expect(() => parseSnapshot([0.01])).toThrow('JSON object');
  });

  it('ships a policy whose gates cover every documented metric', () => {
    const names = policy.gates.map((g) => g.name).sort();
    expect(names).toEqual([
      'contract_invocation_failure_ratio',
      'db_pool_usage_ratio',
      'error_rate',
      'latency_p99_ms',
      'redis_evictions_per_second',
      'transaction_failure_ratio',
    ]);
  });
});
