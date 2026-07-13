import { describe, expect, it } from 'vitest';
import { launchPreparedInParallel, summarizeTimings, validatePerformanceContractReport } from '../../tools/bench/performance-contract.js';

describe('performance contract harness', () => {
  it('summarizes measured timings without treating absent phases as zero', () => {
    expect(summarizeTimings([null, 40, 10, 20])).toEqual({ median: 20, p95: 40, min: 10, max: 40 });
    expect(summarizeTimings([null, null])).toBeNull();
  });

  it('accepts only the durable report shape expected by artifact consumers', () => {
    const report = {
      format: 1, commit: 'ce0b4b0', executable: { node: '/node', nodeVersion: 'v22.0.0', cli: '/cli/dist/index.js', mode: 'built' },
      fixtures: [{ noteCount: 5_000 }, { noteCount: 10_000 }], scenarios: Array.from({ length: 6 }, () => ({})),
      parallel: { processes: 4 }, rawJsonl: '/raw.jsonl',
      phaseInstrumentation: 'unavailable: production command instrumentation does not expose startup/schema/discovery/etc phase boundaries',
    };
    expect(validatePerformanceContractReport(report)).toBe(true);
    expect(validatePerformanceContractReport({ ...report, scenarios: [] })).toBe(false);
    expect(validatePerformanceContractReport({ ...report, executable: { ...report.executable, cli: 'relative' } })).toBe(false);
  });

  it('starts every prepared child before awaiting a close and excludes preparation delay', async () => {
    const launches: number[] = [];
    const releases: Array<() => void> = [];
    let clock = 1_000_000_000n;
    const prepared = ['one', 'two', 'three', 'four'];
    const group = launchPreparedInParallel(prepared, item => {
      launches.push(prepared.indexOf(item));
      return new Promise<string>(resolve => releases.push(() => resolve(item)));
    }, () => clock);
    expect(launches).toEqual([0, 1, 2, 3]);
    clock += 5_000_000n; // Simulated post-launch work is the only measured delay.
    releases.forEach(release => release());
    await expect(group).resolves.toMatchObject({ totalMs: 5, results: prepared });
  });
});
