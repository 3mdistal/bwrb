import { release as osRelease } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  collectHealthRunHeader,
  createHealthReport,
  createHealthResult,
  HEALTH_REPORT_SCHEMA_VERSION,
  type HealthRunHeader,
} from '../../../src/lib/health-report.js';

const run: HealthRunHeader = {
  commit: 'abc123', packageVersion: '0.2.4', runtime: { node: 'v22.0.0', pnpm: '10.11.0' },
  platform: { os: 'darwin', release: 'node', arch: 'arm64' }, fixture: 'fixture-v1', retryMode: 'retry-zero',
  workerCount: 4, pty: 'available', rawArtifactPaths: ['artifacts/health/full-knip.json'],
};

describe('health report contract', () => {
  it('labels full Knip as canonical and production Knip as a limited entrypoint audit', () => {
    const full = createHealthResult({ check: 'full-knip', status: 'passed', classification: 'measured', attempts: 1 });
    const production = createHealthResult({ check: 'production-knip', status: 'passed', classification: 'measured', attempts: 1 });
    expect(full.label).toContain('canonical');
    expect(production.label).toContain('entrypoint audit');
    expect(production.knownExclusions).toEqual(expect.arrayContaining(['test roots', 'packaging roots', 'schema-generation roots']));
  });

  it('serializes all required run metadata and distinct result classifications', () => {
    const report = createHealthReport(run, [
      createHealthResult({ check: 'full-knip', status: 'passed', classification: 'measured', attempts: 1 }),
      createHealthResult({ check: 'test-feedback', status: 'passed', classification: 'retried', attempts: 2 }),
      createHealthResult({ check: 'pty-tests', status: 'not-run', classification: 'skipped', attempts: 0 }),
      createHealthResult({ check: 'test-retry-zero', status: 'failed', classification: 'contaminated', attempts: 1, contamination: 'shared CPU contention' }),
    ], '2026-07-12T00:00:00.000Z');
    expect(report).toMatchObject({ schemaVersion: HEALTH_REPORT_SCHEMA_VERSION, run, results: [
      { classification: 'measured' }, { classification: 'retried' }, { classification: 'skipped' }, { classification: 'contaminated' },
    ] });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('records the actual operating-system release in a collected header', async () => {
    const header = await collectHealthRunHeader({
      commit: 'abc123', pnpmVersion: '10.11.0', fixture: 'fixture-v1', retryMode: 'retry-zero',
      workerCount: 4, pty: 'available', rawArtifactPaths: [],
    });
    expect(header.platform.release).toBe(osRelease());
    expect(header.platform.release).not.toBe(process.release.name);
  });

  it('rejects labels that could turn a non-run or retry into a false claim', () => {
    expect(() => createHealthResult({ check: 'full-knip', status: 'not-run', classification: 'measured', attempts: 1 })).toThrow('Only unmeasured or skipped');
    expect(() => createHealthResult({ check: 'test-feedback', status: 'passed', classification: 'retried', attempts: 1 })).toThrow('at least two attempts');
    expect(() => createHealthResult({ check: 'test-retry-zero', status: 'failed', classification: 'contaminated', attempts: 1 })).toThrow('must name the contamination');
  });
});
