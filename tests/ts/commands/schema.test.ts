import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, rm, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('schema command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('schema show (all types)', () => {
    it('should show schema tree', async () => {
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema Types');
      expect(result.stdout).toContain('Types:');
    });

    it('should list all type families', async () => {
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('objective');
      expect(result.stdout).toContain('idea');
    });

    it('should show subtypes', async () => {
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('milestone');
    });

    it('should show enums if defined', async () => {
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Enums:');
      expect(result.stdout).toContain('status');
    });

    it('should show enums when defined', async () => {
      // Note: shared_fields is a v1 feature that gets resolved into individual types
      // in the v2 model, so we no longer display a separate "Shared Fields:" section.
      // Instead we verify the schema display works correctly with enums.
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Enums:');
      expect(result.stdout).toContain('Types:');
    });
  });

  describe('schema show <type>', () => {
    it('should show type details for leaf type', async () => {
      const result = await runCLI(['schema', 'show', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: idea');
      expect(result.stdout).toContain('Output Dir:');
      expect(result.stdout).toContain('Ideas');
      expect(result.stdout).toContain('Own fields:');
    });

    it('should show fields for type', async () => {
      const result = await runCLI(['schema', 'show', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Note: 'type' is not shown as a field since it's auto-injected in the new model
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('priority');
    });

    it('should show subtype details with slash notation', async () => {
      const result = await runCLI(['schema', 'show', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: task');
      expect(result.stdout).toContain('Objectives/Tasks');
    });

    it('should show subtypes for parent type', async () => {
      const result = await runCLI(['schema', 'show', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Subtypes:');
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('milestone');
    });

    it('should show body sections if defined', async () => {
      const result = await runCLI(['schema', 'show', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Body Sections:');
      expect(result.stdout).toContain('Steps');
      expect(result.stdout).toContain('Notes');
    });

    it('should error on unknown type', async () => {
      const result = await runCLI(['schema', 'show', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('should show "(none)" when type has no own fields', async () => {
      // Create a v2 schema with a type that has no own fields
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-noownfields-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {
              fields: {
                created: { prompt: 'date', required: true }
              }
            },
            note: {
              extends: 'meta'
              // No own fields - inherits only from meta
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'show', 'note'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Own fields:');
        expect(result.stdout).toContain('(none)');
        expect(result.stdout).toContain('Inherited fields (from meta):');
        expect(result.stdout).toContain('created');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show "(none)" when type has no inherited fields', async () => {
      // meta type has no parent, so no inherited fields
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-noinherited-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {
              fields: {
                created: { prompt: 'date', required: true }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'show', 'meta'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Own fields:');
        expect(result.stdout).toContain('created');
        expect(result.stdout).toContain('Inherited fields:');
        expect(result.stdout).toMatch(/Inherited fields:\s*\n\s*\(none\)/);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should group inherited fields by origin type', async () => {
      // Create a v2 schema with a 3-level inheritance chain
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-inheritance-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { status: ['raw', 'done'] },
          types: {
            meta: {
              fields: {
                created: { prompt: 'date', required: true }
              }
            },
            objective: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', enum: 'status' }
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

      try {
        const result = await runCLI(['schema', 'show', 'task'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Own fields:');
        expect(result.stdout).toContain('deadline');
        expect(result.stdout).toContain('Inherited fields (from objective):');
        expect(result.stdout).toContain('status');
        expect(result.stdout).toContain('Inherited fields (from meta):');
        expect(result.stdout).toContain('created');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema show <type> --output json', () => {
    it('should include own_fields and inherited_fields in JSON output', async () => {
      // Create a v2 schema with inheritance
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { status: ['raw', 'done'] },
          types: {
            meta: {
              fields: {
                created: { prompt: 'date', required: true }
              }
            },
            task: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', enum: 'status' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'show', 'task', '-o', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        
        // Should have own_fields
        expect(json.own_fields).toBeDefined();
        expect(json.own_fields.status).toBeDefined();
        expect(json.own_fields.status.type).toBe('select');
        
        // Should have inherited_fields grouped by origin
        expect(json.inherited_fields).toBeDefined();
        expect(json.inherited_fields.meta).toBeDefined();
        expect(json.inherited_fields.meta.created).toBeDefined();
        expect(json.inherited_fields.meta.created.type).toBe('date');
        expect(json.inherited_fields.meta.created.required).toBe(true);
        
        // Should also have fields (backwards compatible merged fields)
        expect(json.fields).toBeDefined();
        expect(json.fields.status).toBeDefined();
        expect(json.fields.created).toBeDefined();
        
        // Should have extends
        expect(json.extends).toBe('meta');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should omit inherited_fields when empty', async () => {
      // Create a v2 schema where meta has no parent
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-json-noinherit-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {
              fields: {
                created: { prompt: 'date' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'show', 'meta', '-o', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        
        // Should have own_fields
        expect(json.own_fields).toBeDefined();
        expect(json.own_fields.created).toBeDefined();
        
        // Should NOT have inherited_fields (since empty)
        expect(json.inherited_fields).toBeUndefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should include extends field in JSON output', async () => {
      const result = await runCLI(['schema', 'show', 'idea', '-o', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      
      // Extends should be present (meta in this case, from v1 conversion)
      expect(json.extends).toBe('meta');
    });
  });

  describe('schema validate', () => {
    it('should validate valid schema', async () => {
      const result = await runCLI(['schema', 'validate'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema is valid');
    });

    it('should error on invalid schema', async () => {
      // Create a vault with invalid schema
      const invalidVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-invalid-'));
      await mkdir(join(invalidVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(invalidVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({ invalid: 'schema' })
      );

      try {
        const result = await runCLI(['schema', 'validate'], invalidVaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Schema validation failed');
      } finally {
        await rm(invalidVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when schema file is missing', async () => {
      // Create a vault with no schema
      const noSchemaVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-noschema-'));

      try {
        const result = await runCLI(['schema', 'validate'], noSchemaVaultDir);

        expect(result.exitCode).toBe(1);
      } finally {
        await rm(noSchemaVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on malformed JSON', async () => {
      // Create a vault with malformed JSON
      const malformedVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-malformed-'));
      await mkdir(join(malformedVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(malformedVaultDir, '.bwrb', 'schema.json'),
        '{ invalid json'
      );

      try {
        const result = await runCLI(['schema', 'validate'], malformedVaultDir);

        expect(result.exitCode).toBe(1);
      } finally {
        await rm(malformedVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema edit-type', () => {
    it('should change output directory', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-type-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              output_dir: 'Tasks',
              fields: { status: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-type', 'task', '--output-dir', 'NewTasks'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated type');

        // Verify the change was applied
        const verifyResult = await runCLI(
          ['schema', 'show', 'task', '--output', 'json'],
          tempVaultDir
        );
        const data = JSON.parse(verifyResult.stdout);
        expect(data.output_dir).toBe('NewTasks');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should change extends (reparent type)', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-type-extends-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: { fields: { created: { prompt: 'date' } } },
            objective: { extends: 'meta', fields: { status: { prompt: 'input' } } },
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-type', 'task', '--extends', 'objective'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        // Verify the change was applied
        const verifyResult = await runCLI(
          ['schema', 'show', 'task', '--output', 'json'],
          tempVaultDir
        );
        const data = JSON.parse(verifyResult.stdout);
        expect(data.extends).toBe('objective');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should change filename pattern', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-type-filename-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-type', 'task', '--filename', '{status} - {title}'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        // Verify the change was applied by reading raw schema
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.filename).toBe('{status} - {title}');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on unknown type', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-type-unknown-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-type', 'nonexistent', '--output-dir', 'Foo'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown type');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should output JSON when --output json is specified', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-type-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-type', 'task', '--output-dir', 'NewTasks', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.success).toBe(true);
        expect(data.message).toContain('Updated');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema remove-type', () => {
    it('should show dry-run by default', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-type-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );
      // Create a task file
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Test Task.md'),
        '---\ntype: task\n---\nTest content'
      );

      try {
        // Run without --execute, should be dry-run
        const result = await runCLI(
          ['schema', 'remove-type', 'task', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.dryRun).toBe(true);
        expect(data.affectedFiles).toBe(1);

        // Verify the type still exists
        const verifyResult = await runCLI(['schema', 'show', 'task'], tempVaultDir);
        expect(verifyResult.exitCode).toBe(0);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should remove type with --execute flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-type-exec-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-type', 'task', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Removed type');

        // Verify the type is gone
        const verifyResult = await runCLI(['schema', 'show', 'task'], tempVaultDir);
        expect(verifyResult.exitCode).toBe(1);
        expect(verifyResult.stderr).toContain('Unknown type');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when type has child types', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-type-children-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            objective: { extends: 'meta' },
            task: { extends: 'objective' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-type', 'objective', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('child types');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on unknown type', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-type-unknown-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-type', 'nonexistent', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown type');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should prevent removing meta type', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-meta-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: { fields: { created: { prompt: 'date' } } } }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-type', 'meta', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Cannot remove');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema edit-field', () => {
    it('should change field required status with --required flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'status', '--required'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated field');

        // Verify the change
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.status.required).toBe(true);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should change field to not-required with --not-required flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-not-req-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'input', required: true } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'status', '--not-required'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated field');

        // Verify the change
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.status.required).toBeUndefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should change field default value', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-default-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { priority: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'priority', '--default', 'medium'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        // Verify the change
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.priority.default).toBe('medium');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should clear field default with --clear-default', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-clear-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { priority: { prompt: 'input', default: 'low' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'priority', '--clear-default'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        // Verify the change
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.priority.default).toBeUndefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should change field label', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-label-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { deadline: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'deadline', '--label', 'Due Date'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        // Verify the change
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.deadline.label).toBe('Due Date');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when field is not directly on type (inherited)', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-inherited-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: { fields: { created: { prompt: 'date' } } },
            task: { extends: 'meta' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'created', '--label', 'Created Date'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('inherited');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on unknown field', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-unknown-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', fields: { status: { prompt: 'input' } } }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'nonexistent', '--label', 'Test'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('not found');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should output JSON when --output json is specified', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-field-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit-field', 'task', 'status', '--label', 'Status', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.success).toBe(true);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema remove-field', () => {
    it('should show dry-run by default', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-field-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              output_dir: 'Tasks',
              fields: { status: { prompt: 'input' }, deadline: { prompt: 'input' } }
            }
          }
        })
      );
      // Create a task file with the field
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Test Task.md'),
        '---\ntype: task\nstatus: active\ndeadline: tomorrow\n---\nTest content'
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-field', 'task', 'deadline', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.dryRun).toBe(true);
        expect(data.affectedFiles).toBe(1);

        // Verify the field still exists
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.deadline).toBeDefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should remove field with --execute flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-field-exec-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'input' }, deadline: { prompt: 'input' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-field', 'task', 'deadline', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Removed field');

        // Verify the field is gone
        const { readFile } = await import('fs/promises');
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.deadline).toBeUndefined();
        expect(schema.types.task.fields.status).toBeDefined(); // Other field still there
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when field is inherited', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-field-inherited-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: { fields: { created: { prompt: 'date' } } },
            task: { extends: 'meta', fields: { status: { prompt: 'input' } } }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-field', 'task', 'created', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('inherited');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error on unknown field', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-field-unknown-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', fields: { status: { prompt: 'input' } } }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-field', 'task', 'nonexistent', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('not found');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show child types affected by field removal', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-remove-field-children-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Milestones'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            objective: {
              extends: 'meta',
              fields: { status: { prompt: 'input' } }
            },
            task: { extends: 'objective', output_dir: 'Tasks' },
            milestone: { extends: 'objective', output_dir: 'Milestones' }
          }
        })
      );
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task1.md'),
        '---\ntype: task\nstatus: active\n---\n'
      );
      await writeFile(
        join(tempVaultDir, 'Milestones', 'M1.md'),
        '---\ntype: milestone\nstatus: done\n---\n'
      );

      try {
        const result = await runCLI(
          ['schema', 'remove-field', 'objective', 'status', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.dryRun).toBe(true);
        // Should count files from both child types
        expect(data.affectedFiles).toBe(2);
        expect(data.childTypes).toContain('task');
        expect(data.childTypes).toContain('milestone');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================
  // NEW UNIFIED VERB COMMANDS (schema new/edit/delete/list)
  // ============================================

  describe('schema new type (unified verb)', () => {
    it('should create a new type with CLI flags', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-new-type-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'new', 'type', 'note', '--inherits', 'meta', '--directory', 'Notes', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.success).toBe(true);
        expect(data.data.type).toBe('note');

        // Verify the type was created
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.note).toBeDefined();
        expect(schema.types.note.extends).toBe('meta');
        expect(schema.types.note.output_dir).toBe('Notes');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should output JSON when --output json is specified', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-new-type-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'new', 'type', 'note', '--inherits', 'meta', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.success).toBe(true);
        expect(data.data.type).toBe('note');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show deprecation warning for old add-type command', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-add-type-deprecated-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'add-type', 'note', '--extends', 'meta', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('deprecated');
        expect(result.stderr).toContain('schema new type');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema new field (unified verb)', () => {
    // Note: Full field creation with --prompt, --enum, --required, --default flags
    // is interactive-only in the unified verb implementation.
    // PTY tests cover the interactive flow.
    it.skip('should add a required field with default value (interactive only)', async () => {
      // This test is skipped because schema new field is interactive-only
      // and doesn't support --prompt, --enum, --required, --default flags
    });
  });

  describe('schema new enum (unified verb)', () => {
    it('should create a new enum with values', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-new-enum-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'new', 'enum', 'priority', '--values', 'low,medium,high'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Enum');

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.enums.priority).toEqual(['low', 'medium', 'high']);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema delete type (unified verb)', () => {
    it('should show dry-run by default', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-type-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'type', 'task', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const response = JSON.parse(result.stdout);
        expect(response.success).toBe(true);
        expect(response.data.dryRun).toBe(true);

        // Type should still exist
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task).toBeDefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should delete type with --execute flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-type-exec-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: { extends: 'meta', output_dir: 'Tasks' }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'type', 'task', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('deleted');

        // Type should be gone
        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task).toBeUndefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema delete field (unified verb)', () => {
    it('should delete field with --execute flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-field-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'input' }, deadline: { prompt: 'date' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'field', 'task', 'deadline', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.types.task.fields.deadline).toBeUndefined();
        expect(schema.types.task.fields.status).toBeDefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema delete enum (unified verb)', () => {
    it('should delete unused enum with --execute flag', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-enum-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { priority: ['low', 'medium', 'high'], unused: ['a', 'b'] },
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'enum', 'unused', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.enums.unused).toBeUndefined();
        expect(schema.enums.priority).toBeDefined();
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error when deleting enum in use', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-enum-used-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { status: ['raw', 'done'] },
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'select', enum: 'status' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'enum', 'status', '--execute'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('in use');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('schema list (unified verb)', () => {
    it('should show full schema overview (same as show)', async () => {
      const result = await runCLI(['schema', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema Types');
      expect(result.stdout).toContain('Types:');
      expect(result.stdout).toContain('Enums:');
    });

    it('should list types only with "schema list types"', async () => {
      const result = await runCLI(['schema', 'list', 'types'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('objective');
      expect(result.stdout).toContain('idea');
    });

    it('should list enums only with "schema list enums"', async () => {
      const result = await runCLI(['schema', 'list', 'enums'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status');
    });

    it('should output JSON when --output json is specified', async () => {
      const result = await runCLI(['schema', 'list', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.types).toBeDefined();
      expect(data.enums).toBeDefined();
    });

    it('should show deprecation warning for old show command', async () => {
      const result = await runCLI(['schema', 'show'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('schema list');
    });
  });

  describe('schema edit type (unified verb)', () => {
    // Note: edit type is interactive-only in unified verbs
    // Use the old edit-type command with flags for non-interactive editing
    it.skip('should change output directory (interactive only)', async () => {
      // This test is skipped because schema edit type is interactive
      // and requires PTY testing. See schema-edit-type.pty.test.ts
    });
  });

  describe('schema edit field (unified verb)', () => {
    // Note: edit field is interactive-only in unified verbs
    // Use the old edit-field command with flags for non-interactive editing
    it.skip('should change field properties (interactive only)', async () => {
      // This test is skipped because schema edit field is interactive
      // and requires PTY testing. See schema-edit-field.pty.test.ts
    });
  });

  describe('schema edit enum (unified verb)', () => {
    it('should add values to enum', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-enum-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { priority: ['low', 'high'] },
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit', 'enum', 'priority', '--add', 'medium'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.enums.priority).toContain('medium');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should remove values from enum', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-enum-remove-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { priority: ['low', 'medium', 'high'] },
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit', 'enum', 'priority', '--remove', 'medium'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.enums.priority).not.toContain('medium');
        expect(schema.enums.priority).toContain('low');
        expect(schema.enums.priority).toContain('high');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should rename enum values', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-edit-enum-rename-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { status: ['raw', 'done'] },
          types: { meta: {} }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'edit', 'enum', 'status', '--rename', 'raw=pending'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);

        const schema = JSON.parse(
          await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf8')
        );
        expect(schema.enums.status).not.toContain('raw');
        expect(schema.enums.status).toContain('pending');
        expect(schema.enums.status).toContain('done');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });
});
