import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

const vaults: string[] = [];

afterEach(async () => {
  await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true })));
});

async function createWorkflowVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-agent-workflow-'));
  vaults.push(vault);
  await Promise.all(
    ['.bwrb', 'Candidates', 'Requirements', 'Tasks'].map((dir) =>
      mkdir(join(vault, dir), { recursive: true })
    )
  );

  await writeFile(join(vault, '.bwrb', 'schema.json'), JSON.stringify({
    version: 2,
    traits: {
      reviewable: {
        transition_guards: [{
          on: 'status = accepted',
          requires: [{
            relation: 'requirements',
            all: { field: 'status', equals: 'satisfied' },
          }],
        }],
        transition_effects: [{
          on: 'status = accepted',
          relation: 'task',
          set: { status: 'done' },
        }],
      },
    },
    types: {
      attestation: {
        output_dir: 'Attestations',
        fields: {
          actor: { value: '$ACTOR' },
          outcome: { prompt: 'select', options: ['passed', 'failed'] },
        },
      },
      candidate: {
        output_dir: 'Candidates',
        traits: ['reviewable'],
        fields: {
          status: { prompt: 'select', options: ['implementing', 'accepted'] },
          requirements: { prompt: 'relation', source: 'requirement', multiple: true },
          task: { prompt: 'relation', source: 'task' },
          'resolved-at': { prompt: 'date', granularity: 'day' },
          'retention-state': { prompt: 'select', options: ['active', 'tombstoned'] },
          'tombstoned-at': { prompt: 'date', granularity: 'day' },
        },
        retention: {
          when: { status: { in: ['accepted'] } },
          clock: { field: 'resolved-at', after: '1d' },
          resolved_when: { 'retention-state': { in: ['tombstoned'] } },
          actions: [{
            kind: 'tombstone',
            set: { 'retention-state': 'tombstoned', 'tombstoned-at': '$TODAY' },
          }],
        },
      },
      requirement: {
        output_dir: 'Requirements',
        fields: { status: { prompt: 'select', options: ['pending', 'satisfied'] } },
      },
      task: {
        output_dir: 'Tasks',
        fields: { status: { prompt: 'select', options: ['open', 'done'] } },
      },
    },
  }, null, 2));

  await writeFile(
    join(vault, 'Candidates', 'Candidate 417.md'),
    '---\ntype: candidate\nstatus: implementing\nrequirements:\n  - "[[Requirement 1]]"\ntask: "[[Task 1]]"\nresolved-at: 2000-01-01\nretention-state: active\n---\nCandidate body.\n'
  );
  await writeFile(
    join(vault, 'Requirements', 'Requirement 1.md'),
    '---\ntype: requirement\nstatus: satisfied\n---\n'
  );
  await writeFile(join(vault, 'Tasks', 'Task 1.md'), '---\ntype: task\nstatus: open\n---\n');
  return vault;
}

describe('agent workflow CLI acceptance', () => {
  it('carries provenance through guarded review, downstream work, and explicit retention', async () => {
    const vault = await createWorkflowVault();

    const attestation = await runCLI(
      ['--actor', 'codex:acceptance-runner', 'new', 'attestation', '--json', '{"name":"Review proof","outcome":"passed"}'],
      vault
    );
    expect(attestation.exitCode).toBe(0);
    expect(await readFile(join(vault, 'Attestations', 'Review proof.md'), 'utf8'))
      .toContain('actor: codex:acceptance-runner');

    const listed = await runCLI(['list', 'candidate', '--output', 'json'], vault);
    expect(listed.exitCode).toBe(0);
    const [candidate] = JSON.parse(listed.stdout) as Array<{ revision: string }>;
    expect(candidate.revision).toMatch(/^[a-f0-9]{64}$/);

    const explanation = await runCLI(
      ['explain', 'Candidate 417', '--transition', 'accepted', '--output', 'json'],
      vault
    );
    expect(explanation.exitCode).toBe(0);
    expect(JSON.parse(explanation.stdout)).toMatchObject({
      success: true,
      data: { blocked: false, transition: { field: 'status', value: 'accepted' } },
    });

    const accepted = await runCLI([
      'edit', 'Candidates/Candidate 417.md', '--json', '{"status":"accepted"}',
      '--expected-revision', candidate.revision, '--output', 'json',
    ], vault);
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse(accepted.stdout).revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(vault, 'Tasks', 'Task 1.md'), 'utf8')).toContain('status: done');

    const report = await runCLI(['audit', '--only', 'retention-due'], vault);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain('Retention is due');

    const dryRun = await runCLI([
      'audit', '--path', 'Candidates/Candidate 417.md', '--fix', '--only', 'retention-due',
      '--retention-action', 'tombstone',
    ], vault);
    expect(dryRun.stdout).toContain('Would tombstone');
    expect(await readFile(join(vault, 'Candidates', 'Candidate 417.md'), 'utf8'))
      .toContain('retention-state: active');

    const execute = await runCLI([
      'audit', '--path', 'Candidates/Candidate 417.md', '--fix', '--only', 'retention-due',
      '--retention-action', 'tombstone', '--execute',
    ], vault);
    expect(execute.exitCode).toBe(0);
    expect(execute.stdout).toContain('Tombstoned');
    const retained = await readFile(join(vault, 'Candidates', 'Candidate 417.md'), 'utf8');
    expect(retained).toContain('retention-state: tombstoned');
    expect(retained).toMatch(/tombstoned-at: \d{4}-\d{2}-\d{2}/);
  });
});
