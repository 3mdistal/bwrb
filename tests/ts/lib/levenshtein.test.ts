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

/**
 * Reference implementation: the original full O(n·m) matrix version this
 * function replaced. The rolling-buffer implementation must return byte-for-byte
 * identical distances for every input pair. Kept inline so the equivalence test
 * is self-contained.
 */
function referenceLevenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  const matrix: number[][] = Array.from({ length: aLen + 1 }, () =>
    Array.from({ length: bLen + 1 }, () => 0)
  );

  for (let i = 0; i <= aLen; i++) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }

  return matrix[aLen]![bLen]!;
}

describe('levenshteinDistance equivalence with full-matrix reference', () => {
  it('matches the reference on curated edge cases', () => {
    const pairs: Array<[string, string]> = [
      ['', ''],
      ['', 'a'],
      ['a', ''],
      ['abc', 'abc'],
      ['kitten', 'sitting'],
      ['ab', 'ba'], // transposition
      ['Test', 'test'], // case
      ['a', 'aaaaaaaaaa'], // very different lengths
      ['flaw', 'lawn'],
      ['gumbo', 'gambol'],
      // unicode / surrogate pairs (emoji are UTF-16 surrogate pairs)
      ['café', 'cafe'],
      ['😀', '😀'],
      ['😀😁', '😁😀'],
      ['naïve', 'naive'],
      ['日本語', '日本'],
      ['👨‍👩‍👧', '👨‍👩‍👦'], // ZWJ sequences
    ];
    for (const [a, b] of pairs) {
      expect(levenshteinDistance(a, b)).toBe(referenceLevenshtein(a, b));
    }
  });

  it('matches the reference on many random pairs (fuzz)', () => {
    // Deterministic PRNG so failures are reproducible.
    let seed = 0x12345678;
    const rand = (): number => {
      // xorshift32
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };

    // Mix of ASCII, accented, CJK, and emoji (surrogate pairs) characters.
    const alphabet = [
      'a',
      'b',
      'c',
      'A',
      'B',
      '1',
      ' ',
      '-',
      'é',
      'ñ',
      '日',
      '本',
      '😀',
      '😁',
      '🎉',
    ];

    const makeString = (maxLen: number): string => {
      const len = Math.floor(rand() * (maxLen + 1));
      let s = '';
      for (let i = 0; i < len; i++) {
        s += alphabet[Math.floor(rand() * alphabet.length)];
      }
      return s;
    };

    for (let n = 0; n < 2000; n++) {
      // Vary length ranges, including very asymmetric pairs.
      const a = makeString(rand() < 0.2 ? 30 : 8);
      const b = makeString(rand() < 0.2 ? 30 : 8);
      const got = levenshteinDistance(a, b);
      const want = referenceLevenshtein(a, b);
      expect(got, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toBe(want);
    }
  });

  it('is symmetric on random pairs (operand-swap invariance)', () => {
    let seed = 0x0badf00d;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };
    const chars = 'abcABC日😀'.match(/./gu) ?? [];
    const make = (): string => {
      const len = Math.floor(rand() * 12);
      let s = '';
      for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
      return s;
    };
    for (let n = 0; n < 500; n++) {
      const a = make();
      const b = make();
      expect(levenshteinDistance(a, b)).toBe(levenshteinDistance(b, a));
    }
  });
});
