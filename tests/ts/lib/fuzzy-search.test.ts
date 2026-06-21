import { describe, it, expect } from 'vitest';
import { similarityScore } from '../../../src/lib/fuzzy-search.js';

describe('similarityScore', () => {
  it('scores identical strings as 1', () => {
    expect(similarityScore('Steve Yegge', 'Steve Yegge')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(similarityScore('steve yegge', 'Steve Yegge')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(similarityScore('', 'Steve')).toBe(0);
    expect(similarityScore('Steve', '')).toBe(0);
  });

  it('scores a one-char typo highly but below exact', () => {
    const score = similarityScore('Stevey', 'Stevy');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('floors substring containment to a usable score', () => {
    // "Steve" is far from "Steve Yegge" by raw edit distance ratio, but
    // containment should keep it above the 0.5 default threshold.
    expect(similarityScore('Steve', 'Steve Yegge')).toBeGreaterThanOrEqual(0.6);
  });

  it('scores unrelated strings low', () => {
    expect(similarityScore('Quetzalcoatl', 'Steve')).toBeLessThan(0.3);
  });

  it('ranks a closer candidate above a farther one', () => {
    const close = similarityScore('Detrministic', 'Deterministic');
    const far = similarityScore('Detrministic', 'Margaret');
    expect(close).toBeGreaterThan(far);
  });
});
