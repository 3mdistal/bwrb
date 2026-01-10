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

  describe('schema list (all types)', () => {
    it('should show schema tree', async () => {
      const result = await runCLI(['schema', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema Types');
      expect(result.stdout).toContain('Types:');
    });

    it('should list all type families', async () => {
      const result = await runCLI(['schema', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('objective');
      expect(result.stdout).toContain('idea');
    });

    it('should show subtypes', async () => {
      const result = await runCLI(['schema', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('milestone');
    });

    it('should show computed directory for top-level types without explicit output_dir', async () => {
      // Create a schema where a top-level type has no explicit output_dir
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-computed-dir-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            // Top-level type with NO explicit output_dir
            note: {
              extends: 'meta',
              fields: {
                title: { prompt: 'text' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        // Should show computed directory (pluralized type name)
        expect(result.stdout).toContain('note');
        expect(result.stdout).toContain('-> notes');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should show computed directory in JSON output for types without explicit output_dir', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-computed-dir-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            note: {
              extends: 'meta',
              fields: {}
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        // JSON output should include computed output_dir
        expect(data.types.note).toBeDefined();
        expect(data.types.note.output_dir).toBe('notes');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

  });

  describe('schema list type <name>', () => {
    it('should show type details for leaf type', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: idea');
      expect(result.stdout).toContain('Output Dir:');
      expect(result.stdout).toContain('Ideas');
      expect(result.stdout).toContain('Own fields:');
    });

    it('should show fields for type', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Note: 'type' is not shown as a field since it's auto-injected in the new model
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('priority');
    });

    it('should show subtype details with slash notation', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: task');
      expect(result.stdout).toContain('Objectives/Tasks');
    });

    it('should show subtypes for parent type', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Subtypes:');
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('milestone');
    });

    it('should show body sections if defined', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Body Sections:');
      expect(result.stdout).toContain('Steps');
      expect(result.stdout).toContain('Notes');
    });

    it('should error on unknown type', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('should show computed directory for type without explicit output_dir', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-type-computed-dir-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            journal: {
              extends: 'meta',
              fields: {
                date: { prompt: 'date' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', 'type', 'journal'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Type: journal');
        expect(result.stdout).toContain('Output Dir:');
        // Should show computed directory (pluralized name)
        expect(result.stdout).toContain('journals');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
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
        const result = await runCLI(['schema', 'list', 'type', 'note'], tempVaultDir);

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
        const result = await runCLI(['schema', 'list', 'type', 'meta'], tempVaultDir);

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
          types: {
            meta: {
              fields: {
                created: { prompt: 'date', required: true }
              }
            },
            objective: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', options: ['raw', 'done'] }
              }
            },
            task: {
              extends: 'objective',
              fields: {
                deadline: { prompt: 'text' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', 'type', 'task'], tempVaultDir);

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

  describe('schema list type <name> --output json', () => {
    it('should include own_fields and inherited_fields in JSON output', async () => {
      // Create a v2 schema with inheritance
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-json-'));
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
            task: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', options: ['raw', 'done'] }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', 'type', 'task', '--output', 'json'], tempVaultDir);

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
        const result = await runCLI(['schema', 'list', 'type', 'meta', '--output', 'json'], tempVaultDir);

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
      const result = await runCLI(['schema', 'list', 'type', 'idea', '--output', 'json'], vaultDir);

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

    it('should warn when a type is missing output_dir', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-schema-validate-missing-output-dir-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            note: {
              extends: 'meta',
              fields: {
                title: { prompt: 'text' },
              },
            },
          },
        })
      );

      try {
        const result = await runCLI(['schema', 'validate'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Schema is valid');
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('type "note"');
        expect(result.stderr).toContain('computed: "notes"');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should include output_dir warnings in JSON output', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-schema-validate-missing-output-dir-json-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            note: {
              extends: 'meta',
              fields: {},
            },
          },
        })
      );

      try {
        const result = await runCLI(['schema', 'validate', '--output', 'json'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data?.warnings).toBeDefined();
        expect(json.data.warnings).toEqual([
          { type: 'note', computed_output_dir: 'notes' },
        ]);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
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
  });

  describe('schema new field (unified verb)', () => {
    // Note: Full field creation with --prompt, --options, --required, --default flags
    // is interactive-only in the unified verb implementation.
    // PTY tests cover the interactive flow.
    it.skip('should add a required field with default value (interactive only)', async () => {
      // This test is skipped because schema new field is interactive-only
      // and doesn't support --prompt, --options, --required, --default flags
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
              fields: { status: { prompt: 'text' }, deadline: { prompt: 'date' } }
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

  describe('schema list (unified verb)', () => {
    it('should show full schema overview (same as show)', async () => {
      const result = await runCLI(['schema', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema Types');
      expect(result.stdout).toContain('Types:');
    });

    it('should list types only with "schema list types"', async () => {
      const result = await runCLI(['schema', 'list', 'types'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('objective');
      expect(result.stdout).toContain('idea');
    });

    it('should output JSON when --output json is specified', async () => {
      const result = await runCLI(['schema', 'list', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.types).toBeDefined();
    });
  });

  describe('schema list --verbose', () => {
    it('should show all types with their fields inline', async () => {
      const result = await runCLI(['schema', 'list', '--verbose'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema Types');
      expect(result.stdout).toContain('Types:');
      // Should show type names
      expect(result.stdout).toContain('objective');
      expect(result.stdout).toContain('task');
      // Should show fields inline with tree characters
      expect(result.stdout).toMatch(/[├└]─.*status/);
    });

    it('should show inheritance annotations', async () => {
      const result = await runCLI(['schema', 'list', '--verbose'], vaultDir);

      expect(result.exitCode).toBe(0);
      // task extends objective
      expect(result.stdout).toContain('(extends objective)');
      // Note: BASELINE_SCHEMA has task redefining all fields, so no (inherited) markers
      // The 'should work with inheritance chains' test covers actual inheritance
    });

    it('should show required field markers', async () => {
      const result = await runCLI(['schema', 'list', '--verbose'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Required fields should have [required] marker
      expect(result.stdout).toContain('[required]');
    });

    it('should show output directories', async () => {
      const result = await runCLI(['schema', 'list', '--verbose'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should show output directories with arrow notation
      expect(result.stdout).toContain('-> Objectives/Tasks');
    });

    it('should show computed directories for types without explicit output_dir', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-verbose-computed-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            // Top-level type with NO explicit output_dir
            bookmark: {
              extends: 'meta',
              fields: {
                url: { prompt: 'text' }
              }
            },
            // Nested type also without explicit output_dir
            article: {
              extends: 'bookmark',
              fields: {
                author: { prompt: 'text' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', '--verbose'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        // Should show computed directories for both types
        expect(result.stdout).toContain('bookmark');
        expect(result.stdout).toContain('-> bookmarks');
        expect(result.stdout).toContain('article');
        // Nested type should show hierarchical computed directory
        expect(result.stdout).toContain('-> bookmarks/articles');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should work with inheritance chains', async () => {
      // Create a schema with 3-level inheritance
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-verbose-'));
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
            objective: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', options: ['raw', 'done'] }
              }
            },
            task: {
              extends: 'objective',
              output_dir: 'Tasks',
              fields: {
                deadline: { prompt: 'text' }
              }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'list', '--verbose'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        // Should show all three types
        expect(result.stdout).toContain('objective');
        expect(result.stdout).toContain('task');
        // Task should show extends
        expect(result.stdout).toContain('(extends objective)');
        // Should show own and inherited fields
        expect(result.stdout).toContain('deadline');
        expect(result.stdout).toContain('status');
        expect(result.stdout).toContain('created');
        // Inherited fields should be marked
        expect(result.stdout).toContain('(inherited)');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    describe('--output json', () => {
      it('should return verbose structured data', async () => {
        const result = await runCLI(['schema', 'list', '--verbose', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.version).toBe(2);
        expect(data.types).toBeDefined();
        expect(Array.isArray(data.types)).toBe(true);
      });

      it('should include own_fields and inherited_fields', async () => {
        // Create a schema with inheritance
        const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-verbose-json-'));
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
              task: {
                extends: 'meta',
                output_dir: 'Tasks',
                fields: {
                  status: { prompt: 'select', options: ['raw', 'done'] }
                }
              }
            }
          })
        );

        try {
          const result = await runCLI(
            ['schema', 'list', '--verbose', '--output', 'json'],
            tempVaultDir
          );

          expect(result.exitCode).toBe(0);
          const data = JSON.parse(result.stdout);

          // Find task type in array
          const taskType = data.types.find((t: { name: string }) => t.name === 'task');
          expect(taskType).toBeDefined();
          
          // Should have own_fields
          expect(taskType.own_fields).toBeDefined();
          expect(taskType.own_fields.status).toBeDefined();
          expect(taskType.own_fields.status.type).toBe('select');
          
          // Should have inherited_fields grouped by origin
          expect(taskType.inherited_fields).toBeDefined();
          expect(taskType.inherited_fields.meta).toBeDefined();
          expect(taskType.inherited_fields.meta.created).toBeDefined();
          
          // extends: 'meta' is hidden for cleaner output (meta is implicit parent)
          expect(taskType.extends).toBeUndefined();
          
          // Should have output_dir
          expect(taskType.output_dir).toBe('Tasks');
        } finally {
          await rm(tempVaultDir, { recursive: true, force: true });
        }
      });

      it('should include subtypes array for parent types', async () => {
        const result = await runCLI(['schema', 'list', '--verbose', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);

        // Find objective type (which has task and milestone as subtypes)
        const objectiveType = data.types.find((t: { name: string }) => t.name === 'objective');
        expect(objectiveType).toBeDefined();
        expect(objectiveType.subtypes).toBeDefined();
        expect(objectiveType.subtypes).toContain('task');
        expect(objectiveType.subtypes).toContain('milestone');
      });

      it('should include computed output_dir for types without explicit directory', async () => {
        const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-verbose-json-computed-'));
        await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
        await writeFile(
          join(tempVaultDir, '.bwrb', 'schema.json'),
          JSON.stringify({
            version: 2,
            types: {
              meta: {},
              // Type without explicit output_dir
              snippet: {
                extends: 'meta',
                fields: {}
              }
            }
          })
        );

        try {
          const result = await runCLI(
            ['schema', 'list', '--verbose', '--output', 'json'],
            tempVaultDir
          );

          expect(result.exitCode).toBe(0);
          const data = JSON.parse(result.stdout);

          // Find snippet type in array
          const snippetType = data.types.find((t: { name: string }) => t.name === 'snippet');
          expect(snippetType).toBeDefined();
          // Should have computed output_dir (pluralized name)
          expect(snippetType.output_dir).toBe('snippets');
        } finally {
          await rm(tempVaultDir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('schema edit type (unified verb)', () => {
    // Note: edit type is interactive-only in unified verbs
    it.skip('should change output directory (interactive only)', async () => {
      // This test is skipped because schema edit type is interactive
      // and requires PTY testing
    });
  });

  describe('schema edit field (unified verb)', () => {
    // Note: edit field is interactive-only in unified verbs  
    it.skip('should change field properties (interactive only)', async () => {
      // This test is skipped because schema edit field is interactive
      // and requires PTY testing
    });
  });

  describe('deprecated commands removed', () => {
    it('should not show deprecated commands in help output', async () => {
      const result = await runCLI(['schema', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Deprecated commands should not appear
      expect(result.stdout).not.toContain('edit-type');
      expect(result.stdout).not.toContain('edit-field');
      // Modern commands should appear
      expect(result.stdout).toContain('new');
      expect(result.stdout).toContain('edit');
      expect(result.stdout).toContain('delete');
    });

    it('should error when deprecated edit-type command is called', async () => {
      const result = await runCLI(['schema', 'edit-type', 'task'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown command');
    });

    it('should error when deprecated edit-field command is called', async () => {
      const result = await runCLI(['schema', 'edit-field', 'task', 'status'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown command');
    });
  });

  // ============================================
  // NAME INFERENCE FOR EDIT/DELETE (Issue #241)
  // ============================================

  describe('schema edit name inference', () => {
    it('should error with helpful message for unknown name', async () => {
      const result = await runCLI(['schema', 'edit', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'nonexistent' is not a known type or field name");
      expect(result.stderr).toContain('schema list');
    });

    it('should error with disambiguation message when name matches both type and field', async () => {
      // Create a schema where 'status' is both a type name and a field name
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-ambiguous-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            status: {
              output_dir: 'Statuses',
              fields: { value: { prompt: 'text' } }
            },
            task: {
              fields: { status: { prompt: 'select', options: ['raw', 'done'] } }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'edit', 'status'], tempVaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Ambiguous');
        expect(result.stderr).toContain("'status' exists as both a type and a field");
        expect(result.stderr).toContain('schema edit type status');
        expect(result.stderr).toContain('schema edit field status');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should still work with explicit type/field subcommands', async () => {
      // schema edit type task should still work
      // Note: This is interactive, so we test that it doesn't error immediately
      // The actual edit flow would require PTY tests
      const result = await runCLI(['schema', 'edit', 'type', 'nonexistent'], vaultDir);
      
      expect(result.exitCode).toBe(1);
      // Should error with "type does not exist" not "unknown name"
      expect(result.stderr).toContain('does not exist');
    });
  });

  describe('schema delete name inference', () => {
    it('should infer type deletion for known type name (dry-run)', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-infer-'));
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
        // schema delete task should infer it's a type
        const result = await runCLI(['schema', 'delete', 'task'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        // Should show dry-run for type deletion
        expect(result.stdout).toContain('Dry run');
        expect(result.stdout).toContain('delete type');
        expect(result.stdout).toContain('task');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should error with helpful message for unknown name', async () => {
      const result = await runCLI(['schema', 'delete', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("'nonexistent' is not a known type or field name");
    });

    it('should error with disambiguation message when name is ambiguous', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-delete-ambig-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            status: {
              output_dir: 'Statuses',
              fields: { value: { prompt: 'text' } }
            },
            task: {
              fields: { status: { prompt: 'select', options: ['raw', 'done'] } }
            }
          }
        })
      );

      try {
        const result = await runCLI(['schema', 'delete', 'status'], tempVaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Ambiguous');
        expect(result.stderr).toContain('schema delete type status');
        expect(result.stderr).toContain('schema delete field status');
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================
  // GLOBAL OPTIONS REGRESSION TESTS
  // ============================================

  describe('global --vault option', () => {
    // These tests verify that --vault works correctly for deeply nested commands.
    // This is a regression test for issue #134 (brittle cmd.parent chain).

    it('should pass --vault to schema validate (2 levels deep)', async () => {
      const result = await runCLI(['schema', 'validate'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Schema is valid');
    });

    it('should pass --vault to schema list type (3 levels deep)', async () => {
      const result = await runCLI(['schema', 'list', 'type', 'idea'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: idea');
    });

    it('should pass --vault to schema new type (4 levels deep)', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-vault-test-'));
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
          ['schema', 'new', 'type', 'note', '--output', 'json'],
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

    it('should pass --vault to schema delete field (4 levels deep)', async () => {
      const tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-vault-deep-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            task: {
              extends: 'meta',
              fields: { status: { prompt: 'text' } }
            }
          }
        })
      );

      try {
        const result = await runCLI(
          ['schema', 'delete', 'field', 'task', 'status', '--output', 'json'],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.stdout);
        expect(data.success).toBe(true);
        expect(data.data.dryRun).toBe(true);
      } finally {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should pass --vault to schema list fields (3 levels deep)', async () => {
      // Note: --output json has a pre-existing bug in schema list fields (not related to #134)
      // so we test text output mode instead
      const result = await runCLI(['schema', 'list', 'fields'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Fields:');
      expect(result.stdout).toContain('status');
    });
  });
});
