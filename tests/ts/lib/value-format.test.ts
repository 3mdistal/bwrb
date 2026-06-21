import { describe, it, expect } from 'vitest';
import { formatDisplayValue } from '../../../src/lib/value-format.js';

describe('formatDisplayValue', () => {
  describe('defaults', () => {
    it('renders undefined as empty string', () => {
      expect(formatDisplayValue(undefined)).toBe('');
    });

    it('renders null as empty string', () => {
      expect(formatDisplayValue(null)).toBe('');
    });

    it('joins arrays with ", "', () => {
      expect(formatDisplayValue(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('renders an empty array as empty string', () => {
      expect(formatDisplayValue([])).toBe('');
    });

    it('stringifies scalars', () => {
      expect(formatDisplayValue('hello')).toBe('hello');
      expect(formatDisplayValue(42)).toBe('42');
      expect(formatDisplayValue(0)).toBe('0');
      expect(formatDisplayValue(true)).toBe('true');
      expect(formatDisplayValue(false)).toBe('false');
    });
  });

  describe('custom empty placeholder', () => {
    it('uses the provided placeholder for undefined and null', () => {
      expect(formatDisplayValue(undefined, { empty: '(empty)' })).toBe('(empty)');
      expect(formatDisplayValue(null, { empty: '(empty)' })).toBe('(empty)');
    });
  });

  describe('bracketed array style', () => {
    it('wraps non-empty arrays in brackets', () => {
      expect(formatDisplayValue(['a', 'b'], { arrayStyle: 'bracketed' })).toBe('[a, b]');
    });

    it('renders an empty array as "[]"', () => {
      expect(formatDisplayValue([], { arrayStyle: 'bracketed' })).toBe('[]');
    });
  });

  describe('nullIsEmpty: false', () => {
    it('stringifies null instead of using the placeholder', () => {
      expect(formatDisplayValue(null, { empty: '(empty)', nullIsEmpty: false })).toBe('null');
    });

    it('still treats undefined as empty', () => {
      expect(formatDisplayValue(undefined, { empty: '(empty)', nullIsEmpty: false })).toBe('(empty)');
    });
  });

  // The following groups lock in the exact behavior of the four call sites this
  // helper replaced, so any future change to the shared helper that would alter
  // one of those outputs fails loudly.

  describe('parity: list output formatter (empty: "—", plain arrays)', () => {
    const fmt = (v: unknown) => formatDisplayValue(v, { empty: '—' });
    it('matches legacy behavior', () => {
      expect(fmt(undefined)).toBe('—');
      expect(fmt(null)).toBe('—');
      expect(fmt(['a', 'b'])).toBe('a, b');
      expect(fmt([])).toBe('');
      expect(fmt('x')).toBe('x');
      expect(fmt(5)).toBe('5');
    });
  });

  describe('parity: bulk change formatter (empty: "(empty)", bracketed arrays)', () => {
    const fmt = (v: unknown) => formatDisplayValue(v, { empty: '(empty)', arrayStyle: 'bracketed' });
    it('matches legacy behavior', () => {
      expect(fmt(undefined)).toBe('(empty)');
      expect(fmt(null)).toBe('(empty)');
      expect(fmt([])).toBe('[]');
      expect(fmt(['a', 'b'])).toBe('[a, b]');
      expect(fmt('x')).toBe('x');
    });
  });

  describe('parity: migration change formatter (empty: "(empty)", bracketed, null stringified)', () => {
    const fmt = (v: unknown) =>
      formatDisplayValue(v, { empty: '(empty)', arrayStyle: 'bracketed', nullIsEmpty: false });
    it('matches legacy behavior', () => {
      expect(fmt(undefined)).toBe('(empty)');
      expect(fmt(null)).toBe('null');
      expect(fmt([])).toBe('[]');
      expect(fmt(['a', 'b'])).toBe('[a, b]');
      expect(fmt('x')).toBe('x');
    });
  });

  describe('parity: template body formatter (empty: "", plain arrays)', () => {
    const fmt = (v: unknown) => formatDisplayValue(v);
    it('matches legacy behavior', () => {
      expect(fmt(null)).toBe('');
      expect(fmt(undefined)).toBe('');
      expect(fmt(['a', 'b'])).toBe('a, b');
      expect(fmt('x')).toBe('x');
    });
  });
});
