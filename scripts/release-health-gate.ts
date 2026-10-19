#!/usr/bin/env bun
/**
 * Release health gate (#737).
 *
 * Evaluates a metrics snapshot against docs/releases/health-gates.json and
 * prints the rollout decision as JSON. The deployment pipeline acts on the exit
 * code:
 *
 *   0   proceed    every gate is within its threshold
 *   10  pause      a pause gate is breached, or a gate has too little data
 *   20  rollback   a rollback gate is breached
 *   1   error      invalid policy or snapshot
 *
 * Missing or short metric data pauses the rollout. The gate fails closed rather
 * than assuming health.
 *
 * Usage:
 *   bun run scripts/release-health-gate.ts --metrics <snapshot.json>
 *     [--policy <file>] [--mode evaluate|resume]
 *
 * Snapshot format: { "<gate name>": [value, ...] }, one value per one-minute
 * window, oldest first.
 *
 * --mode evaluate (default) answers "is this release healthy right now?".
 * --mode resume answers "may a paused rollout continue?". Every gate that has a
 * recovery rule must be at or below its recovery threshold for its recovery
 * windows, and no gate may be breached. The snapshot does not record which gate
 * paused the rollout, so the check applies to all of them.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type GateAction = 'pause' | 'rollback';
export type Decision = 'proceed' | 'pause' | 'rollback';
export type Mode = 'evaluate' | 'resume';

export interface Recovery {
  threshold: number;
  windows: number;
}

export interface Gate {
  name: string;
  threshold: number;
  consecutive_windows: number;
  action: GateAction;
  recovery: Recovery | null;
}

export interface Policy {
  policy_version: string;
  gates: Gate[];
}

export type Snapshot = Record<string, number[]>;

export type GateStatus = 'ok' | 'breached' | 'insufficient_data' | 'recovering';

export interface GateResult {
  name: string;
  action: GateAction;
  status: GateStatus;
  threshold: number;
  observed: number[];
}

export interface Evaluation {
  decision: Decision;
  gates: GateResult[];
}

export const EXIT_CODES: Record<Decision, number> = {
  proceed: 0,
  pause: 10,
  rollback: 20,
};

const ERROR_EXIT_CODE = 1;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePolicy(raw: unknown): Policy {
  if (!isRecord(raw) || typeof raw.policy_version !== 'string' || !Array.isArray(raw.gates)) {
    fail('policy must contain policy_version and a gates array');
  }

  const gates = raw.gates.map((entry, index): Gate => {
    if (!isRecord(entry)) fail(`gates[${index}] must be an object`);
    const { name, threshold, consecutive_windows, action, recovery } = entry;
    if (typeof name !== 'string' || name === '')
      fail(`gates[${index}].name must be a non-empty string`);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      fail(`gate ${String(name)} threshold must be a finite number`);
    }
    if (!Number.isInteger(consecutive_windows) || (consecutive_windows as number) < 1) {
      fail(`gate ${String(name)} consecutive_windows must be an integer >= 1`);
    }
    if (action !== 'pause' && action !== 'rollback') {
      fail(`gate ${String(name)} action must be "pause" or "rollback"`);
    }

    let parsedRecovery: Recovery | null = null;
    if (recovery !== null && recovery !== undefined) {
      if (
        !isRecord(recovery) ||
        typeof recovery.threshold !== 'number' ||
        !Number.isInteger(recovery.windows)
      ) {
        fail(`gate ${String(name)} recovery must have a numeric threshold and integer windows`);
      }
      parsedRecovery = {
        threshold: recovery.threshold as number,
        windows: recovery.windows as number,
      };
    }

    return {
      name: name as string,
      threshold,
      consecutive_windows: consecutive_windows as number,
      action,
      recovery: parsedRecovery,
    };
  });

  return { policy_version: raw.policy_version, gates };
}

export function parseSnapshot(raw: unknown): Snapshot {
  if (!isRecord(raw)) fail('metrics snapshot must be a JSON object keyed by gate name');

  const snapshot: Snapshot = {};
  for (const [name, values] of Object.entries(raw)) {
    if (
      !Array.isArray(values) ||
      !values.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      fail(`metric ${name} must be an array of finite numbers`);
    }
    snapshot[name] = values as number[];
  }
  return snapshot;
}

/**
 * Evaluates the rollout. A gate is breached when its most recent
 * `consecutive_windows` values are all above the threshold.
 */
