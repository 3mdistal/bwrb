/**
 * PTY tests for schema edit-field command
 * Tests interactive mode behavior
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  withTempVault,
  readVaultFile,
  shouldSkipPtyTests,
  killAllPtyProcesses,
} from '../lib/pty-helpers.js';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const skipPty = shouldSkipPtyTests();

afterEach(() => {
  killAllPtyProcesses();
});

// Test schema with fields that can be edited
const TEST_SCHEMA = {
  types: {
    task: {
      output_dir: 'Tasks',
      fields: {
        title: { prompt: 'text', required: true },
        status: { prompt: 'select', options: ['todo', 'in-progress', 'done'] },
        priority: { prompt: 'select', options: ['low', 'medium', 'high'], default: 'medium' },
        notes: { prompt: 'text', label: 'Additional Notes' },
      },
    },
    project: {
      output_dir: 'Projects',
      fields: {
        name: { prompt: 'text', required: true },
        deadline: { prompt: 'date' },
      },
    },
  },
};

describe.skipIf(skipPty)('schema edit-field PTY', () => {
  // ==========================================================================
  // CLI Flag Mode (non-interactive)
  // ==========================================================================
  describe('CLI flag mode', () => {
    it('should set field to required with --required flag', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes', '--required'],
        async (proc, vaultPath) => {
          await proc.waitForExit(10000);

          // Verify the field was updated
          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.required).toBe(true);
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should set field to not required with --not-required flag', async () => {
      // Start with a required field
      const schemaWithRequired = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          task: {
            ...TEST_SCHEMA.types.task,
            fields: {
              ...TEST_SCHEMA.types.task.fields,
              notes: { ...TEST_SCHEMA.types.task.fields.notes, required: true },
            },
          },
        },
      };

      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes', '--not-required'],
        async (proc, vaultPath) => {
          await proc.waitForExit(10000);

          // Verify the field was updated
          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.required).toBeUndefined();
        },
        { schema: schemaWithRequired }
      );
    }, 30000);

    it('should set default value with --default flag', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes', '--default', 'N/A'],
        async (proc, vaultPath) => {
          await proc.waitForExit(10000);

          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.default).toBe('N/A');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should clear default with --clear-default flag', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'priority', '--clear-default'],
        async (proc, vaultPath) => {
          await proc.waitForExit(10000);

          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.priority.default).toBeUndefined();
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should set label with --label flag', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes', '--label', 'Extra Notes'],
        async (proc, vaultPath) => {
          await proc.waitForExit(10000);

          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.label).toBe('Extra Notes');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Full Interactive Flow
  // ==========================================================================
  describe('full interactive flow', () => {
    it('should edit field required status interactively', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes'],
        async (proc, vaultPath) => {
          // Wait for "Required?" selection prompt
          await proc.waitFor('Required?');
          // Select 'true' (arrow down to select, or just press enter since it's a selection)
          await proc.typeAndEnter('true');

          // Wait for "Default value" input prompt
          await proc.waitFor('Default value');
          // Press enter to keep empty/current value
          await proc.typeAndEnter('');

          // Wait for "Prompt label" input prompt
          await proc.waitFor('Prompt label');
          // Press enter to keep current value
          await proc.typeAndEnter('');

          // Wait for completion
          await proc.waitForExit(10000);

          // Verify the field was updated
          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.required).toBe(true);
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should edit field default value interactively', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes'],
        async (proc, vaultPath) => {
          // Wait for "Required?" selection prompt
          await proc.waitFor('Required?');
          await proc.typeAndEnter('false');

          // Wait for "Default value" input prompt
          await proc.waitFor('Default value');
          await proc.typeAndEnter('No notes provided');

          // Wait for "Prompt label" input prompt
          await proc.waitFor('Prompt label');
          await proc.typeAndEnter('');

          await proc.waitForExit(10000);

          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.default).toBe('No notes provided');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should edit field label interactively', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'notes'],
        async (proc, vaultPath) => {
          // Wait for "Required?" selection prompt
          await proc.waitFor('Required?');
          await proc.typeAndEnter('false');

          // Wait for "Default value" input prompt
          await proc.waitFor('Default value');
          await proc.typeAndEnter('');

          // Wait for "Prompt label" input prompt
          await proc.waitFor('Prompt label');
          await proc.typeAndEnter('Extra Notes');

          await proc.waitForExit(10000);

          const schema = JSON.parse(
            await readVaultFile(vaultPath, '.bwrb/schema.json')
          );
          expect(schema.types.task.fields.notes.label).toBe('Extra Notes');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);
  });

  // ==========================================================================
  // Error Cases
  // ==========================================================================
  describe('error cases', () => {
    it('should error on unknown type', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'nonexistent', 'field', '--required'],
        async (proc) => {
          await proc.waitFor('Unknown type');
          await proc.waitForExit(10000);
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should error on unknown field', async () => {
      await withTempVault(
        ['schema', 'edit-field', 'task', 'nonexistent', '--required'],
        async (proc) => {
          await proc.waitFor('not found');
          await proc.waitForExit(10000);
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);
  });
});
