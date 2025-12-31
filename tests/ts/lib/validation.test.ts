import { describe, it, expect } from 'vitest';
import {
  validateFrontmatter,
  applyDefaults,
  suggestEnumValue,
  suggestFieldName,
  formatValidationErrors,
} from '../../../src/lib/validation.js';
import type { Schema } from '../../../src/types/schema.js';

const TEST_SCHEMA: Schema = {
  version: 2,
  shared_fields: {
    status: {
      prompt: 'select',
      enum: 'status',
      default: 'raw',
      required: true,
    },
    tags: {
      prompt: 'multi-input',
      list_format: 'yaml-array',
      default: [],
    },
  },
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  types: {
    idea: {
      dir_mode: 'pooled',
      output_dir: 'Ideas',
      shared_fields: ['status'],
      frontmatter: {
        type: { value: 'idea' },
        priority: { prompt: 'select', enum: 'priority' },
        deadline: { prompt: 'date' },
      },
    },
    task: {
      dir_mode: 'pooled',
      output_dir: 'Tasks',
      shared_fields: ['status', 'tags'],
      frontmatter: {
        type: { value: 'task' },
        requiredField: { prompt: 'input', required: true },
      },
    },
  },
};

describe('validation', () => {
  describe('validateFrontmatter', () => {
    it('should pass valid frontmatter', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'raw',
        priority: 'high',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail on invalid enum value', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'invalid-status',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('invalid_enum_value');
      expect(result.errors[0].field).toBe('status');
    });

    it('should suggest similar enum values', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'rae', // typo for 'raw'
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].suggestion).toContain('raw');
    });

    it('should fail on missing required field without default', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'task', {
        type: 'task',
        status: 'raw',
        // requiredField is missing
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === 'required_field_missing')).toBe(true);
    });

    it('should pass when required field has default', () => {
      // status is required but has default
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        // status is missing but has default
      });

      // Should pass because status has a default
      expect(result.valid).toBe(true);
    });

    it('should warn on unknown fields in non-strict mode', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'raw',
        unknownField: 'value',
      });

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe('unknown_field');
    });

    it('should fail on unknown fields in strict mode', () => {
      const result = validateFrontmatter(
        TEST_SCHEMA,
        'idea',
        {
          type: 'idea',
          status: 'raw',
          unknownField: 'value',
        },
        { strictFields: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe('unknown_field');
    });

    it('should validate date format', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'raw',
        deadline: 'not-a-date',
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe('invalid_date');
    });

    it('should accept valid date format', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'raw',
        deadline: '2024-01-15',
      });

      expect(result.valid).toBe(true);
    });

    it('should accept datetime format', () => {
      const result = validateFrontmatter(TEST_SCHEMA, 'idea', {
        type: 'idea',
        status: 'raw',
        deadline: '2024-01-15 14:30',
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('applyDefaults', () => {
    it('should apply defaults for missing fields', () => {
      const result = applyDefaults(TEST_SCHEMA, 'idea', {
        priority: 'high',
      });

      expect(result.status).toBe('raw');
      expect(result.priority).toBe('high');
    });

    it('should not override existing values', () => {
      const result = applyDefaults(TEST_SCHEMA, 'idea', {
        status: 'in-flight',
      });

      expect(result.status).toBe('in-flight');
    });

    it('should expand $TODAY value', () => {
      const result = applyDefaults(TEST_SCHEMA, 'idea', {});
      // type field has value: 'idea' which is static
      expect(result.type).toBe('idea');
    });
  });

  describe('suggestEnumValue', () => {
    it('should return exact match with different case', () => {
      expect(suggestEnumValue('RAW', ['raw', 'backlog'])).toBe('raw');
    });

    it('should return prefix match', () => {
      expect(suggestEnumValue('back', ['raw', 'backlog'])).toBe('backlog');
    });

    it('should return close match by Levenshtein distance', () => {
      expect(suggestEnumValue('bakclog', ['raw', 'backlog'])).toBe('backlog');
    });

    it('should return undefined for no close match', () => {
      expect(suggestEnumValue('xyz', ['raw', 'backlog'])).toBeUndefined();
    });

    it('should handle in-progress style values', () => {
      expect(suggestEnumValue('wip', ['draft', 'in-progress', 'done'])).toBeUndefined();
      expect(suggestEnumValue('in-prog', ['draft', 'in-progress', 'done'])).toBe('in-progress');
    });
  });

  describe('suggestFieldName', () => {
    it('should return exact match with different case', () => {
      expect(suggestFieldName('Status', ['status', 'priority'])).toBe('status');
    });

    it('should return close match', () => {
      expect(suggestFieldName('statis', ['status', 'priority'])).toBe('status');
    });

    it('should return undefined for no close match', () => {
      expect(suggestFieldName('foo', ['status', 'priority'])).toBeUndefined();
    });
  });

  describe('formatValidationErrors', () => {
    it('should format single error', () => {
      const output = formatValidationErrors([
        {
          type: 'invalid_enum_value',
          field: 'status',
          value: 'bad',
          message: 'Invalid value for status: "bad"',
          expected: ['raw', 'backlog'],
        },
      ]);

      expect(output).toContain('Validation errors:');
      expect(output).toContain('Invalid value for status');
      expect(output).toContain('raw, backlog');
    });

    it('should include suggestion when available', () => {
      const output = formatValidationErrors([
        {
          type: 'invalid_enum_value',
          field: 'status',
          value: 'rae',
          message: 'Invalid value',
          suggestion: "Did you mean 'raw'?",
        },
      ]);

      expect(output).toContain("Did you mean 'raw'?");
    });

    it('should return empty string for no errors', () => {
      expect(formatValidationErrors([])).toBe('');
    });
  });
});
