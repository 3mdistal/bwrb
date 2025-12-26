import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  parseFilters,
  matchesFilter,
  matchesAllFilters,
  validateFieldForType,
  validateFilterValues,
  validateFilters,
} from '../../../src/lib/query.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import type { Schema } from '../../../src/types/schema.js';

describe('query', () => {
  let vaultDir: string;
  let schema: Schema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('parseFilters', () => {
    it('should parse equality filter', () => {
      const filters = parseFilters(['--status=raw']);
      expect(filters).toHaveLength(1);
      expect(filters[0]).toEqual({
        field: 'status',
        operator: 'eq',
        values: ['raw'],
      });
    });

    it('should parse negation filter', () => {
      const filters = parseFilters(['--status!=settled']);
      expect(filters).toHaveLength(1);
      expect(filters[0]).toEqual({
        field: 'status',
        operator: 'neq',
        values: ['settled'],
      });
    });

    it('should parse multiple values', () => {
      const filters = parseFilters(['--status=raw,backlog']);
      expect(filters[0]?.values).toEqual(['raw', 'backlog']);
    });

    it('should parse empty value filter', () => {
      const filters = parseFilters(['--deadline=']);
      expect(filters[0]).toEqual({
        field: 'deadline',
        operator: 'eq',
        values: [],
      });
    });

    it('should ignore non-filter arguments', () => {
      const filters = parseFilters(['idea', '--status=raw', 'extra']);
      expect(filters).toHaveLength(1);
    });
  });

  describe('matchesFilter', () => {
    it('should match equality filter', () => {
      const filter = { field: 'status', operator: 'eq' as const, values: ['raw'] };
      expect(matchesFilter('raw', filter)).toBe(true);
      expect(matchesFilter('backlog', filter)).toBe(false);
    });

    it('should match negation filter', () => {
      const filter = { field: 'status', operator: 'neq' as const, values: ['settled'] };
      expect(matchesFilter('raw', filter)).toBe(true);
      expect(matchesFilter('settled', filter)).toBe(false);
    });

    it('should match multiple values (OR)', () => {
      const filter = { field: 'status', operator: 'eq' as const, values: ['raw', 'backlog'] };
      expect(matchesFilter('raw', filter)).toBe(true);
      expect(matchesFilter('backlog', filter)).toBe(true);
      expect(matchesFilter('settled', filter)).toBe(false);
    });

    it('should handle empty filter (missing field check)', () => {
      const filter = { field: 'deadline', operator: 'eq' as const, values: [] };
      expect(matchesFilter(undefined, filter)).toBe(true);
      expect(matchesFilter('2024-01-15', filter)).toBe(false);
    });

    it('should handle non-empty filter (exists check)', () => {
      const filter = { field: 'deadline', operator: 'neq' as const, values: [] };
      expect(matchesFilter('2024-01-15', filter)).toBe(true);
      expect(matchesFilter(undefined, filter)).toBe(false);
    });
  });

  describe('matchesAllFilters', () => {
    it('should match all filters', () => {
      const frontmatter = { type: 'idea', status: 'raw', priority: 'high' };
      const filters = [
        { field: 'status', operator: 'eq' as const, values: ['raw'] },
        { field: 'priority', operator: 'eq' as const, values: ['high'] },
      ];
      expect(matchesAllFilters(frontmatter, filters)).toBe(true);
    });

    it('should fail if any filter does not match', () => {
      const frontmatter = { type: 'idea', status: 'raw', priority: 'low' };
      const filters = [
        { field: 'status', operator: 'eq' as const, values: ['raw'] },
        { field: 'priority', operator: 'eq' as const, values: ['high'] },
      ];
      expect(matchesAllFilters(frontmatter, filters)).toBe(false);
    });
  });

  describe('validateFieldForType', () => {
    it('should accept valid fields', () => {
      const result = validateFieldForType(schema, 'idea', 'status');
      expect(result.valid).toBe(true);
    });

    it('should reject unknown fields', () => {
      const result = validateFieldForType(schema, 'idea', 'unknown');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown field');
    });
  });

  describe('validateFilterValues', () => {
    it('should accept valid enum values', () => {
      const result = validateFilterValues(schema, 'idea', 'status', ['raw', 'backlog']);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid enum values', () => {
      const result = validateFilterValues(schema, 'idea', 'status', ['invalid']);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid value');
    });

    it('should accept any value for non-enum fields', () => {
      const result = validateFilterValues(schema, 'objective/task', 'deadline', ['anything']);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateFilters', () => {
    it('should validate all filters', () => {
      const filters = [
        { field: 'status', operator: 'eq' as const, values: ['raw'] },
      ];
      const result = validateFilters(schema, 'idea', filters);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should collect all errors', () => {
      const filters = [
        { field: 'unknown', operator: 'eq' as const, values: ['value'] },
        { field: 'status', operator: 'eq' as const, values: ['invalid'] },
      ];
      const result = validateFilters(schema, 'idea', filters);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
