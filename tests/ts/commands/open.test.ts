import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppMode, resolveAppMode } from '../../../src/commands/open.js';
import type { ResolvedConfig } from '../../../src/types/schema.js';

describe('shared app-mode helpers', () => {
  const makeConfig = (openWith: 'system' | 'editor' | 'visual' | 'obsidian' = 'system'): ResolvedConfig => ({
    linkFormat: 'wikilink',
    openWith,
    editor: undefined,
    visual: undefined,
    obsidianVault: undefined,
  });

  beforeAll(() => { delete process.env.BWRB_DEFAULT_APP; });
  afterAll(() => { delete process.env.BWRB_DEFAULT_APP; });

  it('parses supported modes and rejects invalid values', () => {
    expect(parseAppMode(undefined)).toBeUndefined();
    expect(parseAppMode('Editor')).toBe('editor');
    expect(parseAppMode('print')).toBe('print');
    expect(() => parseAppMode('sublime')).toThrow('Invalid app mode');
  });

  it('uses explicit mode, then environment, then configured default', () => {
    expect(resolveAppMode('editor', makeConfig('obsidian'))).toBe('editor');
    expect(resolveAppMode(undefined, makeConfig('obsidian'))).toBe('obsidian');
    process.env.BWRB_DEFAULT_APP = 'print';
    expect(resolveAppMode(undefined, makeConfig('system'))).toBe('print');
    delete process.env.BWRB_DEFAULT_APP;
  });
});
