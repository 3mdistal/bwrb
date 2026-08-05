import { describe, expect, it } from 'vitest';
import { deadlinePressure, PRIORITY_ALGORITHM, suggestPriorities } from '../../../src/lib/priority.js';

describe('priority scorer', () => {
  it('applies hard and soft deadline pressure boundaries', () => {
    expect(deadlinePressure('2026-08-05', 'hard', '2026-08-05')).toBe(4);
    expect(deadlinePressure('2026-08-08', 'hard', '2026-08-05')).toBe(3);
    expect(deadlinePressure('2026-08-12', 'soft', '2026-08-05')).toBe(1);
    expect(deadlinePressure('2026-08-05', null, '2026-08-05')).toBe(3);
    expect(deadlinePressure('2026-09-05', 'hard', '2026-08-05')).toBe(0);
  });

  it('uses an explicit neutral baseline for unknown inputs and stable ID ties', () => {
    const suggestions = suggestPriorities([
      { id: 'b', importance: null, excitement: null, revision: 'e' },
      { id: 'a', importance: null, excitement: null, revision: 'e' },
    ], '2026-08-05');
    expect(suggestions.map((item) => item.id)).toEqual(['a', 'b']);
    expect(suggestions[0]).toMatchObject({ score: 10, unknown: ['importance', 'excitement'], neutralBaseline: { importance: 2, excitement: 2 }, suggestedRank: 1 });
    expect(suggestions[0]?.staleReasons).toContain('algorithm');
  });

  it('preserves an approved rank only as a tie breaker and detects fresh metadata', () => {
    const [item] = suggestPriorities([{ id: 'a', importance: 4, excitement: 4, priorRank: 9, effectiveRank: 9, algorithm: PRIORITY_ALGORITHM, asOf: '2026-08-05', basisRevision: 'e', reviewed: '2026-08-05', revision: 'e' }], '2026-08-05');
    expect(item?.effectiveRank).toBe(9);
    expect(item?.staleReasons).toEqual([]);
  });

  it('reopens stale subjective values without changing effective rank', () => {
    const [item] = suggestPriorities([{ id: 'a', importance: 4, excitement: 4, priorRank: 2, effectiveRank: 2, algorithm: PRIORITY_ALGORITHM, asOf: '2026-08-05', basisRevision: 'e', reviewed: '2026-06-01', revision: 'e' }], '2026-08-05');
    expect(item?.effectiveRank).toBe(2);
    expect(item?.staleReasons).toContain('review');
  });
});
