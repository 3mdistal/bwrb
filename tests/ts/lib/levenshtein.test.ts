import { describe, it, expect } from 'vitest';
import { levenshteinDistance } from '../../../src/lib/levenshtein.js';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('test', 'test')).toBe(0);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('returns string length when one side is empty', () => {
    expect(levenshteinDistance('test', '')).toBe(4);
    expect(levenshteinDistance('', 'test')).toBe(4);
  });

  it('counts a single edit', () => {
    expect(levenshteinDistance('test', 'tast')).toBe(1); // substitution
    expect(levenshteinDistance('test', 'tests')).toBe(1); // insertion
    expect(levenshteinDistance('tests', 'test')).toBe(1); // deletion
  });

  it('counts a transposition as two edits', () => {
    // Classic Levenshtein has no transposition op, so a swap costs 2.
    expect(levenshteinDistance('ab', 'ba')).toBe(2);
  });

  it('handles multiple edits', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(
      levenshteinDistance('sitting', 'kitten')
    );
  });

  it('is case-sensitive', () => {
    expect(levenshteinDistance('Test', 'test')).toBe(1);
  });
});
