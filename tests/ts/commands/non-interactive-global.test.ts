import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, runCLI } from '../fixtures/setup.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function makeVault(): Promise<string> {
  const vaultDir = await createTestVault();
  tempPaths.push(vaultDir);
  return vaultDir;
}

describe('global --non-interactive', () => {
  it('shows the root flag in help output', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--non-interactive');
  });

  it('forces open to fail on ambiguity instead of trying interactive selection', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(['--non-interactive', 'open', 'Idea'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Ambiguous query');
  });

  it('requires --json for new when non-interactive is set', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(['--non-interactive', 'new', 'idea'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb new requires --json <frontmatter>');
  });

  it('requires --json for search --edit when non-interactive is set', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(['--non-interactive', 'search', 'Sample Idea', '--edit'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb search --edit requires --json <patch>');
  });

  it('requires --auto for audit --fix when non-interactive is set', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(['--non-interactive', 'audit', '--fix', '--path', 'Ideas/**'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb audit --fix requires --auto');
  });

  it('requires --force or --yes for bulk execute when non-interactive is set', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(
      ['--non-interactive', 'bulk', '--all', '--set', 'reviewed=true', '--execute'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb bulk --execute requires --force or --yes');
  });

  it('requires --json for config edit when non-interactive is set', async () => {
    const vaultDir = await makeVault();
    const result = await runCLI(['--non-interactive', 'config', 'edit', 'link_format'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb config edit requires an option name and --json <value>');
  });

  it('requires --yes for init when non-interactive is set', async () => {
    const initDir = await mkdtemp(join(tmpdir(), 'bwrb-init-'));
    tempPaths.push(initDir);

    const result = await runCLI(['--non-interactive', 'init', initDir]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bwrb init requires --yes');
  });
});
