import { describe, it, expect } from 'vitest';
import path from 'path';
import { runCLI, PROJECT_ROOT } from '../fixtures/setup.js';

const FIXTURE_VAULT = path.join(PROJECT_ROOT, 'tests/fixtures/vault');

describe('dist CLI smoke', () => {
  it('prints version from built artifact', async () => {
    const result = await runCLI(['--version'], { mode: 'dist' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints help from built artifact', async () => {
    const result = await runCLI(['--help'], { mode: 'dist' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('runs a non-interactive command against fixture vault', async () => {
    const result = await runCLI(['list', '--type', 'idea', '--paths'], {
      mode: 'dist',
      vaultDir: FIXTURE_VAULT,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ideas/Sample Idea.md');
  });
});
