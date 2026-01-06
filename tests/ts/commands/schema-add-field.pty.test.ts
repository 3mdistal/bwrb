/**
 * PTY-based integration tests for the `bwrb schema add-field` command.
 *
 * Tests the interactive wizard for adding fields to existing types, including:
 * - Full interactive flow for each prompt type
 * - Cancellation paths at each step
 * - Field validation and error handling
 * - Error cases (no enums for select, no types for dynamic)
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  withTempVault,
  Keys,
  readVaultFile,
  shouldSkipPtyTests,
  killAllPtyProcesses,
} from '../lib/pty-helpers.js';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests() ? describe.skip : describe;

// Schema with existing types and enums for testing the wizard
const WIZARD_SCHEMA = {
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
    },
    project: {
      output_dir: 'Projects',
    },
  },
};

// Schema without enums (for testing select field error)
const NO_ENUM_SCHEMA = {
  version: 2,
  enums: {},
  types: {
    note: {
      output_dir: 'Notes',
    },
  },
};

// Schema without types for dynamic source (for testing dynamic field error)
const MINIMAL_SCHEMA = {
  version: 2,
  enums: {
    status: ['open', 'closed'],
  },
  types: {},
};

describePty('bwrb schema add-field PTY tests', () => {
  // Clean up any orphaned PTY processes after each test
  afterEach(() => {
    killAllPtyProcesses();
  });

  // ==========================================================================
  // Full Interactive Flow
  // ==========================================================================
  describe('full interactive flow', () => {
    it('should add an input field interactively', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          // Field name prompt
          await proc.waitFor('Field name');
          await proc.typeAndEnter('description');

          // Prompt type selection
          await proc.waitFor('Prompt type');
          proc.write('1'); // input (text)

          // Required prompt
          await proc.waitFor('Required');
          proc.write('n');

          // Default value prompt
          await proc.waitFor('Default value');
          proc.write(Keys.ENTER); // blank

          // Wait for success
          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          // Verify schema was updated
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.description).toEqual({
            prompt: 'text',
            required: false,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a select field with enum selection', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('mypriority');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select (enum)

          // Enum selection - insertion order: status=1, priority=2
          await proc.waitFor('Enum to use');
          await proc.waitForStable(100);
          proc.write('2'); // priority

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          await proc.typeAndEnter('medium');

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.mypriority).toMatchObject({
            prompt: 'select',
            enum: 'priority',
            default: 'medium',
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a date field', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('due-date');

          await proc.waitFor('Prompt type');
          proc.write('3'); // date

          await proc.waitFor('Required');
          proc.write('y');

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields['due-date']).toMatchObject({
            prompt: 'date',
            required: true,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a multi-input field', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('tags');

          await proc.waitFor('Prompt type');
          proc.write('4'); // multi-input (list)

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.tags).toMatchObject({
            prompt: 'list',
            required: false,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a dynamic field with source and format', async () => {
      await withTempVault(
        ['schema', 'add-field', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent-project');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic (from other notes)

          // Source type selection - insertion order: note=1, task=2, project=3
          await proc.waitFor('Source type');
          proc.write('3'); // project

          // Link format: plain, wikilink, quoted-wikilink
          await proc.waitFor('Link format');
          proc.write('2'); // wikilink

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields['parent-project']).toMatchObject({
            prompt: 'relation',
            source: 'project',
            format: 'wikilink',
            required: false,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a fixed value field', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('type');

          await proc.waitFor('Prompt type');
          proc.write('6'); // fixed value

          await proc.waitFor('Fixed value');
          await proc.typeAndEnter('project');

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.type).toEqual({
            value: 'project',
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add a required field with no default prompt', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('name');

          await proc.waitFor('Prompt type');
          proc.write('1'); // input

          await proc.waitFor('Required');
          proc.write('y');

          // Should not prompt for default when required
          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.name).toEqual({
            prompt: 'text',
            required: true,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Field Name Pre-provided
  // ==========================================================================
  describe('field name provided as argument', () => {
    it('should skip field name prompt when provided', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project', 'description'],
        async (proc, vaultPath) => {
          // Should go straight to prompt type
          await proc.waitFor('Prompt type');
          proc.write('1'); // input

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields.description).toBeDefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Cancellation Paths
  // ==========================================================================
  describe('cancellation paths', () => {
    it('should cancel cleanly at field name prompt', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          // Schema should not have new field
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at prompt type selection', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('myfield');

          await proc.waitFor('Prompt type');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at required prompt', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('myfield');

          await proc.waitFor('Prompt type');
          proc.write('1'); // input

          await proc.waitFor('Required');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at enum selection', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('mystatus');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select

          await proc.waitFor('Enum to use');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at source type selection', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic

          await proc.waitFor('Source type');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at fixed value prompt', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('type');

          await proc.waitFor('Prompt type');
          proc.write('6'); // fixed value

          await proc.waitFor('Fixed value');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.project.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('error handling', () => {
    it('should show error for non-existent type', async () => {
      await withTempVault(
        ['schema', 'add-field', 'nonexistent'],
        async (proc) => {
          await proc.waitFor('does not exist');
          await proc.waitForExit(5000);
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should show error when selecting select field with no enums', async () => {
      await withTempVault(
        ['schema', 'add-field', 'note'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('status');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select (enum)

          // Should show error about no enums
          await proc.waitFor('No enums defined');

          await proc.waitForExit(5000);

          // Schema should not have new field
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.note.fields).toBeUndefined();
        },
        { schema: NO_ENUM_SCHEMA }
      );
    }, 30000);

    it('should allow dynamic field when at least one type exists', async () => {
      // With only one type, dynamic source selection shows that one type
      const schemaWithOneType = {
        ...MINIMAL_SCHEMA,
        types: {
          note: { output_dir: 'Notes' },
        },
      };

      await withTempVault(
        ['schema', 'add-field', 'note'],
        async (proc, vaultPath) => {
          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic

          // Should show source type selection with 'note' as the only option
          await proc.waitFor('Source type');
          proc.write('1'); // note (only option)

          await proc.waitFor('Link format');
          proc.write('1'); // plain

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.note.fields.parent).toMatchObject({
            prompt: 'relation',
            source: 'note',
          });
        },
        { schema: schemaWithOneType }
      );
    }, 30000);

    it('should show error for duplicate field on same type', async () => {
      await withTempVault(
        ['schema', 'add-field', 'note', 'status'],
        async (proc) => {
          // status already exists on note
          await proc.waitFor('already exists');
          await proc.waitForExit(5000);
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should show error for inherited field', async () => {
      await withTempVault(
        ['schema', 'add-field', 'task', 'status'],
        async (proc) => {
          // status is inherited from note
          await proc.waitFor('inherited');
          await proc.waitForExit(5000);
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should show error for invalid field name', async () => {
      await withTempVault(
        ['schema', 'add-field', 'project', '123invalid'],
        async (proc) => {
          await proc.waitFor('must start with a lowercase letter');
          await proc.waitForExit(5000);
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });
});
