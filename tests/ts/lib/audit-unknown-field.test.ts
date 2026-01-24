import { describe, it, expect } from 'vitest';
import type { Field } from '../../../src/types/schema.js';
import {
  getSimilarFieldCandidates,
} from '../../../src/lib/audit/unknown-field.js';

describe('unknown field helpers', () => {
  it('prefers exact normalized matches over singular/plural variants', () => {
    const fields: Record<string, Field> = {
      deadline: { prompt: 'text' },
      deadlines: { prompt: 'text' },
    };

    const candidates = getSimilarFieldCandidates('dead_line', fields, '2026-01-01', 3);

    expect(candidates[0]?.field).toBe('deadline');
    expect(candidates[1]?.field).toBe('deadlines');
  });

  it('includes singular/plural matches when shape is compatible', () => {
    const fields: Record<string, Field> = {
      tags: { prompt: 'list' },
    };

    const candidates = getSimilarFieldCandidates('tag', fields, ['foo'], 3);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.field).toBe('tags');
    expect(candidates[0]?.typeMismatch).toBe(false);
  });
});
