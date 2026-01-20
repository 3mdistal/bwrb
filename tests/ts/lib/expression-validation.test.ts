import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LoadedSchema } from '../../../src/types/schema.js';
import {
  extractFieldComparisons,
  validateWhereExpressions,
  formatWhereValidationErrors,
} from '../../../src/lib/expression-validation.js';
import { parseExpression } from '../../../src/lib/expression.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';

describe('expression-validation', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('extractFieldComparisons', () => {
    it('extracts simple equality comparison', () => {
      const expr = parseExpression("status == 'done'");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '==', value: 'done' },
      ]);
    });

    it('extracts reversed equality comparison', () => {
      const expr = parseExpression("'done' == status");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '==', value: 'done' },
      ]);
    });

    it('extracts inequality comparison', () => {
      const expr = parseExpression("status != 'pending'");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '!=', value: 'pending' },
      ]);
    });

    it('extracts multiple comparisons from AND expression', () => {
      const expr = parseExpression("status == 'active' && priority == 'high'");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '==', value: 'active' },
        { field: 'priority', operator: '==', value: 'high' },
      ]);
    });

    it('extracts comparisons from OR expression', () => {
      const expr = parseExpression("status == 'done' || status == 'settled'");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '==', value: 'done' },
        { field: 'status', operator: '==', value: 'settled' },
      ]);
    });

    it('extracts comparisons from NOT expression', () => {
      const expr = parseExpression("!(status == 'done')");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'status', operator: '==', value: 'done' },
      ]);
    });

    it('extracts contains function call', () => {
      const expr = parseExpression("contains(tags, 'urgent')");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'tags', operator: 'contains', value: 'urgent' },
      ]);
    });

    it('extracts hasTag function call', () => {
      const expr = parseExpression("hasTag('urgent')");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'tags', operator: 'hasTag', value: 'urgent' },
      ]);
    });

    it('extracts numeric comparison values', () => {
      const expr = parseExpression("count == 5");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([
        { field: 'count', operator: '==', value: '5' },
      ]);
    });

    it('handles complex nested expressions', () => {
      const expr = parseExpression("(status == 'active' && priority == 'high') || status == 'urgent'");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toHaveLength(3);
      expect(comparisons).toContainEqual({ field: 'status', operator: '==', value: 'active' });
      expect(comparisons).toContainEqual({ field: 'priority', operator: '==', value: 'high' });
      expect(comparisons).toContainEqual({ field: 'status', operator: '==', value: 'urgent' });
    });

    it('ignores identifier vs identifier comparisons', () => {
      const expr = parseExpression("a == b");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([]);
    });

    it('ignores function calls without field/value pattern', () => {
      const expr = parseExpression("isEmpty(status)");
      const comparisons = extractFieldComparisons(expr);
      expect(comparisons).toEqual([]);
    });
  });

  describe('validateWhereExpressions', () => {
    it('passes for valid select value', () => {
      // task.status has options: raw, backlog, in-flight, settled
      const result = validateWhereExpressions(
        ["status == 'backlog'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes for all valid options', () => {
      const options = ['raw', 'backlog', 'in-flight', 'settled'];
      for (const option of options) {
        const result = validateWhereExpressions(
          [`status == '${option}'`],
          schema,
          'task'
        );
        expect(result.valid).toBe(true);
      }
    });

    it('fails for invalid select value', () => {
      const result = validateWhereExpressions(
        ["status == 'invalid'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.field).toBe('status');
      expect(result.errors[0]!.value).toBe('invalid');
      expect(result.errors[0]!.validOptions).toContain('backlog');
    });

    it('suggests similar option for typo', () => {
      const result = validateWhereExpressions(
        ["status == 'bcklog'"],  // typo for 'backlog'
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.suggestion).toBe('backlog');
    });

    it('skips validation for non-select fields', () => {
      // deadline is a date field, not select
      const result = validateWhereExpressions(
        ["deadline == '2024-01-01'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(true);
    });

    it('errors on unknown fields', () => {
      // unknown_field is not in the schema - should error in strict mode
      const result = validateWhereExpressions(
        ["unknown_field == 'value'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.field).toBe('unknown_field');
      expect(result.errors[0]!.message).toContain('Unknown field');
    });

    it('suggests similar field names for typos in field names', () => {
      // statsu is a typo for 'status'
      const result = validateWhereExpressions(
        ["statsu == 'backlog'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('statsu');
      expect(result.errors[0]!.suggestion).toBe('status');
    });

    it('validates multiple expressions', () => {
      const result = validateWhereExpressions(
        ["status == 'invalid1'", "status == 'invalid2'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('validates idea type with priority field', () => {
      // idea.priority has options: low, medium, high
      const result = validateWhereExpressions(
        ["priority == 'highest'"],
        schema,
        'idea'
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.validOptions).toEqual(['low', 'medium', 'high']);
    });

    it('handles complex expressions with valid values', () => {
      const result = validateWhereExpressions(
        ["status == 'backlog' && status != 'settled'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(true);
    });

    it('catches invalid value in complex expression', () => {
      const result = validateWhereExpressions(
        ["status == 'backlog' || status == 'invalid'"],
        schema,
        'task'
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.value).toBe('invalid');
    });

    it('handles parse errors gracefully', () => {
      const result = validateWhereExpressions(
        ["status =="],  // invalid syntax
        schema,
        'task'
      );
      // Should not throw, just skip unparseable expressions
      expect(result.valid).toBe(true);
    });
  });

  describe('formatWhereValidationErrors', () => {
    it('formats single error', () => {
      const errors = [{
        expression: "status == 'invalid'",
        field: 'status',
        value: 'invalid',
        message: "Invalid value 'invalid' for field 'status'",
        validOptions: ['raw', 'backlog', 'in-flight', 'settled'],
      }];
      const formatted = formatWhereValidationErrors(errors);
      expect(formatted).toContain("Invalid value 'invalid' for field 'status'");
      expect(formatted).toContain('Valid options:');
      expect(formatted).toContain('backlog');
    });

    it('formats single error with suggestion', () => {
      const errors = [{
        expression: "status == 'bcklog'",
        field: 'status',
        value: 'bcklog',
        message: "Invalid value 'bcklog' for field 'status'",
        validOptions: ['raw', 'backlog', 'in-flight', 'settled'],
        suggestion: 'backlog',
      }];
      const formatted = formatWhereValidationErrors(errors);
      expect(formatted).toContain("Did you mean 'backlog'?");
    });

    it('formats multiple errors', () => {
      const errors = [
        {
          expression: "status == 'invalid1'",
          field: 'status',
          value: 'invalid1',
          message: "Invalid value 'invalid1' for field 'status'",
          validOptions: ['raw', 'backlog'],
        },
        {
          expression: "priority == 'invalid2'",
          field: 'priority',
          value: 'invalid2',
          message: "Invalid value 'invalid2' for field 'priority'",
          validOptions: ['low', 'high'],
        },
      ];
      const formatted = formatWhereValidationErrors(errors);
      expect(formatted).toContain('Expression validation errors:');
      expect(formatted).toContain('invalid1');
      expect(formatted).toContain('invalid2');
    });

    it('truncates long option lists for multiple errors', () => {
      // Truncation only applies when there are multiple errors (to save space)
      const errors = [
        {
          expression: "status == 'x'",
          field: 'status',
          value: 'x',
          message: "Invalid value 'x' for field 'status'",
          validOptions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],  // 8 options
        },
        {
          expression: "priority == 'y'",
          field: 'priority',
          value: 'y',
          message: "Invalid value 'y' for field 'priority'",
          validOptions: ['low', 'high'],
        },
      ];
      const formatted = formatWhereValidationErrors(errors);
      expect(formatted).toContain('8 total');
    });

    it('shows all options for single error', () => {
      // Single error shows all options (user needs to see valid choices)
      const errors = [{
        expression: "status == 'x'",
        field: 'status',
        value: 'x',
        message: "Invalid value 'x' for field 'status'",
        validOptions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      }];
      const formatted = formatWhereValidationErrors(errors);
      expect(formatted).toContain('a, b, c, d, e, f, g, h');
    });

    it('returns empty string for no errors', () => {
      expect(formatWhereValidationErrors([])).toBe('');
    });
  });
});
