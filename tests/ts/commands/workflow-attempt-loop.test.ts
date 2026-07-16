import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

const vaults: string[] = [];
afterEach(async () => {
  await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })));
});

interface Limits {
  max_iterations: number;
  max_seconds: number;
  max_tokens: number;
}

async function createAttemptVault(limits: Limits = { max_iterations: 3, max_seconds: 5, max_tokens: 100 }): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-attempt-loop-'));
  vaults.push(vault);
  await Promise.all(['.bwrb', 'Workflows', 'Attestations'].map((dir) => mkdir(join(vault, dir), { recursive: true })));
  await writeFile(join(vault, '.bwrb', 'schema.json'), JSON.stringify({
    version: 2,
    traits: {
      bounded: {
        attempt_loop: {
          attestation_type: 'attempt-attestation',
          acceptance: { operator: 'gte', threshold: 0.8 },
          limits,
          terminal: {
            status_field: 'status',
            accepted_value: 'accepted',
            failed_value: 'failed',
            stop_reason_field: 'stop-reason',
            run_id_field: 'attempt-run',
          },
        },
      },
    },
    types: {
      workflow: {
        output_dir: 'Workflows',
        traits: ['bounded'],
        fields: {
          status: { prompt: 'select', options: ['ready', 'accepted', 'failed'] },
          'stop-reason': { prompt: 'text' },
          'attempt-run': { prompt: 'text' },
        },
      },
      'attempt-attestation': {
        output_dir: 'Attestations',
        fields: {
          workflow: { prompt: 'relation', source: 'workflow' },
          'run-id': { prompt: 'text' },
          iteration: { prompt: 'number' },
          'idempotency-key': { prompt: 'text' },
          happened: { prompt: 'text' },
          failed: { prompt: 'text' },
          baseline: { prompt: 'number' },
          observed: { prompt: 'number' },
          'tokens-used': { prompt: 'number' },
          outcome: { prompt: 'select', options: ['accepted', 'retry'] },
        },
      },
    },
  }, null, 2));
  await writeFile(join(vault, 'Workflows', 'Improve result.md'), '---\ntype: workflow\nstatus: ready\nstop-reason: ""\nattempt-run: ""\n---\n');
  await writeFile(join(vault, 'attempt.cjs'), `
const fs = require('fs');
const mode = process.argv[2];
const iteration = Number(process.env.BWRB_ATTEMPT_ITERATION);
if (mode === 'timeout') setTimeout(() => {}, 5000);
else if (mode === 'invalid') process.stdout.write(JSON.stringify({ happened: 'missing required metrics' }));
else {
  fs.appendFileSync('executions.log', iteration + '\\n');
  const observed = mode === 'retry-pass' && iteration >= 2 ? 0.9 : 0.5;
  const tokens_used = mode === 'token-overflow' ? 11 : 10;
  process.stdout.write(JSON.stringify({
    happened: 'measured iteration ' + iteration,
    failed: observed >= 0.8 ? null : 'threshold not met',
    baseline: 0.4,
    observed,
    tokens_used,
  }));
}
`);
  return vault;
}

async function currentRevision(vault: string): Promise<string> {
  const listed = await runCLI(['list', 'workflow', '--output', 'json'], vault);
  expect(listed.exitCode).toBe(0);
  return (JSON.parse(listed.stdout) as Array<{ revision: string }>)[0]!.revision;
}

function runArgs(vault: string, revision: string, runId: string, mode: string): string[] {
  return [
    'workflow', 'run', 'Improve result',
    '--expected-revision', revision,
    '--run-id', runId,
    '--attempt-command', process.execPath,
    '--attempt-arg', join(vault, 'attempt.cjs'),
    '--attempt-arg', mode,
    '--output', 'json',
  ];
}

