export type VitestAssertionStatus = 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';

export interface VitestJsonAssertion {
  status: VitestAssertionStatus;
  retryCount?: number;
}

export interface VitestJsonTestFile {
  name: string;
  assertionResults?: VitestJsonAssertion[];
}

export interface VitestJsonResult {
  testResults: VitestJsonTestFile[];
}

export interface ReliabilityResultSummary {
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  retried: number;
  ptySupported: number;
  ptySkipped: number;
}

const emptySummary = (): ReliabilityResultSummary => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  pending: 0,
  retried: 0,
  ptySupported: 0,
  ptySkipped: 0,
});

/**
 * Summarize Vitest's JSON artifact without turning skipped PTY files into
 * supported coverage. A PTY assertion is supported only when it executes;
 * skipped/pending PTY assertions remain visible as skipped.
 */
export function summarizeReliabilityResults(result: VitestJsonResult): ReliabilityResultSummary {
  const summary = emptySummary();

  for (const file of result.testResults) {
    const isPty = /\.pty\.test\.[cm]?[jt]sx?$/.test(file.name);
    for (const assertion of file.assertionResults ?? []) {
      switch (assertion.status) {
        case 'passed':
          summary.passed += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'skipped':
          summary.skipped += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        case 'todo':
          summary.pending += 1;
          break;
      }

      if ((assertion.retryCount ?? 0) > 0) summary.retried += 1;
      if (isPty) {
        if (assertion.status === 'skipped' || assertion.status === 'pending' || assertion.status === 'todo') {
          summary.ptySkipped += 1;
        } else {
          summary.ptySupported += 1;
        }
      }
    }
  }

  return summary;
}
