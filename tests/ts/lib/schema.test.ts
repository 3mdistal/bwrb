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
  getPluralName,
  computeDefaultOutputDir,
  getType,
  resolveSourceType,
  getFieldsByOrigin,
  getFieldOrderForOrigin,
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
    it('should return type name as single-element array (legacy function)', () => {
      // In v2, parseTypePath just returns [typeName] - no path splitting
      expect(parseTypePath('task')).toEqual(['task']);
      expect(parseTypePath('idea')).toEqual(['idea']);
      expect(parseTypePath('')).toEqual(['']);
    });
  });

  describe('getTypeDefByPath', () => {
    it('should return type definition for type name', () => {
      const typeDef = getTypeDefByPath(schema, 'idea');
      expect(typeDef).toBeDefined();
      expect(typeDef?.outputDir).toBe('Ideas');
    });

    it('should return type definition for child type', () => {
      const typeDef = getTypeDefByPath(schema, 'task');
      expect(typeDef).toBeDefined();
      expect(typeDef?.outputDir).toBe('Objectives/Tasks');
    });

    it('should return undefined for unknown type', () => {
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
      expect(fields).toHaveProperty('status');
      expect(fields).toHaveProperty('priority');
    });

    it('should return fields for child type', () => {
      const fields = getFieldsForType(schema, 'task');
      expect(fields).toHaveProperty('status');
      expect(fields).toHaveProperty('milestone');
      expect(fields).toHaveProperty('deadline');
    });

    it('should include fields defined on type', () => {
      const taskFields = getFieldsForType(schema, 'task');
      expect(taskFields).toHaveProperty('status');
      expect(taskFields).toHaveProperty('tags');
    });

    it('should have correct defaults', () => {
      // task has status default 'backlog'
      const taskFields = getFieldsForType(schema, 'task');
      expect(taskFields.status?.default).toBe('backlog');

      // idea uses default 'raw'
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
    it('should use field_order if defined', () => {
      const typeDef = getTypeDefByPath(schema, 'task');
      expect(typeDef).toBeDefined();
      const order = getOrderedFieldNames(schema, 'task', typeDef!);
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

    it('should resolve child type directly', () => {
      // In v2 model, frontmatter has just 'type: task'
      const typeName = resolveTypePathFromFrontmatter(schema, { type: 'task' });
      expect(typeName).toBe('task');
    });

    it('should return parent type when only parent specified', () => {
      // If frontmatter has type: objective, return objective (not task)
      const typeName = resolveTypePathFromFrontmatter(schema, {
        type: 'objective',
      });
      expect(typeName).toBe('objective');
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
      const enumName = getEnumForField(schema, 'task', 'deadline');
      expect(enumName).toBeUndefined();
    });
  });

  describe('getDiscriminatorFieldsFromTypePath', () => {
    it('should return type field for type name', () => {
      const fields = getDiscriminatorFieldsFromTypePath('idea');
      expect(fields).toEqual({ type: 'idea' });
    });

    it('should return type field with provided name', () => {
      // In v2, this function just returns { type: typeName }
      const fields = getDiscriminatorFieldsFromTypePath('task');
      expect(fields).toEqual({ type: 'task' });
    });

    it('should return type field for any string', () => {
      const fields = getDiscriminatorFieldsFromTypePath('milestone');
      expect(fields).toEqual({ type: 'milestone' });
    });

    it('should return type field with empty string for empty input', () => {
      const fields = getDiscriminatorFieldsFromTypePath('');
      expect(fields).toEqual({ type: '' });
    });
  });

  describe('pluralization and folder computation', () => {
    describe('getPluralName', () => {
      it('should return auto-pluralized name for types without explicit plural', () => {
        // task -> tasks (simple s)
        expect(getPluralName(schema, 'task')).toBe('tasks');
      });

      it('should use explicit plural when defined in schema', () => {
        // Types can define custom plurals like "research" (no change)
        // The test schema doesn't have explicit plurals, so this tests fallback
        const type = getType(schema, 'idea');
        expect(type?.plural).toBe('ideas');
      });

      it('should handle auto-pluralization of words ending in y', () => {
        // If we had a type 'story', it would become 'stories'
        // Since we don't, we just verify the result for known types
        expect(getPluralName(schema, 'unknown')).toBe('unknowns');
      });
    });

    describe('computeDefaultOutputDir', () => {
      it('should compute folder from type hierarchy', () => {
        // task extends objective extends meta
        // -> objectives/tasks (using plurals, excluding meta)
        const dir = computeDefaultOutputDir(schema, 'task');
        expect(dir).toBe('objectives/tasks');
      });

      it('should compute folder for direct meta child', () => {
        // idea extends meta -> ideas (just the plural)
        const dir = computeDefaultOutputDir(schema, 'idea');
        expect(dir).toBe('ideas');
      });

      it('should compute folder for milestone (sibling of task)', () => {
        // milestone extends objective extends meta
        const dir = computeDefaultOutputDir(schema, 'milestone');
        expect(dir).toBe('objectives/milestones');
      });

      it('should return auto-pluralized name for unknown type', () => {
        const dir = computeDefaultOutputDir(schema, 'widget');
        expect(dir).toBe('widgets');
      });
    });

    describe('resolved type plural property', () => {
      it('should populate plural on resolved types', () => {
        const taskType = getType(schema, 'task');
        expect(taskType?.plural).toBe('tasks');

        const ideaType = getType(schema, 'idea');
        expect(ideaType?.plural).toBe('ideas');

        const milestoneType = getType(schema, 'milestone');
        expect(milestoneType?.plural).toBe('milestones');
      });
    });
  });

  describe('recursive types', () => {
    it('should auto-create parent field for recursive types', async () => {
      // Create a test schema with recursive type
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      
      const tempDir = await mkdtemp(join(tmpdir(), 'pika-recursive-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              task: {
                recursive: true,
                fields: {
                  title: { prompt: 'input' }
                }
              }
            }
          })
        );
        
        const recursiveSchema = await loadSchema(tempDir);
        const taskType = recursiveSchema.types.get('task');
        
        expect(taskType).toBeDefined();
        expect(taskType!.recursive).toBe(true);
        expect(taskType!.fields['parent']).toBeDefined();
        expect(taskType!.fields['parent'].source).toBe('task');
        expect(taskType!.fields['parent'].format).toBe('wikilink');
        expect(taskType!.fields['parent'].required).toBe(false);
        expect(taskType!.fieldOrder).toContain('parent');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should not override existing parent field for recursive types', async () => {
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      
      const tempDir = await mkdtemp(join(tmpdir(), 'pika-recursive-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              task: {
                recursive: true,
                fields: {
                  title: { prompt: 'input' },
                  parent: {
                    prompt: 'dynamic',
                    source: 'task',
                    format: 'quoted-wikilink',
                    required: true,
                    label: 'Parent Task'
                  }
                }
              }
            }
          })
        );
        
        const recursiveSchema = await loadSchema(tempDir);
        const taskType = recursiveSchema.types.get('task');
        
        expect(taskType).toBeDefined();
        expect(taskType!.recursive).toBe(true);
        // Should preserve the explicit field definition
        expect(taskType!.fields['parent'].format).toBe('quoted-wikilink');
        expect(taskType!.fields['parent'].required).toBe(true);
        expect(taskType!.fields['parent'].label).toBe('Parent Task');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should not add parent field for non-recursive types', async () => {
      // The test fixture schema has non-recursive types
      const ideaType = schema.types.get('idea');
      expect(ideaType).toBeDefined();
      expect(ideaType!.recursive).toBe(false);
      expect(ideaType!.fields['parent']).toBeUndefined();
    });

    it('should create parent field with array source for recursive type with extends', async () => {
      // When a type is recursive AND extends another type,
      // the parent field should accept both the extended type and the same type
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      
      const tempDir = await mkdtemp(join(tmpdir(), 'pika-mixed-hierarchy-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              chapter: {
                fields: {
                  title: { prompt: 'input' }
                }
              },
              scene: {
                extends: 'chapter',
                recursive: true,
                fields: {
                  content: { prompt: 'input' }
                }
              }
            }
          })
        );
        
        const mixedSchema = await loadSchema(tempDir);
        const sceneType = mixedSchema.types.get('scene');
        
        expect(sceneType).toBeDefined();
        expect(sceneType!.recursive).toBe(true);
        expect(sceneType!.parent).toBe('chapter');
        expect(sceneType!.fields['parent']).toBeDefined();
        
        // Parent field should accept both 'chapter' and 'scene'
        const parentSource = sceneType!.fields['parent'].source;
        expect(Array.isArray(parentSource)).toBe(true);
        expect(parentSource).toContain('chapter');
        expect(parentSource).toContain('scene');
        expect(sceneType!.fields['parent'].format).toBe('wikilink');
        expect(sceneType!.fields['parent'].required).toBe(false);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should create parent field with single source for recursive type without extends', async () => {
      // When a type is recursive but does not extend another type,
      // the parent field should only accept the same type
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      
      const tempDir = await mkdtemp(join(tmpdir(), 'pika-recursive-only-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              task: {
                recursive: true,
                fields: {
                  title: { prompt: 'input' }
                }
              }
            }
          })
        );
        
        const recursiveSchema = await loadSchema(tempDir);
        const taskType = recursiveSchema.types.get('task');
        
        expect(taskType).toBeDefined();
        expect(taskType!.recursive).toBe(true);
        expect(taskType!.fields['parent']).toBeDefined();
        
        // Parent field should only accept 'task' (single source, not array)
        expect(taskType!.fields['parent'].source).toBe('task');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveSourceType', () => {
    it('should return success for valid type names', () => {
      const result = resolveSourceType(schema, 'idea');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.typeName).toBe('idea');
      }
    });

    it('should return success for nested type names', () => {
      const result = resolveSourceType(schema, 'task');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.typeName).toBe('task');
      }
    });

    it('should detect enum value confusion', () => {
      // 'raw' is a value in the 'status' enum
      const result = resolveSourceType(schema, 'raw');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('"raw" is a value in the "status" enum');
        expect(result.error).toContain('Dynamic sources must reference types');
      }
    });

    it('should report path format error for slash-containing names with valid last segment', () => {
      // 'objective/task' has 'task' as valid type - suggest using just the type name
      const result = resolveSourceType(schema, 'objective/task');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('uses path format');
        expect(result.error).toContain('Use just the type name: "task"');
        expect(result.suggestions).toContain('task');
      }
    });

    it('should report path format error for invalid path format names', () => {
      const result = resolveSourceType(schema, 'foo/bar');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('uses path format');
        expect(result.error).toContain('Available types:');
      }
    });

    it('should suggest similar type names for typos', () => {
      // 'ide' is close to 'idea'
      const result = resolveSourceType(schema, 'ide');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
        expect(result.error).toContain('Did you mean:');
        expect(result.suggestions).toContain('idea');
      }
    });

    it('should list available types when no close match exists', () => {
      const result = resolveSourceType(schema, 'completely-unknown-type');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
        expect(result.error).toContain('Available types:');
        // Should not have suggestions for very different names
        expect(result.suggestions).toBeUndefined();
      }
    });

    it('should prioritize enum check over typo suggestions', () => {
      // If something is an enum value, we should say so even if it's close to a type name
      // 'priority' enum has 'low', 'medium', 'high' values
      const result = resolveSourceType(schema, 'low');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('is a value in the "priority" enum');
      }
    });
  });

  describe('getFieldsByOrigin', () => {
    it('should separate own fields from inherited fields', async () => {
      // Create a v2 schema with inheritance
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const tempDir = await mkdtemp(join(tmpdir(), 'pika-origin-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              meta: {
                fields: {
                  created: { prompt: 'date', required: true }
                }
              },
              task: {
                extends: 'meta',
                fields: {
                  status: { prompt: 'input' }
                }
              }
            }
          })
        );

        const v2Schema = await loadSchema(tempDir);
        const result = getFieldsByOrigin(v2Schema, 'task');

        // Own fields should contain 'status'
        expect(Object.keys(result.ownFields)).toContain('status');
        expect(Object.keys(result.ownFields)).not.toContain('created');

        // Inherited fields should contain 'created' from 'meta'
        expect(result.inheritedFields.has('meta')).toBe(true);
        const metaFields = result.inheritedFields.get('meta')!;
        expect(Object.keys(metaFields)).toContain('created');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return empty when type has no fields', async () => {
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const tempDir = await mkdtemp(join(tmpdir(), 'pika-empty-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              empty: {}
            }
          })
        );

        const v2Schema = await loadSchema(tempDir);
        const result = getFieldsByOrigin(v2Schema, 'empty');

        expect(Object.keys(result.ownFields)).toHaveLength(0);
        expect(result.inheritedFields.size).toBe(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should handle multi-level inheritance', async () => {
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const tempDir = await mkdtemp(join(tmpdir(), 'pika-multilevel-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              meta: {
                fields: {
                  created: { prompt: 'date' }
                }
              },
              objective: {
                extends: 'meta',
                fields: {
                  status: { prompt: 'input' }
                }
              },
              task: {
                extends: 'objective',
                fields: {
                  deadline: { prompt: 'input' }
                }
              }
            }
          })
        );

        const v2Schema = await loadSchema(tempDir);
        const result = getFieldsByOrigin(v2Schema, 'task');

        // Own fields: deadline
        expect(Object.keys(result.ownFields)).toEqual(['deadline']);

        // Inherited from objective: status
        expect(result.inheritedFields.has('objective')).toBe(true);
        expect(Object.keys(result.inheritedFields.get('objective')!)).toEqual(['status']);

        // Inherited from meta: created
        expect(result.inheritedFields.has('meta')).toBe(true);
        expect(Object.keys(result.inheritedFields.get('meta')!)).toEqual(['created']);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return empty for unknown type', () => {
      const result = getFieldsByOrigin(schema, 'nonexistent');
      expect(Object.keys(result.ownFields)).toHaveLength(0);
      expect(result.inheritedFields.size).toBe(0);
    });
  });

  describe('getFieldOrderForOrigin', () => {
    it('should return fields in the origin types field order', async () => {
      const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      const tempDir = await mkdtemp(join(tmpdir(), 'pika-order-test-'));
      try {
        await mkdir(join(tempDir, '.pika'), { recursive: true });
        await writeFile(
          join(tempDir, '.pika/schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              meta: {
                fields: {
                  alpha: { prompt: 'input' },
                  beta: { prompt: 'input' },
                  gamma: { prompt: 'input' }
                },
                field_order: ['gamma', 'alpha', 'beta']
              }
            }
          })
        );

        const v2Schema = await loadSchema(tempDir);
        const order = getFieldOrderForOrigin(v2Schema, 'meta', ['beta', 'alpha', 'gamma']);

        // Should follow meta's field_order
        expect(order).toEqual(['gamma', 'alpha', 'beta']);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should return fields as-is for unknown type', () => {
      const order = getFieldOrderForOrigin(schema, 'nonexistent', ['a', 'b', 'c']);
      expect(order).toEqual(['a', 'b', 'c']);
    });
  });
});