describe('bounded workflow attempt loop', () => {
  it('retries from structured attestations until the criterion passes, then replays idempotently', async () => {
    const vault = await createAttemptVault();
    const revision = await currentRevision(vault);
    const first = await runCLI(runArgs(vault, revision, 'run-pass', 'retry-pass'), vault);
    expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      success: true,
      data: {
        accepted: true,
        stopReason: 'criterion-accepted',
        runId: 'run-pass',
        tokensUsed: 20,
        idempotentReplay: false,
        attempts: [
          { iteration: 1, baseline: 0.4, observed: 0.5, outcome: 'retry', reused: false },
          { iteration: 2, baseline: 0.4, observed: 0.9, outcome: 'accepted', reused: false },
        ],
      },
    });
    expect(await readFile(join(vault, 'Workflows', 'Improve result.md'), 'utf8'))
      .toContain('stop-reason: criterion-accepted');
    expect((await readdir(join(vault, 'Attestations'))).length).toBe(2);

    const replay = await runCLI(runArgs(vault, revision, 'run-pass', 'retry-pass'), vault);
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ success: true, data: { idempotentReplay: true, attempts: [{ reused: true }, { reused: true }] } });
    expect((await readFile(join(vault, 'executions.log'), 'utf8')).trim().split('\n')).toEqual(['1', '2']);
    expect((await readdir(join(vault, 'Attestations'))).length).toBe(2);
  });

  it('records an explicit terminal failure when the iteration ceiling is exhausted', async () => {
    const vault = await createAttemptVault({ max_iterations: 2, max_seconds: 5, max_tokens: 100 });
    const result = await runCLI(runArgs(vault, await currentRevision(vault), 'run-max', 'never-pass'), vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout), result.stdout).toMatchObject({ success: true, data: { accepted: false, stopReason: 'max-iterations-reached', tokensUsed: 20 } });
    expect(await readFile(join(vault, 'Workflows', 'Improve result.md'), 'utf8')).toContain('status: failed');
  });

  it('fails closed when an attestation exceeds the token ceiling', async () => {
    const vault = await createAttemptVault({ max_iterations: 3, max_seconds: 5, max_tokens: 10 });
    const result = await runCLI(runArgs(vault, await currentRevision(vault), 'run-token', 'token-overflow'), vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout), result.stdout).toMatchObject({ success: true, data: { stopReason: 'token-budget-exceeded', tokensUsed: 11 } });
    expect((await readdir(join(vault, 'Attestations'))).length).toBe(1);
  });

  it('terminates the attempt process at the wall-clock ceiling', async () => {
    const vault = await createAttemptVault({ max_iterations: 3, max_seconds: 1, max_tokens: 100 });
    const result = await runCLI(runArgs(vault, await currentRevision(vault), 'run-time', 'timeout'), vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, data: { stopReason: 'attempt-timed-out', attempts: [] } });
    expect(await readFile(join(vault, 'Workflows', 'Improve result.md'), 'utf8')).toContain('stop-reason: attempt-timed-out');
  }, 10_000);

  it('records invalid structured output as a terminal protocol failure without retrying', async () => {
    const vault = await createAttemptVault();
    const result = await runCLI(runArgs(vault, await currentRevision(vault), 'run-invalid', 'invalid'), vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: {
        accepted: false,
        stopReason: 'invalid-attestation',
        attempts: [],
        process: { exitCode: 0 },
      },
    });
    expect(await readFile(join(vault, 'Workflows', 'Improve result.md'), 'utf8'))
      .toContain('stop-reason: invalid-attestation');
    expect((await readdir(join(vault, 'Attestations'))).length).toBe(0);
  });

  it('rejects a stale workflow revision before executing the child process', async () => {
    const vault = await createAttemptVault();
    const stale = await currentRevision(vault);
    await writeFile(join(vault, 'Workflows', 'Improve result.md'), '---\ntype: workflow\nstatus: ready\nstop-reason: changed\nattempt-run: ""\n---\n');
    const result = await runCLI(runArgs(vault, stale, 'run-stale', 'retry-pass'), vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, expectedRevision: stale });
    await expect(readFile(join(vault, 'executions.log'), 'utf8')).rejects.toThrow();
  });
});
