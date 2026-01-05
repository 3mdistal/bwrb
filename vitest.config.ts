import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/ts/**/*.test.ts'],
    setupFiles: ['tests/ts/setup.ts'],
    globalTeardown: 'tests/ts/teardown.ts',
    // Limit parallelism to prevent CPU saturation causing flaky tests
    // PTY tests are timing-sensitive and fail when CPU is maxed out
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    maxConcurrency: 5,
    // Retry flaky tests once before failing - handles CPU contention gracefully
    retry: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '**/*.test.ts',
        'vitest.config.ts',
      ],
    },
  },
});
