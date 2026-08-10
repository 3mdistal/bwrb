import { describe, expect, it } from 'vitest';
import { parseNumberBounds } from '../../../src/commands/schema/helpers/prompts.js';

describe('schema number bounds', () => {
  it('preserves explicit bounds and blank unknowns', () => {
    expect(parseNumberBounds('0', '4')).toEqual({ minimum: 0, maximum: 4 });
    expect(parseNumberBounds('1', '')).toEqual({ minimum: 1, maximum: undefined });
  });

  it('rejects non-finite and reversed bounds', () => {
    expect(() => parseNumberBounds('nope', '4')).toThrow('Minimum must be a finite number');
    expect(() => parseNumberBounds('5', '4')).toThrow('Minimum cannot be greater than maximum');
  });
});
