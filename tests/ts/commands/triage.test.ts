import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('triage command', () => {
  let vault: string;
  let notePath: string;
  const relativePath = 'Objectives/Tasks/Sample Task.md';

  beforeEach(async () => {
    vault = await createTestVault(); notePath = join(vault, relativePath);
    await writeFile(notePath, '---\ntype: task\nstatus: next\n---\n\nLanded evidence.\n');
    await writeFile(join(vault, '.bwrb/ids.jsonl'), `${JSON.stringify({ id: ID, createdAt: '2026-08-01T00:00:00.000Z', path: relativePath })}\n`);
  });
  afterEach(async () => cleanupTestVault(vault));

  it('records an approved disposition and reopens only after semantic evidence changes', async () => {
    const initial = await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault);
    const item = JSON.parse(initial.stdout).data;
    expect(item.state).toBe('new');
    const planPath = join(vault, 'triage-plan.json');
    await writeFile(planPath, JSON.stringify({ items: [{ id: item.id, path: item.path, revision: item.revision, disposition: 'no-action' }] }));
    const dryRun = await runCLI(['triage', 'approve', '--json-file', planPath, '--approval-id', 'alice-triage-1', '--output', 'json'], vault);
    expect(JSON.parse(dryRun.stdout).data.mode).toBe('dry-run');
    expect(await readFile(join(vault, '.bwrb/triage.jsonl'), 'utf8').catch(() => '')).toBe('');
    expect((await runCLI(['triage', 'approve', '--json-file', planPath, '--approval-id', 'alice-triage-1', '--execute', '--output', 'json'], vault)).exitCode).toBe(0);
    expect(JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data.state).toBe('triaged');

    const raw = await readFile(notePath, 'utf8');
    await writeFile(notePath, raw.replace('status: next', 'status: next\ncodex-last-reconciled-at: 2026-08-05T20:00:00Z'));
    expect(JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data.state).toBe('triaged');
    await writeFile(notePath, `${await readFile(notePath, 'utf8')}\nMaterial change.\n`);
    expect(JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data.state).toBe('changed');
  });

  it('fails closed on revision drift and requires a reason to defer', async () => {
    const item = JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data;
    const planPath = join(vault, 'triage-plan.json');
    await writeFile(planPath, JSON.stringify({ items: [{ id: item.id, path: item.path, revision: item.revision, disposition: 'defer' }] }));
    expect((await runCLI(['triage', 'approve', '--json-file', planPath, '--approval-id', 'alice-triage-1', '--execute', '--output', 'json'], vault)).exitCode).toBe(1);
    await writeFile(planPath, JSON.stringify({ items: [{ id: item.id, path: item.path, revision: item.revision, disposition: 'defer', reason: 'Need Alice context' }] }));
    await writeFile(notePath, `${await readFile(notePath, 'utf8')}\nChanged.\n`);
    expect((await runCLI(['triage', 'approve', '--json-file', planPath, '--approval-id', 'alice-triage-1', '--execute', '--output', 'json'], vault)).exitCode).toBe(1);
  });

  it('binds actionable dispositions to exact target task revisions and validates ledger authority', async () => {
    const targetPath = 'Objectives/Tasks/Target Task.md';
    const targetId = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(vault, targetPath), '---\ntype: task\nstatus: next\n---\n\nTarget.\n');
    await writeFile(join(vault, '.bwrb/ids.jsonl'), `${await readFile(join(vault, '.bwrb/ids.jsonl'), 'utf8')}${JSON.stringify({ id: targetId, createdAt: '2026-08-01T00:00:00.000Z', path: targetPath })}\n`);
    const source = JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data;
    const target = JSON.parse((await runCLI(['triage', 'status', '--path', targetPath, '--output', 'json'], vault)).stdout).data;
    const planPath = join(vault, 'target-plan.json');
    await writeFile(planPath, JSON.stringify({ items: [{ id: source.id, path: source.path, revision: source.revision, disposition: 'link-existing', targets: [{ id: target.id, path: target.path, revision: target.revision }] }] }));
    await writeFile(join(vault, targetPath), `${await readFile(join(vault, targetPath), 'utf8')}\nChanged target.\n`);
    const stale = await runCLI(['triage', 'approve', '--json-file', planPath, '--approval-id', 'alice-triage-1', '--execute', '--output', 'json'], vault);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout).error).toContain('target task identity or revision changed');

    await writeFile(join(vault, '.bwrb/triage.jsonl'), `${JSON.stringify({ id: ID, path: relativePath, revision: source.revision, disposition: 'no-action', reviewedAt: 'not-a-date', approvalId: '' })}\n`);
    const invalid = await runCLI(['triage', 'validate', '--output', 'json'], vault);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error).toContain('Malformed triage ledger row');
  });

  it('validates the latest identity path while preserving renamed historical rows', async () => {
    const item = JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data;
    const common = { id: ID, revision: item.revision, disposition: 'no-action', reviewedAt: '2026-08-05T20:00:00.000Z', approvalId: 'alice-triage-1' };
    await writeFile(join(vault, '.bwrb/triage.jsonl'), `${JSON.stringify({ ...common, path: 'Objectives/Tasks/Old Name.md' })}\n${JSON.stringify({ ...common, path: relativePath })}\n`);
    const valid = await runCLI(['triage', 'validate', '--output', 'json'], vault);
    expect(valid.exitCode, valid.stderr || valid.stdout).toBe(0);

    await writeFile(join(vault, '.bwrb/triage.jsonl'), `${JSON.stringify({ ...common, path: relativePath, disposition: 'link-existing' })}\n`);
    const missingTargets = await runCLI(['triage', 'validate', '--output', 'json'], vault);
    expect(missingTargets.exitCode).toBe(1);
    expect(JSON.parse(missingTargets.stdout).error).toContain('Malformed triage ledger row');
  });

  it('reopens renamed evidence and preserves its prior-path history after reapproval', async () => {
    const initial = JSON.parse((await runCLI(['triage', 'status', '--path', relativePath, '--output', 'json'], vault)).stdout).data;
    const initialPlan = join(vault, 'initial-plan.json');
    await writeFile(initialPlan, JSON.stringify({ items: [{ id: initial.id, path: initial.path, revision: initial.revision, disposition: 'no-action' }] }));
    expect((await runCLI(['triage', 'approve', '--json-file', initialPlan, '--approval-id', 'alice-triage-1', '--execute', '--output', 'json'], vault)).exitCode).toBe(0);

    const renamedPath = 'Objectives/Tasks/Renamed Task.md';
    await rename(notePath, join(vault, renamedPath));
    await writeFile(join(vault, '.bwrb/ids.jsonl'), `${JSON.stringify({ id: ID, createdAt: '2026-08-01T00:00:00.000Z', path: renamedPath })}\n`);

    const reopened = JSON.parse((await runCLI(['triage', 'status', '--path', renamedPath, '--output', 'json'], vault)).stdout).data;
    expect(reopened.state).toBe('changed');
    expect(reopened.prior.path).toBe(relativePath);

    const renamedPlan = join(vault, 'renamed-plan.json');
    await writeFile(renamedPlan, JSON.stringify({ items: [{ id: reopened.id, path: reopened.path, revision: reopened.revision, disposition: 'no-action' }] }));
    expect((await runCLI(['triage', 'approve', '--json-file', renamedPlan, '--approval-id', 'alice-triage-2', '--execute', '--output', 'json'], vault)).exitCode).toBe(0);
    const rows = (await readFile(join(vault, '.bwrb/triage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.path)).toEqual([relativePath, renamedPath]);
    expect((await runCLI(['triage', 'validate', '--output', 'json'], vault)).exitCode).toBe(0);
  });
});
