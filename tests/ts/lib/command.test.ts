import { describe, it, expect, vi } from 'vitest';
import { getGlobalOpts, resolveGlobalPickerMode } from '../../../src/lib/command.js';
import type { Command } from 'commander';

describe('getGlobalOpts', () => {
  it('should return empty object when no options are set', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({}),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    expect(result).toEqual({});
  });

  it('should return vault when set', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({ vault: '/path/to/vault' }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    expect(result).toEqual({ vault: '/path/to/vault' });
  });

  it('should return output when set', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({ output: 'json' }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    expect(result).toEqual({ output: 'json' });
  });

  it('should return both vault and output when both are set', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({
        vault: '/my/vault',
        output: 'json',
      }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    expect(result).toEqual({
      vault: '/my/vault',
      output: 'json',
    });
  });

  it('should not include undefined values in result', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({
        vault: undefined,
        output: undefined,
        otherOption: 'value',
      }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    // Result should not have vault or output properties at all
    expect(result).toEqual({});
    expect('vault' in result).toBe(false);
    expect('output' in result).toBe(false);
  });

  it('should only include string values for vault and output', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({
        vault: 123, // Wrong type
        output: true, // Wrong type
      }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    // Non-string values should be excluded
    expect(result).toEqual({});
  });

  it('should ignore other options not in GlobalOptions', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({
        vault: '/my/vault',
        type: 'task',
        where: ['status=active'],
        execute: true,
      }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    // Only vault should be in result
    expect(result).toEqual({ vault: '/my/vault' });
    expect('type' in result).toBe(false);
  });

  it('should return nonInteractive when set', () => {
    const mockCmd = {
      optsWithGlobals: vi.fn().mockReturnValue({
        nonInteractive: true,
      }),
    } as unknown as Command;

    const result = getGlobalOpts(mockCmd);

    expect(result).toEqual({ nonInteractive: true });
  });

  it('should force picker mode to none when nonInteractive is set', () => {
    const result = resolveGlobalPickerMode('fzf', { nonInteractive: true }, 'auto');

    expect(result).toBe('none');
  });

  it('should preserve requested picker mode when nonInteractive is not set', () => {
    const result = resolveGlobalPickerMode('numbered', {}, 'auto');

    expect(result).toBe('numbered');
  });
});
