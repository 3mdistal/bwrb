import { describe, it, expect } from 'vitest';
import { isBwrbBuiltinFrontmatterField, isBwrbReservedFrontmatterField } from '../../../src/lib/frontmatter/systemFields.js';

describe('system frontmatter fields', () => {
  it('classifies built-in fields', () => {
    expect(isBwrbBuiltinFrontmatterField('id')).toBe(true);
    expect(isBwrbBuiltinFrontmatterField('name')).toBe(true);
    expect(isBwrbBuiltinFrontmatterField('status')).toBe(false);
  });

  it('classifies reserved fields', () => {
    expect(isBwrbReservedFrontmatterField('id')).toBe(true);
    expect(isBwrbReservedFrontmatterField('name')).toBe(false);
  });
});
