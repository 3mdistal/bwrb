import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('global --non-interactive destructive flows', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('requires --auto for audit --fix when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'audit', '--fix', '--path', 'Ideas/**'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb audit --fix requires --auto');
  });

  it('requires --force or --yes for bulk execute when non-interactive is set', async () => {
    const result = await runCLI(
      ['--non-interactive', 'bulk', '--all', '--set', 'reviewed=true', '--execute'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb bulk --execute requires --force or --yes');
  });

  it('requires --yes for init when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'init', vaultDir]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb init requires --yes');
  });

  it('requires --force for delete execution when non-interactive is set', async () => {
    const singleResult = await runCLI(['--non-interactive', 'delete', 'Sample Idea'], vaultDir);
    expect(singleResult.exitCode).not.toBe(0);
    expect(singleResult.stderr).toContain('bwrb delete requires --force');

    const bulkResult = await runCLI(
      ['--non-interactive', 'delete', '--type', 'idea', '--execute'],
      vaultDir
    );
    expect(bulkResult.exitCode).not.toBe(0);
    expect(bulkResult.stderr).toContain('bwrb delete --execute requires --force');
  });

  it('requires --force for dashboard and template delete when non-interactive is set', async () => {
    const dashboardSeed = await runCLI(['dashboard', 'new', 'triage', '--json', '{"type":"idea"}'], vaultDir);
    expect(dashboardSeed.exitCode).toBe(0);

    const templateSeed = await runCLI(
      ['template', 'new', 'idea', '--json', '{"name":"triage-template","body":"# Body"}'],
      vaultDir
    );
    expect(templateSeed.exitCode).toBe(0);

    const dashboardDelete = await runCLI(['--non-interactive', 'dashboard', 'delete', 'triage'], vaultDir);
    expect(dashboardDelete.exitCode).not.toBe(0);
    expect(dashboardDelete.stderr).toContain('bwrb dashboard delete requires --force');

    const templateDelete = await runCLI(
      ['--non-interactive', 'template', 'delete', 'idea', 'triage-template'],
      vaultDir
    );
    expect(templateDelete.exitCode).not.toBe(0);
    expect(templateDelete.stderr).toContain('bwrb template delete requires --force');
  });
});
