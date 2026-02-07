import { describe, it, expect } from 'vitest';
import { parseYesNoInput } from '../../../src/lib/prompt.js';

describe('parseYesNoInput', () => {
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
});
