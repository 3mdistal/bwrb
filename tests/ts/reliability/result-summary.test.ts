import { describe, expect, it } from 'vitest';
import { summarizeReliabilityResults } from './result-summary.js';

describe('retry-zero JSON result summarization', () => {
  it('counts ordinary results and keeps retry evidence visible', () => {
    expect(
      summarizeReliabilityResults({
        testResults: [
          {
            name: '/repo/tests/ts/commands/list.test.ts',
            assertionResults: [
              { status: 'passed' },
              { status: 'failed', retryCount: 1 },
              { status: 'skipped' },
              { status: 'pending' },
            ],
          },
        ],
      })
    ).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      pending: 1,
      retried: 1,
      ptySupported: 0,
      ptySkipped: 0,
    });
  });

  it('does not conflate skipped PTY assertions with supported PTY coverage', () => {
    expect(
      summarizeReliabilityResults({
        testResults: [
          {
            name: '/repo/tests/ts/commands/new.pty.test.ts',
            assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }],
          },
        ],
      })
    ).toEqual({
      passed: 1,
      failed: 0,
      skipped: 1,
      pending: 1,
      retried: 0,
      ptySupported: 1,
      ptySkipped: 2,
    });
  });
});
