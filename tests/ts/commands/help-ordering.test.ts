import { describe, expect, it } from 'vitest';
import { runCLI } from '../fixtures/setup.js';
import {
  assertCanonicalHelpCommandOrdering,
  extractHelpCommands,
} from '../helpers/help.js';

describe('top-level help command ordering', () => {
  it('matches the canonical product ordering contract', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const commands = extractHelpCommands(result.stdout);

    expect(() => assertCanonicalHelpCommandOrdering(commands)).not.toThrow();
  });

  it('documents vault discovery sources and their precedence', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('precedence: --vault');
    expect(result.stdout).toContain('nearest ancestor, BWRB_VAULT');
    expect(result.stdout).toContain('discovery below cwd');
  });
});
