import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI, TEST_SCHEMA } from '../fixtures/setup.js';

describe('schema enum commands', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('enum list', () => {
    it('should list all enums with values', async () => {
      const result = await runCLI(['schema', 'enum', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('priority');
      expect(result.stdout).toContain('raw');
      expect(result.stdout).toContain('backlog');
    });

    it('should show usage information', async () => {
      const result = await runCLI(['schema', 'enum', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Status is used by task, milestone, and idea
      expect(result.stdout).toContain('Used by:');
    });

    it('should output JSON format', async () => {
      const result = await runCLI(['schema', 'enum', 'list', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.enums).toBeInstanceOf(Array);
      
      const statusEnum = json.data.enums.find((e: { name: string }) => e.name === 'status');
      expect(statusEnum).toBeDefined();
      expect(statusEnum.values).toContain('raw');
      expect(statusEnum.values).toContain('in-flight');
    });

    it('should show empty message when no enums', async () => {
      // Create vault with no enums
      const emptyVaultDir = await mkdtemp(join(tmpdir(), 'pika-noenum-'));
      await mkdir(join(emptyVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(emptyVaultDir, '.pika', 'schema.json'),
        JSON.stringify({ version: 2, types: { note: { output_dir: 'Notes' } } })
      );

      try {
        const result = await runCLI(['schema', 'enum', 'list'], emptyVaultDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No enums defined');
      } finally {
        await rm(emptyVaultDir, { recursive: true, force: true });
      }
    });
  });

  describe('enum add', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      // Create fresh vault for each add test
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-enumadd-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { existing: ['a', 'b'] },
          types: { note: { output_dir: 'Notes' } },
        })
      );
    });

    afterAll(async () => {
      if (tempVaultDir) {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should add enum with --values flag', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', 'severity', '--values', 'low,medium,high,critical'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Created enum "severity"');
      expect(result.stdout).toContain('low');
      expect(result.stdout).toContain('critical');

      // Verify it was written to schema
      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.severity).toEqual(['low', 'medium', 'high', 'critical']);
    });

    it('should output JSON format', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', 'category', '--values', 'bug,feature', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('category');
      expect(json.data.values).toEqual(['bug', 'feature']);
    });

    it('should reject duplicate enum name', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', 'existing', '--values', 'x,y'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject duplicate values', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', 'dups', '--values', 'a,b,a', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('unique');
    });

    it('should reject invalid enum name', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', '123invalid', '--values', 'a,b'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('must start with a letter');
    });

    it('should reject values containing commas', async () => {
      // This tests that individual values are validated
      // Since commas are the separator, "a,b" becomes ["a", "b"], both valid
      // But we can test a value with just whitespace
      const result = await runCLI(
        ['schema', 'enum', 'add', 'spaces', '--values', ' , '],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
    });

    it('should require --values in JSON mode', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'add', 'novals', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--values flag is required');
    });
  });

  describe('enum update', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-enumupd-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: { status: ['open', 'closed', 'pending'] },
          types: { note: { output_dir: 'Notes' } },
        })
      );
    });

    afterAll(async () => {
      if (tempVaultDir) {
        await rm(tempVaultDir, { recursive: true, force: true });
      }
    });

    it('should add value with --add', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--add', 'archived'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Added "archived"');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.status).toContain('archived');
    });

    it('should remove value with --remove', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--remove', 'pending'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Removed "pending"');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.status).not.toContain('pending');
      expect(schema.enums.status).toContain('open');
      expect(schema.enums.status).toContain('closed');
    });

    it('should rename value with --rename', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--rename', 'open=active'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Renamed "open" to "active"');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.status).not.toContain('open');
      expect(schema.enums.status).toContain('active');
    });

    it('should show warning about updating notes on rename', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--rename', 'open=active'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('pika bulk');
    });

    it('should output JSON format', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--add', 'wip', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.values).toContain('wip');
    });

    it('should reject nonexistent enum', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'nonexistent', '--add', 'val'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });

    it('should reject adding duplicate value', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--add', 'open'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject removing nonexistent value', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--remove', 'nonexistent'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });

    it('should reject removing last value', async () => {
      // First remove two values
      await runCLI(['schema', 'enum', 'update', 'status', '--remove', 'open'], tempVaultDir);
      await runCLI(['schema', 'enum', 'update', 'status', '--remove', 'pending'], tempVaultDir);

      // Try to remove the last one
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--remove', 'closed'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('last value');
    });

    it('should require exactly one operation', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Specify one of');
    });

    it('should reject multiple operations', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'update', 'status', '--add', 'x', '--remove', 'open'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('only one of');
    });
  });

  describe('enum delete', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-enumdel-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify({
          version: 2,
          enums: {
            unused: ['a', 'b', 'c'],
            used: ['x', 'y', 'z'],
          },
          types: {
            note: {
              output_dir: 'Notes',
              fields: {
                category: { prompt: 'select', enum: 'used' },
              },
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

    it('should delete unused enum', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'delete', 'unused'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted enum "unused"');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.unused).toBeUndefined();
      expect(schema.enums.used).toBeDefined();
    });

    it('should refuse to delete enum in use', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'delete', 'used'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Cannot delete');
      expect(result.stderr).toContain('note.category');
    });

    it('should delete enum in use with --force', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'delete', 'used', '--force'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted enum "used"');
      expect(result.stdout).toContain('Warning');
      expect(result.stdout).toContain('note.category');

      const schema = JSON.parse(await readFile(join(tempVaultDir, '.pika', 'schema.json'), 'utf-8'));
      expect(schema.enums.used).toBeUndefined();
    });

    it('should output JSON format', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'delete', 'unused', '--output', 'json'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('unused');
    });

    it('should reject nonexistent enum', async () => {
      const result = await runCLI(
        ['schema', 'enum', 'delete', 'nonexistent'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });
  });
});
