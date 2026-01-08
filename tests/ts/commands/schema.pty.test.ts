import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  withTempVault,
  shouldSkipPtyTests,
} from '../lib/pty-helpers.js';
import { BASELINE_SCHEMA } from '../fixtures/schemas.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

describePty('schema new type PTY tests', () => {
  describe('type inheritance prompt', () => {
    it('should prompt for parent type when creating a new type', async () => {
      await withTempVault(
        ['schema', 'new', 'type', 'subtask'],
        async (proc, vaultPath) => {
          // Should prompt for parent type selection
          await proc.waitFor('Extend from type', 10000);

          // Should show Root option and existing types
          await proc.waitFor('Root (extends meta)', 5000);
          await proc.waitFor('task', 3000);

          // Select 'task' as parent (number 7 in the alphabetically sorted list)
          proc.write('7');

          // Should show inherited fields info
          await proc.waitFor('Inherited fields from task', 5000);

          // Continue with "Add fields?" prompt
          await proc.waitFor('Add fields', 5000);
          proc.write('n');

          // Wait for creation
          await proc.waitFor('created', 5000);

          // Verify schema was updated correctly
          const schemaPath = join(vaultPath, '.bwrb/schema.json');
          const schemaContent = await readFile(schemaPath, 'utf-8');
          const schema = JSON.parse(schemaContent);

          expect(schema.types.subtask).toBeDefined();
          expect(schema.types.subtask.extends).toBe('task');
        },
        { schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should allow creating a root type (extends meta)', async () => {
      await withTempVault(
        ['schema', 'new', 'type', 'note'],
        async (proc, vaultPath) => {
          // Should prompt for parent type selection
          await proc.waitFor('Extend from type', 10000);

          // Select Root (extends meta)
          await proc.waitFor('Root (extends meta)', 5000);
          proc.write('\r'); // First option is selected by default

          // Continue with "Add fields?" prompt (no inherited fields message for root)
          await proc.waitFor('Add fields', 5000);
          proc.write('n');

          // Wait for creation
          await proc.waitFor('created', 5000);

          // Verify schema was updated - no extends field for root type
          const schemaPath = join(vaultPath, '.bwrb/schema.json');
          const schemaContent = await readFile(schemaPath, 'utf-8');
          const schema = JSON.parse(schemaContent);

          expect(schema.types.note).toBeDefined();
          expect(schema.types.note.extends).toBeUndefined();
        },
        { schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should skip inheritance prompt when --inherits is provided', async () => {
      await withTempVault(
        ['schema', 'new', 'type', 'subtask', '--inherits', 'task'],
        async (proc, vaultPath) => {
          // Should NOT prompt for parent type, go straight to fields
          await proc.waitFor('Add fields', 10000);
          proc.write('n');

          // Wait for creation
          await proc.waitFor('created', 5000);

          // Verify schema
          const schemaPath = join(vaultPath, '.bwrb/schema.json');
          const schemaContent = await readFile(schemaPath, 'utf-8');
          const schema = JSON.parse(schemaContent);

          expect(schema.types.subtask).toBeDefined();
          expect(schema.types.subtask.extends).toBe('task');
        },
        { schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly at parent selection - no schema changes', async () => {
      await withTempVault(
        ['schema', 'new', 'type', 'subtask'],
        async (proc, vaultPath) => {
          // Get original schema content
          const schemaPath = join(vaultPath, '.bwrb/schema.json');
          const originalContent = await readFile(schemaPath, 'utf-8');
          const originalSchema = JSON.parse(originalContent);

          // Should prompt for parent type selection
          await proc.waitFor('Extend from type', 10000);

          // Cancel with Ctrl+C
          proc.write('\x03');

          // Wait for process to exit
          await proc.waitForExit(5000);

          // Verify schema unchanged
          const newContent = await readFile(schemaPath, 'utf-8');
          const newSchema = JSON.parse(newContent);

          expect(newSchema.types.subtask).toBeUndefined();
          expect(Object.keys(newSchema.types)).toEqual(Object.keys(originalSchema.types));
        },
        { schema: BASELINE_SCHEMA }
      );
    }, 30000);
  });
});
