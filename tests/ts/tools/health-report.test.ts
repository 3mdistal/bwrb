import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('health report tool', () => {
  it('creates parent directories for --out and writes parseable JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bwrb-health-report-'));
    temporaryPaths.push(directory);
    const output = join(directory, 'artifacts', 'health', 'report.json');
    await execFileAsync('pnpm', [
      'exec', 'tsx', 'src/tools/health/report.ts', '--check', 'full-knip', '--status', 'passed',
      '--classification', 'measured', '--out', output,
    ], { cwd: process.cwd() });
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.results).toEqual([expect.objectContaining({ check: 'full-knip', classification: 'measured' })]);
  });
});