export function evaluate(policy: Policy, snapshot: Snapshot): Evaluation {
  const gates = policy.gates.map((gate): GateResult => {
    const values = snapshot[gate.name] ?? [];
    if (values.length < gate.consecutive_windows) {
      return {
        name: gate.name,
        action: gate.action,
        status: 'insufficient_data',
        threshold: gate.threshold,
        observed: values,
      };
    }

    const observed = values.slice(-gate.consecutive_windows);
    const breached = observed.every((value) => value > gate.threshold);
    return {
      name: gate.name,
      action: gate.action,
      status: breached ? 'breached' : 'ok',
      threshold: gate.threshold,
      observed,
    };
  });

  return { decision: decide(gates), gates };
}

function decide(gates: GateResult[]): Decision {
  if (gates.some((g) => g.status === 'breached' && g.action === 'rollback')) return 'rollback';
  if (gates.some((g) => g.status !== 'ok')) return 'pause';
  return 'proceed';
}

/**
 * Decides whether a paused rollout may continue. Each gate with a recovery rule
 * needs its last `recovery.windows` values at or below `recovery.threshold`.
 * Gates without a recovery rule must be healthy in the current window. A gate
 * with too few windows is treated as still recovering.
 */
export function evaluateResume(policy: Policy, snapshot: Snapshot): Evaluation {
  const current = evaluate(policy, snapshot);
  const gates = current.gates.map((result): GateResult => {
    const gate = policy.gates.find((g) => g.name === result.name);
    if (!gate || result.status !== 'ok' || !gate.recovery) return result;

    const values = snapshot[gate.name] ?? [];
    const recent = values.slice(-gate.recovery.windows);
    const recovered =
      recent.length === gate.recovery.windows && recent.every((v) => v <= gate.recovery!.threshold);
    return recovered ? result : { ...result, status: 'recovering', observed: recent };
  });

  return { decision: decide(gates), gates };
}

export function evaluateMode(policy: Policy, snapshot: Snapshot, mode: Mode): Evaluation {
  return mode === 'resume' ? evaluateResume(policy, snapshot) : evaluate(policy, snapshot);
}

function parseArgs(argv: string[]): { metrics: string; policy: string; mode: Mode } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const metrics = value('--metrics');
  if (!metrics) fail('--metrics <snapshot.json> is required');

  const mode = value('--mode') ?? 'evaluate';
  if (mode !== 'evaluate' && mode !== 'resume') fail('--mode must be "evaluate" or "resume"');

  const defaultPolicy = resolve(import.meta.dir, '../docs/releases/health-gates.json');
  return { metrics, policy: value('--policy') ?? defaultPolicy, mode };
}

function main(): number {
  const { metrics, policy: policyPath, mode } = parseArgs(process.argv.slice(2));

  const policyText = readFileSync(policyPath, 'utf-8');
  const policy = parsePolicy(JSON.parse(policyText));
  const snapshot = parseSnapshot(JSON.parse(readFileSync(metrics, 'utf-8')));
  const result = evaluateMode(policy, snapshot, mode);

  const report = {
    mode,
    decision: result.decision,
    policy_version: policy.policy_version,
    policy_sha256: createHash('sha256').update(policyText).digest('hex'),
    evaluated_at: new Date().toISOString(),
    gates: result.gates,
  };
  console.log(JSON.stringify(report, null, 2));
  return EXIT_CODES[result.decision];
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`release-health-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(ERROR_EXIT_CODE);
  }
}
