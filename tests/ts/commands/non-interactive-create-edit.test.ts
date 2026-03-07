import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('global --non-interactive create/edit flows', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('requires --json for new when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'new', 'idea'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb new requires --json <frontmatter>');
  });

  it('requires --json for edit when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'edit', 'Sample Idea'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb edit requires --json <patch>');
  });

  it('requires --json for search --edit when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'search', 'Sample Idea', '--edit'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb search --edit requires --json <patch>');
  });

  it('requires --json for config edit when non-interactive is set', async () => {
    const result = await runCLI(['--non-interactive', 'config', 'edit', 'link_format'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb config edit requires an option name and --json <value>');
  });

  it('requires explicit flags for dashboard and template creation flows', async () => {
    const dashboardResult = await runCLI(['--non-interactive', 'dashboard', 'new', 'triage'], vaultDir);
    expect(dashboardResult.exitCode).not.toBe(0);
    expect(dashboardResult.stderr).toContain('bwrb dashboard new requires --json <data> or explicit query flags');

    const templateResult = await runCLI(['--non-interactive', 'template', 'new', 'idea'], vaultDir);
    expect(templateResult.exitCode).not.toBe(0);
    expect(templateResult.stderr).toContain('bwrb template new requires --json <data>');
  });

  it('requires explicit inputs for dashboard and template editing flows', async () => {
    const dashboardSeed = await runCLI(['dashboard', 'new', 'triage', '--json', '{"type":"idea"}'], vaultDir);
    expect(dashboardSeed.exitCode).toBe(0);

    const templateSeed = await runCLI(
      ['template', 'new', 'idea', '--json', '{"name":"triage-template","body":"# Body"}'],
      vaultDir
    );
    expect(templateSeed.exitCode).toBe(0);

    const dashboardEdit = await runCLI(['--non-interactive', 'dashboard', 'edit', 'triage'], vaultDir);
    expect(dashboardEdit.exitCode).not.toBe(0);
    expect(dashboardEdit.stderr).toContain('bwrb dashboard edit requires --json <data> or explicit edit flags');

    const templateEdit = await runCLI(
      ['--non-interactive', 'template', 'edit', 'idea', 'triage-template'],
      vaultDir
    );
    expect(templateEdit.exitCode).not.toBe(0);
    expect(templateEdit.stderr).toContain('bwrb template edit requires --json <data>');
  });
});
