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
  getOrderedFieldNames,
  resolveTypePathFromFrontmatter,
  getAllFieldsForType,
  getEnumForField,
  getDiscriminatorFieldsFromTypePath,
} from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault, TEST_SCHEMA } from '../fixtures/setup.js';
import type { LoadedSchema } from '../../../src/types/schema.js';

describe('schema', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

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
      expect(schema.raw).toBeDefined();
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
      expect(typeDef?.outputDir).toBe('Ideas');
    });

    it('should return subtype definition for nested path', () => {
      const typeDef = getTypeDefByPath(schema, 'objective/task');
      expect(typeDef).toBeDefined();
      expect(typeDef?.outputDir).toBe('Objectives/Tasks');
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

    it('should always return "type" in new model (no parent-type discriminators)', () => {
      // In the new inheritance model, we use a single 'type' field
      expect(discriminatorName('objective')).toBe('type');
    });
  });

  describe('getFieldsForType', () => {
    it('should return fields for a type', () => {
      const fields = getFieldsForType(schema, 'idea');
      // In new model, 'type' is not a field - it's implicit
      expect(fields).toHaveProperty('status');
      expect(fields).toHaveProperty('priority');
    });

    it('should return fields for nested type', () => {
      const fields = getFieldsForType(schema, 'objective/task');
      // In new model, discriminator fields are not included
      expect(fields).toHaveProperty('status');
      expect(fields).toHaveProperty('milestone');
      expect(fields).toHaveProperty('deadline');
    });

    it('should inherit fields from parent type', () => {
      // task inherits status from objective ancestor chain
      const taskFields = getFieldsForType(schema, 'objective/task');
      expect(taskFields).toHaveProperty('status');
      expect(taskFields).toHaveProperty('tags');
    });

    it('should apply field default overrides', () => {
      // task has status default 'backlog' (overridden from shared field default)
      const taskFields = getFieldsForType(schema, 'objective/task');
      expect(taskFields.status?.default).toBe('backlog');

      // idea uses default 'raw' (directly from shared fields)
      const ideaFields = getFieldsForType(schema, 'idea');
      expect(ideaFields.status?.default).toBe('raw');
    });
  });

  describe('getFrontmatterOrder', () => {
    it('should return explicit order if defined', () => {
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      const order = getFrontmatterOrder(typeDef!);
      // In new model, 'type' discriminator is not in field order
      expect(order).toContain('status');
      expect(order).toContain('priority');
    });
  });

  describe('getOrderedFieldNames', () => {
    it('should use frontmatter_order if defined', () => {
      const typeDef = getTypeDefByPath(schema, 'objective/task');
      expect(typeDef).toBeDefined();
      const order = getOrderedFieldNames(schema, 'objective/task', typeDef!);
      // In new model, discriminator fields are not included
      expect(order).toContain('status');
      expect(order).toContain('milestone');
      expect(order).toContain('deadline');
    });

    it('should return fieldOrder from resolved type', () => {
      // In the new model, field ordering is computed at schema load time
      // and stored in the ResolvedType.fieldOrder property
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      const order = getOrderedFieldNames(schema, 'idea', typeDef!);
      expect(order).toContain('status');
      expect(order).toContain('priority');
    });
  });

  describe('resolveTypePathFromFrontmatter', () => {
    it('should resolve simple type', () => {
      const typeName = resolveTypePathFromFrontmatter(schema, { type: 'idea' });
      expect(typeName).toBe('idea');
    });

    it('should resolve type directly (no nested paths in new model)', () => {
      // In new model, frontmatter just has 'type: task' not 'type: objective' + 'objective-type: task'
      const typeName = resolveTypePathFromFrontmatter(schema, { type: 'task' });
      expect(typeName).toBe('task');
    });

    it('should resolve legacy nested frontmatter to type (backward compatibility)', () => {
      // Legacy frontmatter with type: objective, objective-type: task should still work
      // by reading the more specific discriminator field to get the actual type
      const typeName = resolveTypePathFromFrontmatter(schema, {
        type: 'objective',
        'objective-type': 'task',
      });
      // In backward-compatible mode, the resolver returns the child type from the discriminator
      expect(typeName).toBe('task');
    });

    it('should return undefined for missing type', () => {
      const typeName = resolveTypePathFromFrontmatter(schema, {});
      expect(typeName).toBeUndefined();
    });
  });

  describe('getAllFieldsForType', () => {
    it('should collect all fields including descendants', () => {
      const fields = getAllFieldsForType(schema, 'objective');
      // In new model, 'type' is not a field
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

  describe('getDiscriminatorFieldsFromTypePath', () => {
    it('should return type field for simple path', () => {
      const fields = getDiscriminatorFieldsFromTypePath('idea');
      expect(fields).toEqual({ type: 'idea' });
    });

    it('should return just type field in new model (extracts last segment)', () => {
      // In new model, we use single 'type' field with the type name
      const fields = getDiscriminatorFieldsFromTypePath('objective/task');
      expect(fields).toEqual({ type: 'task' });
    });

    it('should extract last segment for deeply nested paths', () => {
      const fields = getDiscriminatorFieldsFromTypePath('a/b/c');
      expect(fields).toEqual({ type: 'c' });
    });

    it('should return empty object for empty path', () => {
      const fields = getDiscriminatorFieldsFromTypePath('');
      expect(fields).toEqual({});
    });
  });
});
