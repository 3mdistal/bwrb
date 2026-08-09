import { describe, expect, it } from 'vitest';
import {
  FILENAME_BASE_MAX_BYTES,
  FILENAME_COMPONENT_MAX_BYTES,
  isFilenameBaseSafe,
  isWindowsReservedBasename,
  sanitizeFilenameBase,
} from '../../../src/lib/filename.js';

describe('filename safety', () => {
  it('leaves an already safe basename untouched', () => {
    expect(sanitizeFilenameBase('Project notes')).toEqual({ sanitized: 'Project notes' });
    expect(isFilenameBaseSafe('Project notes')).toBe(true);
  });

  it('normalizes invalid characters and records the complete original title', () => {
    const result = sanitizeFilenameBase('  A/B: C?  ');

    expect(result).toEqual({
      sanitized: 'AB C',
      transformation: {
        original: '  A/B: C?  ',
        sanitized: 'AB C',
        filename: 'AB C.md',
      },
    });
  });

  it('normalizes Windows reserved basenames and trailing dots or spaces', () => {
    expect(sanitizeFilenameBase('CON. ')).toMatchObject({ sanitized: '_CON' });
    expect(sanitizeFilenameBase('notes.  ')).toMatchObject({ sanitized: 'notes' });
    expect(isWindowsReservedBasename('LPT1.md')).toBe(true);
    expect(isWindowsReservedBasename('ordinary.md')).toBe(false);
    expect(isFilenameBaseSafe('CON')).toBe(false);
  });

  it('keeps an ASCII filename and its extension inside the component budget', () => {
    const result = sanitizeFilenameBase('a'.repeat(FILENAME_BASE_MAX_BYTES + 40));

    expect(Buffer.byteLength(result.sanitized, 'utf8')).toBe(FILENAME_BASE_MAX_BYTES);
    expect(Buffer.byteLength(`${result.sanitized}.md`, 'utf8')).toBe(FILENAME_COMPONENT_MAX_BYTES);
    expect(result.transformation?.original).toBe('a'.repeat(FILENAME_BASE_MAX_BYTES + 40));
  });

  it('truncates multibyte text at code-point boundaries', () => {
    const original = '🙂'.repeat(100);
    const result = sanitizeFilenameBase(original);

    expect(Buffer.byteLength(result.sanitized, 'utf8')).toBeLessThanOrEqual(FILENAME_BASE_MAX_BYTES);
    expect(Buffer.byteLength(`${result.sanitized}.md`, 'utf8')).toBeLessThanOrEqual(FILENAME_COMPONENT_MAX_BYTES);
    expect(result.sanitized).toBe(`${'🙂'.repeat(42)}--${result.sanitized.slice(-16)}`);
    expect(result.transformation?.original).toBe(original);
  });

  it('uses a stable digest suffix that distinguishes different long titles', () => {
    const first = `${'a'.repeat(FILENAME_BASE_MAX_BYTES + 30)} one`;
    const second = `${'a'.repeat(FILENAME_BASE_MAX_BYTES + 30)} two`;

    const firstResult = sanitizeFilenameBase(first);
    const repeatedFirstResult = sanitizeFilenameBase(first);
    const secondResult = sanitizeFilenameBase(second);

    expect(firstResult.sanitized).toBe(repeatedFirstResult.sanitized);
    expect(firstResult.sanitized).not.toBe(secondResult.sanitized);
    expect(firstResult.sanitized).toMatch(/--[a-f0-9]{16}$/);
    expect(firstResult.transformation?.filename).toBe(`${firstResult.sanitized}.md`);
  });
});
