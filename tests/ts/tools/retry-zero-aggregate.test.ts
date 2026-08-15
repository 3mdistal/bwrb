import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateRetryZero } from '../../../src/tools/health/retry-zero-aggregate.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: {
  duplicate?: boolean;
  missing?: boolean;
  pty?: boolean;
  retried?: boolean;
  shardReports?: number;
  success?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bwrb-retry-zero-aggregate-'));
  temporaryPaths.push(root);
  await mkdir(join(root, 'tests/ts/commands'), { recursive: true });
  await mkdir(join(root, 'artifacts/shards'), { recursive: true });
  await mkdir(join(root, 'artifacts/health'), { recursive: true });
  await writeFile(join(root, 'tests/ts/commands/one.test.ts'), '');
  await writeFile(join(root, 'tests/ts/commands/two.test.ts'), '');
  await writeFile(join(root, 'tests/ts/commands/ignored.pty.test.ts'), '');
  for (let shard = 1; shard <= (options.shardReports ?? 2); shard += 1) {
    await writeFile(join(root, `artifacts/shards/retry-zero-${shard}.blob`), 'blob');
  }
  const first = {
    name: join(root, 'tests/ts/commands/one.test.ts'),
    assertionResults: [{ status: 'passed', retryCount: options.retried ? 1 : 0 }],
  };
  const second = {
    name: join(root, 'tests/ts/commands/two.test.ts'),
    assertionResults: [{ status: options.success === false ? 'failed' : 'passed' }],
  };
  await writeFile(join(root, 'artifacts/health/results.json'), JSON.stringify({
    success: options.success ?? true,
    testResults: [
      first,
      ...(options.missing ? [] : [second]),
      ...(options.duplicate ? [first] : []),
      ...(options.pty ? [{
        name: join(root, 'tests/ts/commands/ignored.pty.test.ts'),
        assertionResults: [{ status: 'passed' }],
      }] : []),
    ],
  }));
  return {
    root,
    args: {
      results: 'artifacts/health/results.json',
      expectedRoot: 'tests/ts',
      shardDir: 'artifacts/shards',
      expectedShards: 2,
      summary: 'artifacts/health/summary.json',
      manifest: 'artifacts/health/manifest.json',
    },
  };
}

describe('retry-zero result aggregation', () => {
  it('proves the two shards cover every non-PTY file exactly once', async () => {
    const { root, args } = await fixture();
    const result = await aggregateRetryZero(args, root);

    expect(result.summary).toMatchObject({
      complete: true,
      expectedFiles: 2,
      observedFiles: 2,
      passed: 2,
      retried: 0,
      shardReports: 2,
    });
    expect(result.manifest.violations).toEqual([]);
    expect(JSON.parse(await readFile(join(root, args.summary), 'utf8'))).toEqual(result.summary);
  });

  it.each([
    ['a missing shard report', { shardReports: 1 }, 'expected 2 shard reports, found 1'],
    ['a missing test file', { missing: true }, 'missing test files: tests/ts/commands/two.test.ts'],
    ['a duplicated test file', { duplicate: true }, 'duplicate test files: tests/ts/commands/one.test.ts'],
    ['an executed PTY file', { pty: true }, 'PTY files were executed: tests/ts/commands/ignored.pty.test.ts'],
    ['a recorded retry', { retried: true }, '1 assertions recorded retries'],
    ['a failed merged run', { success: false }, 'merged retry-zero run failed'],
  ])('records %s as a fail-closed violation', async (_name, options, violation) => {
    const { root, args } = await fixture(options);
    const result = await aggregateRetryZero(args, root);

    expect(result.summary.complete).toBe(false);
    expect(result.manifest.violations).toContain(violation);
  });
});
