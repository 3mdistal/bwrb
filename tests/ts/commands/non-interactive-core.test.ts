import { describe, expect, it } from 'vitest';
import { runCLI } from '../fixtures/setup.js';

describe('global --non-interactive core flag', () => {
  it('shows the root flag in help output', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--non-interactive');
  });
});
