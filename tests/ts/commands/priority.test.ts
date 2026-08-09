import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const execFileAsync = promisify(execFile);
const executeArgs = ['--transaction-id', 'test'];

describe('priority command', () => {
  let vault: string;
  let taskPath: string;
  beforeEach(async () => {
    vault = await createTestVault(); taskPath = join(vault, 'Objectives/Tasks/Sample Task.md');
    await writeFile(taskPath, '---\ntype: task\nstatus: in-flight\nimportance: 4\nexcitement: 3\ndeadline: "2026-08-05"\ndeadline-kind: hard\n---\n');
    await writeFile(join(vault, '.bwrb/ids.jsonl'), `${JSON.stringify({ id: ID, createdAt: '2026-08-01T00:00:00.000Z', path: 'Objectives/Tasks/Sample Task.md' })}\n`);
    await execFileAsync('git', ['-C', vault, 'init', '-q']);
    await execFileAsync('git', ['-C', vault, 'checkout', '-q', '-b', 'vault-tx/test']);
  });
  afterEach(async () => cleanupTestVault(vault));

  it('suggests deterministically without changing the task', async () => {
    const before = await readFile(taskPath, 'utf8');
    const result = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(result.exitCode, result.stderr).toBe(0);
    const task = JSON.parse(result.stdout).data.tasks[0];
    expect(task).toMatchObject({ id: ID, score: 31, deadlinePressure: 4, suggestedRank: 1, effectiveRank: null });
    expect(task.semanticEvidenceRevision).toBeTruthy();
    expect(await readFile(taskPath, 'utf8')).toBe(before);
  });

  it('rejects calendar-invalid evaluation dates', async () => {
    const result = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-02-31', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('valid --as-of');
  });

  it('fails closed when registry identity is missing', async () => {
    await writeFile(join(vault, '.bwrb/ids.jsonl'), '');
    const result = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('identity');
  });

  it('fails closed on invalid factor values and malformed global identity state', async () => {
    await writeFile(taskPath, '---\ntype: task\nstatus: in-flight\nimportance: 2.5\nexcitement: 99\n---\n');
    await writeFile(join(vault, '.bwrb/ids.jsonl'), `${JSON.stringify({ id: ID, createdAt: '2026-08-01T00:00:00.000Z', path: 'Objectives/Tasks/Sample Task.md' })}\n{bad row}\n`);
    const result = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    const errors = JSON.parse(result.stdout).data.errors as string[];
    expect(errors).toEqual(expect.arrayContaining([
      'identity registry row 2 is malformed',
      'Objectives/Tasks/Sample Task.md: importance must be null or an integer from 0 to 4',
      'Objectives/Tasks/Sample Task.md: excitement must be null or an integer from 0 to 4',
    ]));
  });

  it('keeps approval dry-run until execute and records the exact accepted rank', async () => {
    const suggested = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    const task = JSON.parse(suggested.stdout).data.tasks[0];
    const planPath = join(vault, 'priority-plan.json');
    await writeFile(planPath, JSON.stringify({
      algorithm: 'thin-hybrid-v1',
      asOf: '2026-08-05',
      tasks: [{
        id: task.id,
        path: task.path,
        revision: task.rawRevision,
        semanticEvidenceRevision: task.semanticEvidenceRevision,
        rank: 1,
        importance: 3,
        excitement: null,
        override: true,
        reason: 'Alice prefers this outcome first',
      }],
    }));
    const before = await readFile(taskPath, 'utf8');
    const dryRun = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', '--output', 'json'], vault);
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout).data.mode).toBe('dry-run');
    expect(await readFile(taskPath, 'utf8')).toBe(before);

    const execute = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault);
    expect(execute.exitCode, execute.stderr).toBe(0);
    const accepted = await readFile(taskPath, 'utf8');
    expect(accepted).toContain('priority-rank: 1');
    expect(accepted).toContain('priority-override: true');
    expect(accepted).toContain('priority-algorithm: thin-hybrid-v1');
    expect(accepted).toContain('priority-reviewed: 2026-08-05');
    expect(accepted).toContain('priority-approval-id: alice-message-1');
    expect(accepted).toContain('importance: 3');
    expect(accepted).not.toContain('excitement:');

    const validate = await runCLI(['priority', 'validate', '--complete', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(validate.exitCode, validate.stderr || validate.stdout).toBe(0);
  });

  it('refuses an approval plan after any raw revision drift', async () => {
    const suggested = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    const task = JSON.parse(suggested.stdout).data.tasks[0];
    const planPath = join(vault, 'stale-priority-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: task.id, path: task.path, revision: task.rawRevision, semanticEvidenceRevision: task.semanticEvidenceRevision, rank: 1 }] }));
    await writeFile(taskPath, `${await readFile(taskPath, 'utf8')}\nChanged after proposal.\n`);
    const result = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('preflight');
  });

  it('rejects a stale algorithm plan without changing the effective queue', async () => {
    const suggested = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    const task = JSON.parse(suggested.stdout).data.tasks[0];
    const planPath = join(vault, 'old-algorithm-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v0', asOf: '2026-08-05', tasks: [{ id: task.id, path: task.path, revision: task.rawRevision, semanticEvidenceRevision: task.semanticEvidenceRevision, rank: 1 }] }));
    const before = await readFile(taskPath, 'utf8');
    const result = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.errors).toContain('plan algorithm thin-hybrid-v0 does not match thin-hybrid-v1');
    expect(await readFile(taskPath, 'utf8')).toBe(before);
  });

  it('reopens complete validation after semantic evidence changes without moving rank', async () => {
    const suggested = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault);
    const task = JSON.parse(suggested.stdout).data.tasks[0];
    const planPath = join(vault, 'approved-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: task.id, path: task.path, revision: task.rawRevision, semanticEvidenceRevision: task.semanticEvidenceRevision, rank: 1 }] }));
    const approve = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault);
    expect(approve.exitCode, approve.stderr || approve.stdout).toBe(0);
    await writeFile(taskPath, `${await readFile(taskPath, 'utf8')}\nMaterially changed evidence.\n`);

    const validate = await runCLI(['priority', 'validate', '--complete', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(validate.exitCode).toBe(1);
    expect(JSON.parse(validate.stdout).data.errors).toContain('Objectives/Tasks/Sample Task.md: semantic evidence changed after priority approval');
    expect(await readFile(taskPath, 'utf8')).toContain('priority-rank: 1');
  });

  it('preserves an existing human override when a later approval omits override fields', async () => {
    const initial = JSON.parse((await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault)).stdout).data.tasks[0];
    const firstPlan = join(vault, 'first-override-plan.json');
    await writeFile(firstPlan, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: initial.id, path: initial.path, revision: initial.rawRevision, semanticEvidenceRevision: initial.semanticEvidenceRevision, rank: 1, override: true, reason: 'Alice chose this order' }] }));
    expect((await runCLI(['priority', 'approve', '--json-file', firstPlan, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault)).exitCode).toBe(0);

    const refreshed = JSON.parse((await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault)).stdout).data.tasks[0];
    const secondPlan = join(vault, 'second-plan.json');
    await writeFile(secondPlan, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: refreshed.id, path: refreshed.path, revision: refreshed.rawRevision, semanticEvidenceRevision: refreshed.semanticEvidenceRevision, rank: 1 }] }));
    expect((await runCLI(['priority', 'approve', '--json-file', secondPlan, '--approval-id', 'alice-message-2', ...executeArgs, '--execute', '--output', 'json'], vault)).exitCode).toBe(0);
    const accepted = await readFile(taskPath, 'utf8');
    expect(accepted).toContain('priority-override: true');
    expect(accepted).toContain('priority-reason: Alice chose this order');
  });

  it('does not reopen rank review for orchestration-only checkpoint metadata', async () => {
    const suggested = JSON.parse((await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault)).stdout).data.tasks[0];
    const planPath = join(vault, 'checkpoint-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: suggested.id, path: suggested.path, revision: suggested.rawRevision, semanticEvidenceRevision: suggested.semanticEvidenceRevision, rank: 1 }] }));
    expect((await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', ...executeArgs, '--execute', '--output', 'json'], vault)).exitCode).toBe(0);
    const approved = await readFile(taskPath, 'utf8');
    await writeFile(taskPath, approved.replace('status: in-flight', 'status: in-flight\ncodex-attention: alice-needed\ncodex-last-reconciled-at: 2026-08-05T20:00:00Z'));
    const validate = await runCLI(['priority', 'validate', '--complete', '--as-of', '2026-08-05', '--output', 'json'], vault);
    expect(validate.exitCode, validate.stderr || validate.stdout).toBe(0);
    expect(await readFile(taskPath, 'utf8')).toContain('priority-rank: 1');
  });

  it('binds a natural-language scope to stable IDs while preserving one shared order', async () => {
    const otherPath = join(vault, 'Objectives/Tasks/Other Task.md');
    const thirdPath = join(vault, 'Objectives/Tasks/Third Task.md');
    await writeFile(otherPath, '---\ntype: task\nstatus: backlog\npriority-rank: 2\npriority-algorithm: thin-hybrid-v1\npriority-as-of: 2026-08-05\npriority-basis-revision: placeholder\npriority-reviewed: 2026-08-05\npriority-approval-id: prior\n---\n');
    await writeFile(thirdPath, '---\ntype: task\nstatus: backlog\npriority-rank: 3\npriority-algorithm: thin-hybrid-v1\npriority-as-of: 2026-08-05\npriority-basis-revision: placeholder\npriority-reviewed: 2026-08-05\npriority-approval-id: prior\n---\n');
    await writeFile(taskPath, '---\ntype: task\nstatus: in-flight\npriority-rank: 1\npriority-algorithm: thin-hybrid-v1\npriority-as-of: 2026-08-05\npriority-basis-revision: placeholder\npriority-reviewed: 2026-08-05\npriority-approval-id: prior\n---\n');
    await writeFile(join(vault, '.bwrb/ids.jsonl'), [
      { id: ID, path: 'Objectives/Tasks/Sample Task.md' },
      { id: OTHER_ID, path: 'Objectives/Tasks/Other Task.md' },
      { id: THIRD_ID, path: 'Objectives/Tasks/Third Task.md' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const scopePath = join(vault, 'scope.json'); await writeFile(scopePath, JSON.stringify({ taskIds: [OTHER_ID, THIRD_ID] }));
    const suggested = await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--ids-file', scopePath, '--output', 'json'], vault);
    expect(suggested.exitCode, suggested.stderr || suggested.stdout).toBe(0);
    const tasks = JSON.parse(suggested.stdout).data.tasks;
    expect(tasks.map((task: { id: string }) => task.id).sort()).toEqual([OTHER_ID, THIRD_ID].sort());

    const all = JSON.parse((await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault)).stdout).data.tasks;
    const byId = new Map(all.map((task: { id: string }) => [task.id, task]));
    const item = (id: string, rank: number) => { const task = byId.get(id) as { path: string; rawRevision: string; semanticEvidenceRevision: string }; return { id, path: task.path, revision: task.rawRevision, semanticEvidenceRevision: task.semanticEvidenceRevision, rank }; };
    const planPath = join(vault, 'scoped-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', scope: { taskIds: [OTHER_ID, THIRD_ID] }, tasks: [item(OTHER_ID, 1), item(ID, 2), item(THIRD_ID, 3)] }));
    const approved = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'scoped-approval', ...executeArgs, '--execute', '--output', 'json'], vault);
    expect(approved.exitCode, approved.stderr || approved.stdout).toBe(0);
    expect(await readFile(taskPath, 'utf8')).toContain('priority-rank: 2');
  });

  it('refuses execute outside the named isolated vault transaction branch', async () => {
    const suggested = JSON.parse((await runCLI(['priority', 'suggest', '--type', 'task', '--as-of', '2026-08-05', '--output', 'json'], vault)).stdout).data.tasks[0];
    const planPath = join(vault, 'branch-guard-plan.json');
    await writeFile(planPath, JSON.stringify({ algorithm: 'thin-hybrid-v1', asOf: '2026-08-05', tasks: [{ id: suggested.id, path: suggested.path, revision: suggested.rawRevision, semanticEvidenceRevision: suggested.semanticEvidenceRevision, rank: 1 }] }));
    const before = await readFile(taskPath, 'utf8');
    const result = await runCLI(['priority', 'approve', '--json-file', planPath, '--approval-id', 'alice-message-1', '--transaction-id', 'wrong', '--execute', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('vault-tx/wrong');
    expect(await readFile(taskPath, 'utf8')).toBe(before);
  });
});
