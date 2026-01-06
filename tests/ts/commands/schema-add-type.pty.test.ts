/**
 * PTY-based integration tests for the `bwrb schema add-type` command.
 *
 * Tests the interactive wizard for creating new type definitions, including:
 * - Full interactive flow (extends, output dir, field wizard)
 * - Field wizard prompt type variants (input, select, date, dynamic, fixed)
 * - Cancellation paths at each step
 * - Field validation and retry behavior
 * - Error handling (non-existent parent type, no enums for select)
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

// Schema without types (for testing dynamic field error)
const MINIMAL_SCHEMA = {
  version: 2,
  enums: {
    status: ['open', 'closed'],
  },
  types: {},
};

describePty('bwrb schema add-type PTY tests', () => {
  // Clean up any orphaned PTY processes after each test
  afterEach(() => {
    killAllPtyProcesses();
  });

  // ==========================================================================
  // Full Interactive Flow
  // ==========================================================================
  describe('full interactive flow', () => {
    it('should create a type with extends and custom output directory', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          // Extend from type? prompt
          await proc.waitFor('Extend from type');
          await proc.typeAndEnter('note');

          // Output directory prompt
          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          // Add fields now? prompt
          await proc.waitFor('Add fields now');
          proc.write('n');

          // Wait for success
          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          // Verify schema was updated
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
          expect(schema.types.task.extends).toBe('note');
          expect(schema.types.task.output_dir).toBe('Tasks');
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should create type without extends when blank is entered', async () => {
      await withTempVault(
        ['schema', 'add-type', 'idea'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER); // Blank = no extends

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Ideas');

          await proc.waitFor('Add fields now');
          proc.write('n');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.idea).toBeDefined();
          expect(schema.types.idea.extends).toBeUndefined();
          expect(schema.types.idea.output_dir).toBe('Ideas');
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should accept default output directory when Enter is pressed', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          // Output directory prompt should show a default
          await proc.waitFor('Output directory');
          proc.write(Keys.ENTER); // Accept default

          await proc.waitFor('Add fields now');
          proc.write('n');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
          // Default is computed, just verify it exists
          expect(schema.types.task.output_dir).toBeDefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should create type with multiple fields', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          // First field: description (input)
          await proc.waitFor('Field name');
          await proc.typeAndEnter('description');

          await proc.waitFor('Prompt type');
          proc.write('1'); // input (text)

          await proc.waitFor('Required');
          proc.write('y');

          await proc.waitFor('Added field');

          // Second field: priority (select)
          await proc.waitFor('Field name');
          await proc.typeAndEnter('priority');

          await proc.waitFor('Prompt type');
          await proc.waitForStable(100); // Wait for prompt to stabilize
          proc.write('2'); // select (enum)

          // Enum order is insertion order: status=1, priority=2
          await proc.waitFor('Enum to use');
          await proc.waitForStable(100);
          proc.write('2'); // priority

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          await proc.typeAndEnter('medium');

          await proc.waitFor('Added field');

          // Done
          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields.description).toEqual({
            prompt: 'text',
            required: true,
          });
          expect(schema.types.task.fields.priority).toEqual({
            prompt: 'select',
            enum: 'priority',
            required: false,
            default: 'medium',
          });
          expect(schema.types.task.field_order).toEqual(['description', 'priority']);
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 45000);
  });

  // ==========================================================================
  // Field Wizard - Prompt Type Variants
  // ==========================================================================
  describe('field wizard prompt types', () => {
    it('should add input (text) field through wizard', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('description');

          await proc.waitFor('Prompt type');
          proc.write('1'); // input (text)

          await proc.waitFor('Required');
          proc.write('y');

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields.description).toEqual({
            prompt: 'text',
            required: true,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add select (enum) field with enum selection', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('priority');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select (enum)

          // Enum selection - insertion order: status=1, priority=2
          await proc.waitFor('Enum to use');
          proc.write('2'); // priority

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          await proc.typeAndEnter('medium');

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields.priority).toMatchObject({
            prompt: 'select',
            enum: 'priority',
            required: false,
            default: 'medium',
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add date field through wizard', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('due-date');

          await proc.waitFor('Prompt type');
          proc.write('3'); // date

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER); // blank

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields['due-date']).toMatchObject({
            prompt: 'date',
            required: false,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add multi-input (list) field through wizard', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('tags');

          await proc.waitFor('Prompt type');
          proc.write('4'); // multi-input (list)

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER); // blank

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields.tags).toMatchObject({
            prompt: 'list',
            required: false,
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should add dynamic field with source and format', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent-project');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic (from other notes)

          // Source type selection - types: note, project (alphabetical)
          await proc.waitFor('Source type');
          proc.write('2'); // project

          // Link format: plain, wikilink, quoted-wikilink
          await proc.waitFor('Link format');
          proc.write('2'); // wikilink

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER); // blank

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
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

    it('should add fixed value field', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('type');

          await proc.waitFor('Prompt type');
          proc.write('6'); // fixed value

          await proc.waitFor('Fixed value');
          await proc.typeAndEnter('task');

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields.type).toEqual({
            value: 'task',
          });
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Cancellation Paths
  // ==========================================================================
  describe('cancellation paths', () => {
    it('should cancel cleanly at extends prompt', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          // Schema should not have task type
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at output directory prompt', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at add fields prompt', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel during field name input', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeText('partial');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          // Type should NOT have been created (atomic operation)
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel during prompt type selection', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('myfield');

          await proc.waitFor('Prompt type');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel during required prompt', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('myfield');

          await proc.waitFor('Prompt type');
          proc.write('1'); // input

          await proc.waitFor('Required');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel during enum selection for select field', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('status');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select

          await proc.waitFor('Enum to use');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should cancel during source type selection for dynamic field', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic

          await proc.waitFor('Source type');
          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Early Completion (Done Path)
  // ==========================================================================
  describe('early completion', () => {
    it('should complete without adding any fields when done immediately', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          // Immediately type "done"
          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
          expect(schema.types.task.fields).toBeUndefined(); // No fields
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should complete when "Add fields now" is answered no', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('n');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
          expect(schema.types.task.output_dir).toBe('Tasks');
          expect(schema.types.task.fields).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should complete with empty field name (just press Enter)', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          // Press Enter without typing anything (treated as "done")
          await proc.waitFor('Field name');
          proc.write(Keys.ENTER);

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Field Validation and Retry
  // ==========================================================================
  describe('field validation', () => {
    it('should show error and retry for invalid field name starting with number', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          // Enter invalid field name
          await proc.waitFor('Field name');
          await proc.typeAndEnter('123invalid');

          // Should show error
          await proc.waitFor('must start with a lowercase letter');

          // Should prompt again
          await proc.waitFor('Field name');
          await proc.typeAndEnter('valid-field');

          await proc.waitFor('Prompt type');
          proc.write('1');

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields['valid-field']).toBeDefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 45000);

    it('should show error and retry for field name with special characters', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          // Enter invalid field name with special characters
          // Note: uppercase is converted to lowercase before validation,
          // so we need to use characters that are still invalid after lowercasing
          await proc.waitFor('Field name');
          await proc.typeAndEnter('my_field'); // underscore is not allowed

          // Should show error
          await proc.waitFor('must start with a lowercase letter');

          // Should prompt again
          await proc.waitFor('Field name');
          await proc.typeAndEnter('my-field'); // hyphen is allowed

          await proc.waitFor('Prompt type');
          proc.write('1');

          await proc.waitFor('Required');
          proc.write('n');

          await proc.waitFor('Default value');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added field');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task.fields['my-field']).toBeDefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 45000);
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('error handling', () => {
    it('should show error for non-existent parent type', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          await proc.typeAndEnter('nonexistent');

          // Should show error
          await proc.waitFor('does not exist');

          await proc.waitForExit(5000);

          // Schema should not have task type
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeUndefined();
        },
        { schema: WIZARD_SCHEMA }
      );
    }, 30000);

    it('should show error when selecting select field with no enums', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          await proc.waitFor('Extend from type');
          proc.write(Keys.ENTER);

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('status');

          await proc.waitFor('Prompt type');
          proc.write('2'); // select (enum)

          // Should show error about no enums
          await proc.waitFor('No enums defined');

          // Should re-prompt for field name (retry loop)
          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
          expect(schema.types.task.fields).toBeUndefined();
        },
        { schema: NO_ENUM_SCHEMA }
      );
    }, 45000);

    it('should show error when selecting dynamic field with no types', async () => {
      await withTempVault(
        ['schema', 'add-type', 'task'],
        async (proc, vaultPath) => {
          // Note: Using MINIMAL_SCHEMA which has no types
          // But add-type won't prompt for extends if there are no types

          await proc.waitFor('Output directory');
          await proc.typeAndEnter('Tasks');

          await proc.waitFor('Add fields now');
          proc.write('y');

          await proc.waitFor('Field name');
          await proc.typeAndEnter('parent');

          await proc.waitFor('Prompt type');
          proc.write('5'); // dynamic

          // Should show error about no types
          await proc.waitFor('No types defined');

          // Should re-prompt for field name
          await proc.waitFor('Field name');
          await proc.typeAndEnter('done');

          await proc.waitFor('Created type');
          await proc.waitForExit(5000);

          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.types.task).toBeDefined();
        },
        { schema: MINIMAL_SCHEMA }
      );
    }, 45000);
  });
});
