import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

const jsonOutputFile =
  process.env.BWRB_RELIABILITY_JSON_OUTPUT ?? 'artifacts/health/retry-zero-results.json';

/**
 * A deliberately separate lane from vitest.config.ts: this preserves the
 * retrying developer-feedback suite while making first-run reliability
 * observable with one worker, one concurrent test, and no retries.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: {
        BWRB_TEST_RELIABILITY: '1',
      },
      pool: 'forks',
      poolOptions: {
        forks: {
          minForks: 1,
          maxForks: 1,
        },
      },
      maxConcurrency: 1,
      retry: 0,
      reporters: ['default', 'json'],
      outputFile: {
        json: jsonOutputFile,
      },
    },
  })
);
