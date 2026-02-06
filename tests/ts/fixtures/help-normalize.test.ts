import { describe, expect, it } from 'vitest';

import { normalizeCliHelpForSnapshot } from './help.js';

describe('normalizeCliHelpForSnapshot', () => {
  it('strips ANSI sequences and normalizes newlines', () => {
    const input = '\u001b[32mUsage:\u001b[0m bwrb\r\n\r\n\u001b[1mDone\u001b[0m';
    const normalized = normalizeCliHelpForSnapshot(input);

    expect(normalized).toBe('Usage: bwrb\n\nDone');
  });

  it('replaces only known path targets and keeps type-path examples', () => {
    const input = [
      'Project: /repo/bwrb',
      'Vault: /tmp/bwrb-test-abcd1234',
      'Example type path: objective/task',
      'Example note path: Ideas/Sample Idea',
    ].join('\n');

    const normalized = normalizeCliHelpForSnapshot(input, {
      vaultDir: '/tmp/bwrb-test-abcd1234',
    });

    expect(normalized).toContain('Project: /repo/bwrb');
    expect(normalized).toContain('Vault: <path>');
    expect(normalized).toContain('objective/task');
    expect(normalized).toContain('Ideas/Sample Idea');
  });

  it('optionally replaces semver tokens', () => {
    const input = 'bwrb v0.1.5 and 1.2.3-beta.1';
    const normalized = normalizeCliHelpForSnapshot(input, { replaceVersion: true });

    expect(normalized).toBe('bwrb <version> and <version>');
  });
});
