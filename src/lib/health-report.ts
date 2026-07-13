import { execFile } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { promisify } from 'node:util';
import { BWRB_VERSION } from '../version.js';

const execFileAsync = promisify(execFile);

export const HEALTH_REPORT_SCHEMA_VERSION = 1;

export type HealthResultClassification =
  | 'measured'
  | 'inferred'
  | 'unmeasured'
  | 'skipped'
  | 'retried'
  | 'contaminated';

export type HealthCheckId =
  | 'full-knip'
  | 'production-knip'
  | 'test-feedback'
  | 'test-retry-zero'
  | 'pty-tests';

export interface HealthRunHeader {
  commit: string;
  packageVersion: string;
  runtime: { node: string; pnpm: string };
  platform: { os: NodeJS.Platform; release: string; arch: string };
  fixture: string;
  retryMode: string;
  workerCount: number | null;
  pty: 'available' | 'unavailable' | 'skipped' | 'not-applicable';
  rawArtifactPaths: string[];
}

export interface HealthResult {
  check: HealthCheckId;
  label: string;
  status: 'passed' | 'failed' | 'not-run';
  classification: HealthResultClassification;
  attempts: number;
  knownExclusions: string[];
  contamination?: string;
}

export interface HealthReport {
  schemaVersion: number;
  generatedAt: string;
  run: HealthRunHeader;
  results: HealthResult[];
}

const CHECKS: Record<HealthCheckId, Pick<HealthResult, 'label' | 'knownExclusions'>> = {
  'full-knip': {
    label: 'Full Knip unused-surface check (canonical)',
    knownExclusions: [],
  },
  'production-knip': {
    label: 'Production Knip entrypoint audit (not canonical unused-surface evidence)',
    knownExclusions: [
      'build roots',
      'docs-site roots',
      'schema-generation roots',
      'packaging roots',
      'test roots',
    ],
  },
  'test-feedback': {
    label: 'Retrying test feedback lane (not retry-zero reliability certification)',
    knownExclusions: [],
  },
  'test-retry-zero': {
    label: 'Retry-zero reliability lane',
    knownExclusions: [],
  },
  'pty-tests': {
    label: 'PTY test lane',
    knownExclusions: [],
  },
};

export function healthCheckIds(): HealthCheckId[] {
  return Object.keys(CHECKS) as HealthCheckId[];
}

export function isHealthCheckId(value: string): value is HealthCheckId {
  return value in CHECKS;
}

export function isHealthResultClassification(value: string): value is HealthResultClassification {
  return ['measured', 'inferred', 'unmeasured', 'skipped', 'retried', 'contaminated'].includes(value);
}

export function createHealthResult(input: Omit<HealthResult, 'label' | 'knownExclusions'>): HealthResult {
  const check = CHECKS[input.check];
  if (!check) throw new Error(`Unknown health check: ${input.check}`);
  const isNotRun = input.status === 'not-run';
  if (isNotRun !== (input.classification === 'unmeasured' || input.classification === 'skipped')) {
    throw new Error('Only unmeasured or skipped results may use status "not-run".');
  }
  if (input.classification === 'retried' && input.attempts < 2) {
    throw new Error('Retried results must record at least two attempts.');
  }
  if (input.classification === 'contaminated' && !input.contamination) {
    throw new Error('Contaminated results must name the contamination.');
  }
  return { ...input, ...check };
}

export async function collectHealthRunHeader(input: Omit<HealthRunHeader, 'commit' | 'packageVersion' | 'runtime' | 'platform'> & { cwd?: string; commit?: string; pnpmVersion?: string }): Promise<HealthRunHeader> {
  let commit = input.commit ?? process.env.GITHUB_SHA;
  if (!commit) {
    try {
      const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.cwd });
      commit = result.stdout.trim();
    } catch {
      commit = 'unknown';
    }
  }
  const pnpm = input.pnpmVersion ?? process.env.npm_config_user_agent?.match(/pnpm\/(\S+)/)?.[1] ?? 'unknown';
  return {
    commit,
    packageVersion: BWRB_VERSION,
    runtime: { node: process.version, pnpm },
    platform: { os: process.platform, release: osRelease(), arch: process.arch },
    fixture: input.fixture,
    retryMode: input.retryMode,
    workerCount: input.workerCount,
    pty: input.pty,
    rawArtifactPaths: input.rawArtifactPaths,
  };
}

export function createHealthReport(run: HealthRunHeader, results: HealthResult[], generatedAt = new Date().toISOString()): HealthReport {
  return { schemaVersion: HEALTH_REPORT_SCHEMA_VERSION, generatedAt, run, results };
}
