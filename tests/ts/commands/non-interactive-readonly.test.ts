import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('global --non-interactive read-only flows', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('forces list --open to fail when multiple results are available', async () => {
    const result = await runCLI(['--non-interactive', 'list', '--type', 'idea', '--open'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Ambiguous query');
  });

});
