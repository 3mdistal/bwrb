import { describe, expect, it } from 'vitest';
import { summarizeTimings, validatePerformanceContractReport } from '../../tools/bench/performance-contract.js';

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
});
