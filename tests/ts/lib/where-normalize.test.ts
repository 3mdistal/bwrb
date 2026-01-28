import { describe, it, expect } from 'vitest';
import { normalizeWhereExpression } from '../../../src/lib/where-normalize.js';

describe('where-normalize', () => {
  it('rewrites hyphenated keys that match known fields', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression(
      "creation-date == '2026-01-28'",
      knownKeys
    );

    expect(normalized).toBe("__frontmatter['creation-date'] == '2026-01-28'");
  });

  it('rewrites without whitespace around operators', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression(
      'creation-date=="2026-01-28"',
      knownKeys
    );

    expect(normalized).toBe("__frontmatter['creation-date']==\"2026-01-28\"");
  });

  it('preserves arithmetic when key is unknown', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression('priority-1 < 3', knownKeys);

    expect(normalized).toBe('priority-1 < 3');
  });

  it('preserves subtraction when no-space left operand exists', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression('a-creation-date', knownKeys);

    expect(normalized).toBe('a-creation-date');
  });

  it('rewrites when a hyphenated key is followed by subtraction', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression('creation-date-1 < 3', knownKeys);

    expect(normalized).toBe("__frontmatter['creation-date']-1 < 3");
  });

  it('does not rewrite inside string literals', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression(
      "title == 'creation-date'",
      knownKeys
    );

    expect(normalized).toBe("title == 'creation-date'");
  });

  it('rewrites hyphenated keys inside function calls', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression('isEmpty(creation-date)', knownKeys);

    expect(normalized).toBe("isEmpty(__frontmatter['creation-date'])");
  });

  it('prefers longest matching keys', () => {
    const knownKeys = new Set(['creation-date', 'creation-date-long']);
    const normalized = normalizeWhereExpression(
      "creation-date-long == '2026-01-28'",
      knownKeys
    );

    expect(normalized).toBe("__frontmatter['creation-date-long'] == '2026-01-28'");
  });

  it('escapes single quotes in keys', () => {
    const knownKeys = new Set(["o'clock-date"]);
    const normalized = normalizeWhereExpression(
      "o'clock-date == '2026-01-28'",
      knownKeys
    );

    expect(normalized).toBe("__frontmatter['o\\'clock-date'] == '2026-01-28'");
  });

  it('does not rewrite after dot access', () => {
    const knownKeys = new Set(['creation-date']);
    const normalized = normalizeWhereExpression(
      "metadata.creation-date == '2026-01-28'",
      knownKeys
    );

    expect(normalized).toBe("metadata.creation-date == '2026-01-28'");
  });
});
