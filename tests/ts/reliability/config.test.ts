import { describe, expect, it } from 'vitest';
import reliabilityConfig from '../../../vitest.reliability.config.js';

describe('retry-zero Vitest configuration', () => {
  it('uses one worker, one concurrent test, and no Vitest retries', () => {
    expect(reliabilityConfig.test).toMatchObject({
      maxConcurrency: 1,
      retry: 0,
      env: { BWRB_TEST_RELIABILITY: '1' },
      poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    });
  });

  it('retains a durable JSON result artifact alongside human output', () => {
    expect(reliabilityConfig.test?.reporters).toEqual(['default', 'json']);
    expect(reliabilityConfig.test?.outputFile).toEqual({
      json: 'artifacts/health/retry-zero-results.json',
    });
  });
});
