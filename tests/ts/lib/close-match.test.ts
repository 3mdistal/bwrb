import { describe, it, expect } from 'vitest';
import {
  closeMatches,
  closeMatchValues,
  closestMatch,
} from '../../../src/lib/close-match.js';

describe('closeMatches', () => {
  it('returns candidates within maxDistance sorted closest-first', () => {
    // 'taks' -> 'tasks' is one insertion (1); -> 'task' is a transposition (2).
    const result = closeMatches('taks', ['task', 'tasks', 'idea'], {
      maxDistance: 2,
    });
    expect(result).toEqual([
      { value: 'tasks', distance: 1 },
      { value: 'task', distance: 2 },
    ]);
  });

  it('excludes candidates beyond maxDistance', () => {
    expect(closeMatches('idea', ['objective'], { maxDistance: 3 })).toEqual([]);
  });

  it('is case-insensitive by default', () => {
    const result = closeMatches('TASK', ['Task'], { maxDistance: 2 });
    expect(result).toEqual([{ value: 'Task', distance: 0 }]);
  });

  it('honors caseInsensitive: false', () => {
    // 'Task' vs 'task' differs by one char when case-sensitive.
    const result = closeMatches('Task', ['task'], {
      maxDistance: 2,
      caseInsensitive: false,
    });
    expect(result).toEqual([{ value: 'task', distance: 1 }]);
  });

  it('excludes exact matches when excludeExact is set', () => {
    const result = closeMatches('task', ['task', 'tasks'], {
      maxDistance: 2,
      excludeExact: true,
    });
    expect(result).toEqual([{ value: 'tasks', distance: 1 }]);
  });

  it('keeps exact matches by default', () => {
    const result = closeMatches('task', ['task'], { maxDistance: 2 });
    expect(result).toEqual([{ value: 'task', distance: 0 }]);
  });

  it('preserves input order on distance ties (stable)', () => {
    // Both 'bbbb' and 'cccc' are distance 4 from 'aaaa'; first-encountered wins.
    const result = closeMatches('aaaa', ['bbbb', 'cccc'], { maxDistance: 4 });
    expect(result.map((m) => m.value)).toEqual(['bbbb', 'cccc']);
  });

  it('applies the limit after sorting', () => {
    // 'tasks' (dist 1) outranks 'task'/'taskz' (transpositions, dist 2).
    const result = closeMatches('taks', ['task', 'tasks', 'taskz'], {
      maxDistance: 2,
      limit: 1,
    });
    expect(result).toEqual([{ value: 'tasks', distance: 1 }]);
  });

  it('returns empty for an empty candidate list', () => {
    expect(closeMatches('task', [], { maxDistance: 3 })).toEqual([]);
  });

  it('accepts any iterable of candidates', () => {
    const candidates = new Set(['task', 'idea']);
    expect(closeMatchValues('taks', candidates, { maxDistance: 2 })).toEqual([
      'task',
    ]);
  });
});

describe('closeMatchValues', () => {
  it('returns only the candidate values', () => {
    expect(
      closeMatchValues('taks', ['task', 'tasks', 'idea'], { maxDistance: 2 })
    ).toEqual(['tasks', 'task']);
  });
});

describe('closestMatch', () => {
  it('returns the single closest candidate', () => {
    expect(
      closestMatch('taks', ['task', 'tasks', 'idea'], { maxDistance: 2 })
    ).toBe('tasks');
  });

  it('returns undefined when nothing is within range', () => {
    expect(
      closestMatch('zzzzzz', ['task', 'idea'], { maxDistance: 2 })
    ).toBeUndefined();
  });

  it('returns the first candidate on a distance tie', () => {
    expect(closestMatch('aaaa', ['bbbb', 'cccc'], { maxDistance: 4 })).toBe(
      'bbbb'
    );
  });
});
