import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  parseVitestJson,
  renderDigest,
} from '../../../scripts/ci/pty-summary-core.mjs';

describe('pty-summary-core', () => {
  it('classifies failures and maps transcript by test name', () => {
    const parsed = parseVitestJson(
      JSON.stringify({
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [
          {
            name: 'tests/ts/lib/prompt-input.pty.test.ts',
            assertionResults: [
              {
                status: 'failed',
                title: 'should fail',
                ancestorTitles: ['Prompt PTY'],
                failureMessages: ['AssertionError: boom\nstack line'],
              },
            ],
          },
        ],
      })
    );

    const digest = buildDigest(parsed, [
      {
        id: 'abc',
        testName: 'Prompt PTY > should fail',
        testPath: 'tests/ts/lib/prompt-input.pty.test.ts',
        logFile: 'abc.log',
        preview: ['line1', 'line2', 'line3'],
      },
    ]);

    expect(digest.state).toBe('failed');
    expect(digest.failures).toHaveLength(1);
    expect(digest.failures[0]?.transcript?.logFile).toBe('abc.log');
    expect(digest.failures[0]?.transcriptPreview).toEqual(['line1', 'line2', 'line3']);
  });

  it('classifies all-skipped results as skipped-env', () => {
    const parsed = parseVitestJson(
      JSON.stringify({
        numTotalTests: 4,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 4,
        testResults: [],
      })
    );
    expect(parsed.state).toBe('skipped-env');
  });

  it('classifies zero-test runs as no-tests-collected', () => {
    const parsed = parseVitestJson(
      JSON.stringify({
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [],
      })
    );
    expect(parsed.state).toBe('no-tests-collected');
  });

  it('classifies malformed json as infra-error', () => {
    const parsed = parseVitestJson('{not-json');
    expect(parsed.state).toBe('infra-error');
    expect(parsed.reason).toContain('Unable to parse');
  });

  it('renders a compact digest text', () => {
    const digestText = renderDigest({
      state: 'passed',
      totals: { total: 3, passed: 3, failed: 0, pending: 0 },
      reason: null,
      failures: [],
      transcriptCount: 2,
    });

    expect(digestText).toContain('state: passed');
    expect(digestText).toContain('failures: none');
  });
});
