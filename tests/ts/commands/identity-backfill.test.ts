import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTestVault, createTestVault, runCLI } from '../fixtures/setup.js';

describe('identity backfill', () => {
  let vault: string;
  let registryPath: string;

  beforeEach(async () => {
    vault = await createTestVault();
    registryPath = join(vault, '.bwrb/ids.jsonl');
    await writeFile(registryPath, '');
    await writeFile(join(vault, 'Objectives/Tasks/Sample Task.md'), '---\ntype: task\nstatus: next\n---\n');
  });

  afterEach(async () => cleanupTestVault(vault));

  it('is dry-run first and atomically closes registry identity for the selected type', async () => {
    const before = await readFile(registryPath, 'utf8');
    const dryRun = await runCLI(['identity', 'backfill', '--type', 'task', '--output', 'json'], vault);
    expect(dryRun.exitCode, dryRun.stderr || dryRun.stdout).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ mode: 'dry-run', type: 'task', missing: 1 });
    expect(await readFile(registryPath, 'utf8')).toBe(before);

    const execute = await runCLI(['identity', 'backfill', '--type', 'task', '--execute', '--output', 'json'], vault);
    expect(execute.exitCode, execute.stderr || execute.stdout).toBe(0);
    const result = JSON.parse(execute.stdout);
    expect(result).toMatchObject({ mode: 'execute', type: 'task', missing: 1 });
    expect(result.changes[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(registryPath, 'utf8')).toContain('Objectives/Tasks/Sample Task.md');

    const repeated = await runCLI(['identity', 'backfill', '--type', 'task', '--output', 'json'], vault);
    expect(JSON.parse(repeated.stdout).missing).toBe(0);
  });

  it('fails closed on malformed durable registry state', async () => {
    await writeFile(registryPath, '{not json}\n');
    const result = await runCLI(['identity', 'backfill', '--type', 'task', '--execute', '--output', 'json'], vault);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('Malformed identity registry row');
  });

  it('can bind an exact path without widening the identity transaction', async () => {
    await writeFile(join(vault, 'Objectives/Tasks/Another Task.md'), '---\ntype: task\nstatus: next\n---\n');
    const result = await runCLI(['identity', 'backfill', '--type', 'task', '--path', 'Objectives/Tasks/Sample Task.md', '--execute', '--output', 'json'], vault);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).changes).toHaveLength(1);
    const registry = await readFile(registryPath, 'utf8');
    expect(registry).toContain('Objectives/Tasks/Sample Task.md');
    expect(registry).not.toContain('Objectives/Tasks/Another Task.md');
  });
});
