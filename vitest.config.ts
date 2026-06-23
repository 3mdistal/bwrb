import { defineConfig } from 'vitest/config';
import {
  createVitestViteEnvShimPlugin,
  VITE_ENV_SHIM_ID,
} from './tests/ts/support/vite-env-shim.js';
import { resolveVitestRoot } from './tests/ts/support/vitest-root.js';

export default defineConfig({
  plugins: [createVitestViteEnvShimPlugin()],
  root: resolveVitestRoot(),
  resolve: {
    preserveSymlinks: true,
    alias: [
      {
        find: /^\/@vite\/env(?:\?.*)?$/,
        replacement: VITE_ENV_SHIM_ID,
      },
      {
        find: /vite\/dist\/client\/env\.mjs(?:\?.*)?$/,
        replacement: VITE_ENV_SHIM_ID,
      },
    ],
  },
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
    // Real-CLI suites spawn `tsx` subprocesses (see tests/ts/fixtures/setup.ts),
    // and some tests fire several sequential spawns in one test/hook. Under heavy
    // parallel load (many concurrent forks each cold-starting `tsx`) those spawns
    // can take several seconds each. The default 5s timeout was too tight and was
    // the root cause of the seed-step flake (#643): vitest aborted the test,
    // SIGTERM-ed the in-flight spawn, and it surfaced as "exitCode 1, expected 0".
    // These budgets are generous so contention shows up as slow-but-green.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
