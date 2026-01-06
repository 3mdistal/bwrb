import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

describe('schema add-type command', () => {
  let tempVaultDir: string;

  beforeEach(async () => {
    // Create fresh vault for each test
    tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-addtype-'));
    await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(tempVaultDir, '.bwrb', 'schema.json'),
      JSON.stringify({
        version: 2,
        types: {
          note: {
            output_dir: 'Notes',
            fields: {
              status: { prompt: 'select', options: ['open', 'closed'] },
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

  describe('basic type creation (JSON mode)', () => {
    it('should create a simple type with --output-dir', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'task', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('task');
      expect(json.data.output_dir).toBe('Tasks');

      // Verify schema was updated
      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.task).toBeDefined();
      expect(schema.types.task.output_dir).toBe('Tasks');
    });

    it('should create a type extending another type', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'task', '--extends', 'note', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.extends).toBe('note');

      // Verify schema
      const schema = JSON.parse(await readFile(join(tempVaultDir, '.bwrb', 'schema.json'), 'utf-8'));
      expect(schema.types.task.extends).toBe('note');
    });

    it('should create type with minimal options (no output-dir)', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('task');

      // Schema should still be valid
      const validateResult = await runCLI(
        ['schema', 'validate', '--output', 'json'],
        tempVaultDir
      );
      expect(validateResult.exitCode).toBe(0);
    });
  });

  describe('validation', () => {
    it('should reject duplicate type name', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'note', '--output-dir', 'Notes2', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('should reject invalid type name starting with number', async () => {
      const result = await runCLI(
        ['schema', 'add-type', '123task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('must start with a lowercase letter');
    });

    it('should reject type name with uppercase letters', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'MyTask', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('must start with a lowercase letter');
    });

    it('should reject type name with spaces', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'my task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });

    it('should reject reserved name "meta"', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'meta', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('reserved');
    });

    it('should reject non-existent parent type', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'task', '--extends', 'nonexistent', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('does not exist');
    });
  });

  describe('type names with hyphens', () => {
    it('should allow type names with hyphens', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'bug-report', '--output-dir', 'BugReports', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('bug-report');
    });
  });

  describe('schema validation after add', () => {
    it('should maintain valid schema after adding type', async () => {
      // Add a type
      await runCLI(
        ['schema', 'add-type', 'task', '--extends', 'note', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      // Validate schema
      const result = await runCLI(
        ['schema', 'validate', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('should show new type in schema show', async () => {
      // Add a type
      await runCLI(
        ['schema', 'add-type', 'task', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      // Check schema show
      const result = await runCLI(
        ['schema', 'show'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('task');
    });

    it('should show type details for new type', async () => {
      // Add a type with parent
      await runCLI(
        ['schema', 'add-type', 'task', '--extends', 'note', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      // Check type details
      const result = await runCLI(
        ['schema', 'show', 'task'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Type: task');
      expect(result.stdout).toContain('Tasks');
      expect(result.stdout).toContain('Extends:');
      expect(result.stdout).toContain('note');
    });
  });

  describe('text mode output', () => {
    // Note: Text mode tests require interactive input unless all options are provided via flags
    // These tests would require PTY testing for the interactive flow
    // For now, we test text mode error messages which don't require interactive input
    
    it('should show error message in text mode', async () => {
      const result = await runCLI(
        ['schema', 'add-type', 'note', '--output-dir', 'Notes2'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should show validation error in text mode', async () => {
      const result = await runCLI(
        ['schema', 'add-type', '123invalid'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('must start with a lowercase letter');
    });
  });

  describe('inheritance works correctly', () => {
    it('should inherit fields from parent type', async () => {
      // Add child type that extends note (which has status field)
      await runCLI(
        ['schema', 'add-type', 'task', '--extends', 'note', '--output-dir', 'Tasks', '--output', 'json'],
        tempVaultDir
      );

      // Check that task has inherited fields
      const result = await runCLI(
        ['schema', 'show', 'task', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.fields).toBeDefined();
      expect(json.fields.status).toBeDefined(); // Inherited from note
    });
  });
});
