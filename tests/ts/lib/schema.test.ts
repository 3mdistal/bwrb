import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadSchema,
  getTypeFamilies,
  getEnumValues,
  parseTypePath,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  discriminatorName,
  getFieldsForType,
  getFrontmatterOrder,
  resolveTypePathFromFrontmatter,
  getAllFieldsForType,
  getEnumForField,
} from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault, TEST_SCHEMA } from '../fixtures/setup.js';
import type { Schema } from '../../../src/types/schema.js';

describe('schema', () => {
  let vaultDir: string;
  let schema: Schema;

  beforeAll(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('loadSchema', () => {
    it('should load and validate schema from vault', async () => {
      expect(schema).toBeDefined();
      expect(schema.types).toBeDefined();
      expect(schema.enums).toBeDefined();
    });

    it('should throw on missing schema file', async () => {
      await expect(loadSchema('/nonexistent/path')).rejects.toThrow();
    });
  });

  describe('getTypeFamilies', () => {
    it('should return top-level type names', () => {
      const families = getTypeFamilies(schema);
      expect(families).toContain('objective');
      expect(families).toContain('idea');
    });
  });

  describe('getEnumValues', () => {
    it('should return enum values by name', () => {
      const values = getEnumValues(schema, 'status');
      expect(values).toEqual(['raw', 'backlog', 'in-flight', 'settled']);
    });

    it('should return empty array for unknown enum', () => {
      const values = getEnumValues(schema, 'unknown');
      expect(values).toEqual([]);
    });
  });

  describe('parseTypePath', () => {
    it('should split type path into segments', () => {
      expect(parseTypePath('objective/task')).toEqual(['objective', 'task']);
      expect(parseTypePath('idea')).toEqual(['idea']);
      expect(parseTypePath('')).toEqual([]);
    });
  });

  describe('getTypeDefByPath', () => {
    it('should return type definition for simple path', () => {
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      expect(typeDef?.output_dir).toBe('Ideas');
    });

    it('should return subtype definition for nested path', () => {
      const typeDef = getTypeDefByPath(schema, 'objective/task');
      expect(typeDef).toBeDefined();
      expect(typeDef?.output_dir).toBe('Objectives/Tasks');
    });

    it('should return undefined for unknown path', () => {
      const typeDef = getTypeDefByPath(schema, 'unknown');
      expect(typeDef).toBeUndefined();
    });
  });

  describe('hasSubtypes', () => {
    it('should return true for types with subtypes', () => {
      const typeDef = getTypeDefByPath(schema, 'objective');
      expect(typeDef).toBeDefined();
      expect(hasSubtypes(typeDef!)).toBe(true);
    });

    it('should return false for leaf types', () => {
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      expect(hasSubtypes(typeDef!)).toBe(false);
    });
  });

  describe('getSubtypeKeys', () => {
    it('should return subtype keys', () => {
      const typeDef = getTypeDefByPath(schema, 'objective');
      expect(typeDef).toBeDefined();
      const keys = getSubtypeKeys(typeDef!);
      expect(keys).toContain('task');
      expect(keys).toContain('milestone');
    });
  });

  describe('discriminatorName', () => {
    it('should return "type" for top-level', () => {
      expect(discriminatorName(undefined)).toBe('type');
      expect(discriminatorName('type')).toBe('type');
    });

    it('should return "<parent>-type" for nested', () => {
      expect(discriminatorName('objective')).toBe('objective-type');
    });
  });

  describe('getFieldsForType', () => {
    it('should return fields for a type', () => {
      const fields = getFieldsForType(schema, 'idea');
      expect(fields).toHaveProperty('type');
      expect(fields).toHaveProperty('status');
    });

    it('should return fields for nested type', () => {
      const fields = getFieldsForType(schema, 'objective/task');
      expect(fields).toHaveProperty('type');
      expect(fields).toHaveProperty('objective-type');
      expect(fields).toHaveProperty('status');
      expect(fields).toHaveProperty('milestone');
    });
  });

  describe('getFrontmatterOrder', () => {
    it('should return explicit order if defined', () => {
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      const order = getFrontmatterOrder(typeDef!);
      expect(order).toEqual(['type', 'status', 'priority']);
    });
  });

  describe('resolveTypePathFromFrontmatter', () => {
    it('should resolve simple type path', () => {
      const path = resolveTypePathFromFrontmatter(schema, { type: 'idea' });
      expect(path).toBe('idea');
    });

    it('should resolve nested type path', () => {
      const path = resolveTypePathFromFrontmatter(schema, {
        type: 'objective',
        'objective-type': 'task',
      });
      expect(path).toBe('objective/task');
    });

    it('should return undefined for missing type', () => {
      const path = resolveTypePathFromFrontmatter(schema, {});
      expect(path).toBeUndefined();
    });
  });

  describe('getAllFieldsForType', () => {
    it('should collect all fields including subtypes', () => {
      const fields = getAllFieldsForType(schema, 'objective');
      expect(fields.has('type')).toBe(true);
      expect(fields.has('status')).toBe(true);
      expect(fields.has('milestone')).toBe(true);
    });
  });

  describe('getEnumForField', () => {
    it('should return enum name for enum fields', () => {
      const enumName = getEnumForField(schema, 'idea', 'status');
      expect(enumName).toBe('status');
    });

    it('should return undefined for non-enum fields', () => {
      const enumName = getEnumForField(schema, 'objective/task', 'deadline');
      expect(enumName).toBeUndefined();
    });
  });
});
