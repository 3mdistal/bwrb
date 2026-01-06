import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

describe('schema add-field command', () => {
  let tempVaultDir: string;

  beforeEach(async () => {
    // Create fresh vault for each test
    tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-addfield-'));
    await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(tempVaultDir, '.bwrb', 'schema.json'),
      JSON.stringify({
        version: 2,
        enums: {
          status: ['open', 'closed'],
          priority: ['low', 'medium', 'high'],
        },
        types: {
          note: {
            output_dir: 'Notes',
            fields: {
              status: { prompt: 'select', enum: 'status' },
            },
          },
          task: {
            extends: 'note',
            output_dir: 'Tasks',
            fields: {
              due: { prompt: 'date' },
            },
          },
          project: {
            output_dir: 'Projects',
          },
        },
      })
    );
  });

  afterAll(async () => {
    if (tempVaultDir) {
      await rm(tempVaultDir, { recursive: true, force: true });
    }
  });

  describe('basic field creation (JSON mode)', () => {
    it('should add an input field to a type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'description', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.type).toBe('project');
      expect(json.data.field).toBe('description');
      expect(json.data.definition.prompt).toBe('text');

      // Verify schema was updated
      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.description).toEqual({ prompt: 'text' });
    });

    it('should add a select field with enum', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'priority', '--type', 'select', '--enum', 'priority', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.definition.prompt).toBe('select');
      expect(json.data.definition.enum).toBe('priority');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.priority).toEqual({
        prompt: 'select',
        enum: 'priority',
      });
    });

    it('should add a date field', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'deadline', '--type', 'date', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.prompt).toBe('date');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.deadline).toEqual({ prompt: 'date' });
    });

    it('should add a multi-input field', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'tags', '--type', 'list', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.prompt).toBe('list');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.tags).toEqual({ prompt: 'list' });
    });

    it('should add a dynamic field with source and format', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'task', 'project', '--type', 'relation', '--source', 'project', '--format', 'wikilink', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.prompt).toBe('relation');
      expect(json.data.definition.source).toBe('project');
      expect(json.data.definition.format).toBe('wikilink');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.task.fields.project).toEqual({
        prompt: 'relation',
        source: 'project',
        format: 'wikilink',
      });
    });

    it('should add a fixed value field', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'type', '--type', 'fixed', '--value', 'project', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.value).toBe('project');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.type).toEqual({ value: 'project' });
    });

    it('should add a required field', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'name', '--type', 'text', '--required', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.required).toBe(true);

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.name).toEqual({
        prompt: 'text',
        required: true,
      });
    });

    it('should add a field with default value', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'status', '--type', 'select', '--enum', 'status', '--default', 'open', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.definition.default).toBe('open');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.project.fields.status).toEqual({
        prompt: 'select',
        enum: 'status',
        default: 'open',
      });
    });
  });

  describe('validation', () => {
    it('should reject non-existent type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'nonexistent', 'field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
    });

    it('should reject duplicate field name on same type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'note', 'status', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('should reject overriding inherited field', async () => {
      // task inherits from note, which has status field
      const result = await runCLI(
        ['schema', 'add-field', 'task', 'status', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('inherited');
    });

    it('should reject invalid field name starting with number', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', '123field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('must start with a lowercase letter');
    });

    it('should reject field name with uppercase letters', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'MyField', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('must start with a lowercase letter');
    });

    it('should reject field name with underscores', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'my_field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('must start with a lowercase letter');
    });

    it('should reject invalid prompt type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'field', '--type', 'invalid', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid prompt type');
    });

    it('should reject select without --enum', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'priority', '--type', 'select', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--enum is required');
    });

    it('should reject select with non-existent enum', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'field', '--type', 'select', '--enum', 'nonexistent', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
    });

    it('should reject dynamic without --source', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'parent', '--type', 'relation', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--source is required');
    });

    it('should reject dynamic with non-existent source type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'parent', '--type', 'relation', '--source', 'nonexistent', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
    });

    it('should reject fixed without --value', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'type', '--type', 'fixed', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--value is required');
    });

    it('should reject invalid format value', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'parent', '--type', 'relation', '--source', 'note', '--format', 'invalid', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid format');
    });

    it('should require field name in JSON mode', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Field name is required');
    });

    it('should require --type in JSON mode', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'field', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--type is required');
    });
  });

  describe('field names with hyphens', () => {
    it('should allow field names with hyphens', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'due-date', '--type', 'date', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.field).toBe('due-date');
    });
  });

  describe('field_order handling', () => {
    it('should append to existing field_order', async () => {
      // First, add field_order to the schema
      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      schema.types.project.fields = { existing: { prompt: 'text' } };
      schema.types.project.field_order = ['existing'];
      await writeFile(schemaPath, JSON.stringify(schema));

      const result = await runCLI(
        ['schema', 'add-field', 'project', 'new-field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);

      const updatedSchema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      expect(updatedSchema.types.project.field_order).toEqual(['existing', 'new-field']);
    });

    it('should create field_order when adding second field', async () => {
      // Add first field
      await runCLI(
        ['schema', 'add-field', 'project', 'first', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      // Add second field
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'second', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);

      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      expect(schema.types.project.field_order).toEqual(['first', 'second']);
    });

    it('should not create field_order for first field only', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'only-field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);

      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      expect(schema.types.project.field_order).toBeUndefined();
    });
  });

  describe('schema validation after add', () => {
    it('should maintain valid schema after adding field', async () => {
      await runCLI(
        ['schema', 'add-field', 'project', 'description', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      const result = await runCLI(
        ['schema', 'validate', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('should show new field in schema show', async () => {
      await runCLI(
        ['schema', 'add-field', 'project', 'description', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      const result = await runCLI(
        ['schema', 'show', 'project', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.fields.description).toBeDefined();
      expect(json.fields.description.type).toBe('text');
    });
  });

  describe('inheritance indication', () => {
    it('should indicate when field affects child types', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'note', 'new-field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.affectsChildTypes).toBe(true);
    });

    it('should indicate when field does not affect child types', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'new-field', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.affectsChildTypes).toBe(false);
    });
  });

  describe('text mode output', () => {
    it('should show error message in text mode', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'nonexistent', 'field', '--type', 'text'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });

    it('should show validation error in text mode', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', '123invalid', '--type', 'text'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('must start with a lowercase letter');
    });
  });

  describe('dynamic source error messages', () => {
    it('should detect enum value confusion and provide helpful message', async () => {
      // 'high' is a value in the 'priority' enum, not a type name
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'urgency', '--type', 'relation', '--source', 'high', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('"high" is a value in the "priority" enum');
      expect(json.error).toContain('Dynamic sources must reference types');
      expect(json.error).toContain('Available types:');
    });

    it('should detect path format and suggest using type name directly', async () => {
      // note/task uses path format; task is a valid type
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'related', '--type', 'relation', '--source', 'note/task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('uses path format');
      expect(json.error).toContain('Use just the type name: "task"');
    });

    it('should detect path format when neither segment is a valid type', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'related', '--type', 'relation', '--source', 'foo/bar', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('uses path format which is not supported');
      expect(json.error).toContain('Available types:');
    });

    it('should suggest similar type names for typos', async () => {
      // 'projec' is close to 'project'
      const result = await runCLI(
        ['schema', 'add-field', 'note', 'parent-project', '--type', 'relation', '--source', 'projec', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
      expect(json.error).toContain('Did you mean: project');
    });

    it('should list available types when no close match exists', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'related', '--type', 'relation', '--source', 'completely-unknown', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
      expect(json.error).toContain('Available types:');
      expect(json.error).toContain('note');
      expect(json.error).toContain('task');
      expect(json.error).toContain('project');
    });

    it('should still accept valid source types', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'project', 'related-task', '--type', 'relation', '--source', 'task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.definition.source).toBe('task');
    });
  });

  describe('meta type handling', () => {
    it('should add a field to implicit meta type', async () => {
      // The test schema has no explicit meta type - it's created implicitly
      const result = await runCLI(
        ['schema', 'add-field', 'meta', 'created', '--type', 'date', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.type).toBe('meta');
      expect(json.data.field).toBe('created');
      expect(json.data.definition.prompt).toBe('date');
      // Adding to meta affects all child types
      expect(json.data.affectsChildTypes).toBe(true);

      // Verify schema was updated with meta type created
      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.meta).toBeDefined();
      expect(schema.types.meta.fields).toBeDefined();
      expect(schema.types.meta.fields.created).toEqual({ prompt: 'date' });
    });

    it('should add field to existing explicit meta type', async () => {
      // Add explicit meta to schema first
      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      schema.types.meta = { fields: { version: { value: '1' } } };
      await writeFile(schemaPath, JSON.stringify(schema));

      const result = await runCLI(
        ['schema', 'add-field', 'meta', 'created', '--type', 'date', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify both fields exist
      const updatedSchema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      expect(updatedSchema.types.meta.fields.version).toEqual({ value: '1' }); // preserved
      expect(updatedSchema.types.meta.fields.created).toEqual({ prompt: 'date' }); // added
    });

    it('should reject duplicate field on meta type', async () => {
      // Add meta with a field first
      const schemaPath = join(tempVaultDir, '.bwrb', 'schema.json');
      const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));
      schema.types.meta = { fields: { created: { prompt: 'date' } } };
      await writeFile(schemaPath, JSON.stringify(schema));

      const result = await runCLI(
        ['schema', 'add-field', 'meta', 'created', '--type', 'text', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('should show inheritance note in text mode when adding to meta', async () => {
      const result = await runCLI(
        ['schema', 'add-field', 'meta', 'created', '--type', 'date'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      // Should mention that adding to meta affects all types
      expect(result.stdout).toContain('meta');
    });
  });
});
