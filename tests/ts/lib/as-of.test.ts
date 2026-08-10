import { describe, expect, it } from 'vitest';
import { resolveAsOf } from '../../../src/lib/as-of.js';

describe('resolveAsOf', () => {
  it('accepts a complete calendar-valid ISO date', () => {
    expect(resolveAsOf('2026-08-10')).toBe('2026-08-10');
  });

  it('rejects partial and impossible dates', () => {
    expect(() => resolveAsOf('2026-08')).toThrow('expected a valid YYYY-MM-DD');
    expect(() => resolveAsOf('2026-02-30')).toThrow('expected a valid YYYY-MM-DD');
  });
});
