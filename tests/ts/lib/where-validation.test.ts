import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LoadedSchema } from '../../../src/types/schema.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { validateCliWhere } from '../../../src/lib/where-validation.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';

describe('where-validation', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('is strict when type is provided', () => {
    const result = validateCliWhere({
      schema,
      typePath: 'task',
      whereExpressions: ["status == 'not-a-valid-status'"],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe('status');
  });

  it('is permissive when type is not provided', () => {
    const result = validateCliWhere({
      schema,
      whereExpressions: ["unknown_field == 'value'"],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns ok for empty where expressions', () => {
    const result = validateCliWhere({
      schema,
      typePath: 'task',
      whereExpressions: [],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
