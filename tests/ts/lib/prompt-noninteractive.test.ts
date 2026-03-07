import { afterEach, describe, it, expect } from 'vitest';
import { configurePromptMode, parseYesNoInput, promptConfirm } from '../../../src/lib/prompt.js';

describe('parseYesNoInput', () => {
  afterEach(() => {
    configurePromptMode({ forcedNonInteractive: false });
  });

  it('parses yes values', () => {
    expect(parseYesNoInput('y')).toBe(true);
    expect(parseYesNoInput('yes')).toBe(true);
    expect(parseYesNoInput(' Y ')).toBe(true);
    expect(parseYesNoInput('Yes')).toBe(true);
  });

  it('parses no values', () => {
    expect(parseYesNoInput('n')).toBe(false);
    expect(parseYesNoInput('no')).toBe(false);
    expect(parseYesNoInput(' N ')).toBe(false);
    expect(parseYesNoInput('No')).toBe(false);
  });

  it('returns null for other input', () => {
    expect(parseYesNoInput('')).toBeNull();
    expect(parseYesNoInput('maybe')).toBeNull();
    expect(parseYesNoInput('1')).toBeNull();
  });

  it('surfaces forced non-interactive prompt errors', async () => {
    configurePromptMode({
      forcedNonInteractive: true,
      bypassHint: 'Use --force to continue.',
    });

    await expect(promptConfirm('Continue?')).rejects.toThrow('Interactive prompts are disabled by --non-interactive; Use --force to continue.');
  });
});
