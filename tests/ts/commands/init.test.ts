import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

describe('init command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bwrb-init-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ============================================================================
  // Basic initialization (non-interactive with --yes)
  // ============================================================================

  describe('non-interactive initialization (--yes)', () => {
    it('should create .bwrb directory and schema.json', async () => {
      // Note: init takes path as positional arg, not via --vault
      const result = await runCLI(['init', tempDir, '--yes']);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tempDir, '.bwrb'))).toBe(true);
      expect(existsSync(join(tempDir, '.bwrb', 'schema.json'))).toBe(true);
    });

    it('should create valid schema with version 2', async () => {
      await runCLI(['init', tempDir, '--yes']);

      const schemaContent = await readFile(join(tempDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema.version).toBe(2);
      expect(schema.$schema).toBe('https://bwrb.dev/schema.json');
      expect(schema.types).toEqual({});
    });

    it('should set default link_format to wikilink', async () => {
      await runCLI(['init', tempDir, '--yes']);

      const schemaContent = await readFile(join(tempDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema.config.link_format).toBe('wikilink');
    });

    it('should output success message', async () => {
      const result = await runCLI(['init', tempDir, '--yes']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initialized bwrb vault');
      expect(result.stdout).toContain('Next steps');
      expect(result.stdout).toContain('bwrb schema new type');
    });

    it('should output JSON when --output json is specified', async () => {
      const result = await runCLI(['init', tempDir, '--yes', '--output', 'json']);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.vault).toBe(tempDir);
      expect(json.data.schema_path).toContain('.bwrb/schema.json');
      expect(json.data.config.link_format).toBe('wikilink');
    });
  });

  // ============================================================================
  // Path argument
  // ============================================================================

  describe('path argument', () => {
    it('should initialize at specified path', async () => {
      const subDir = join(tempDir, 'my-vault');
      await mkdir(subDir);

      const result = await runCLI(['init', subDir, '--yes']);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(subDir, '.bwrb', 'schema.json'))).toBe(true);
    });

    it('should error if path does not exist', async () => {
      const nonExistent = join(tempDir, 'does-not-exist');

      const result = await runCLI(['init', nonExistent, '--yes']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Directory does not exist');
    });

    it('should error if path is a file', async () => {
      const filePath = join(tempDir, 'some-file.txt');
      await writeFile(filePath, 'content');

      const result = await runCLI(['init', filePath, '--yes']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a directory');
    });
  });

  // ============================================================================
  // Existing vault handling
  // ============================================================================

  describe('existing vault handling', () => {
    beforeEach(async () => {
      // Create existing .bwrb/
      await mkdir(join(tempDir, '.bwrb'));
      await writeFile(
        join(tempDir, '.bwrb', 'schema.json'),
        JSON.stringify({ version: 2, types: { old: {} } })
      );
    });

    it('should error if .bwrb/ already exists without --force', async () => {
      const result = await runCLI(['init', tempDir, '--yes']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already initialized');
      expect(result.stderr).toContain('--force');
    });

    it('should output JSON error if vault exists', async () => {
      const result = await runCLI(['init', tempDir, '--yes', '--output', 'json']);

      expect(result.exitCode).not.toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already initialized');
    });

    it('should reinitialize with --force --yes', async () => {
      const result = await runCLI(['init', tempDir, '--force', '--yes']);

      expect(result.exitCode).toBe(0);

      // Schema should be fresh (empty types)
      const schemaContent = await readFile(join(tempDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);
      expect(schema.types).toEqual({});
    });

    it('should delete all .bwrb/ contents with --force', async () => {
      // Add some extra files
      await mkdir(join(tempDir, '.bwrb', 'templates', 'task'), { recursive: true });
      await writeFile(join(tempDir, '.bwrb', 'templates', 'task', 'default.md'), 'template');
      await writeFile(join(tempDir, '.bwrb', 'dashboards.json'), '{}');

      await runCLI(['init', tempDir, '--force', '--yes']);

      // Only schema.json should exist
      const contents = await readdir(join(tempDir, '.bwrb'));
      expect(contents).toEqual(['schema.json']);
    });
  });

  // ============================================================================
  // Obsidian auto-detection
  // ============================================================================

  describe('Obsidian auto-detection', () => {
    it('should auto-detect Obsidian vault name when .obsidian exists', async () => {
      await mkdir(join(tempDir, '.obsidian'));

      await runCLI(['init', tempDir, '--yes']);

      const schemaContent = await readFile(join(tempDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);

      // The vault name should be the directory name
      expect(schema.config.obsidian_vault).toBeDefined();
    });

    it('should include obsidian_vault in JSON output when detected', async () => {
      await mkdir(join(tempDir, '.obsidian'));

      const result = await runCLI(['init', tempDir, '--yes', '--output', 'json']);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.data.config.obsidian_vault).toBeDefined();
    });

    it('should not include obsidian_vault when .obsidian does not exist', async () => {
      await runCLI(['init', tempDir, '--yes']);

      const schemaContent = await readFile(join(tempDir, '.bwrb', 'schema.json'), 'utf-8');
      const schema = JSON.parse(schemaContent);

      expect(schema.config.obsidian_vault).toBeUndefined();
    });
  });

  // ============================================================================
  // Schema validation
  // ============================================================================

  describe('generated schema validation', () => {
    it('should generate schema that passes bwrb schema validate', async () => {
      await runCLI(['init', tempDir, '--yes']);

      // The schema should be valid and usable by other commands
      const result = await runCLI(['schema', 'list', '--output', 'json'], tempDir);

      expect(result.exitCode).toBe(0);
      // schema list --output json returns the raw schema, not a success wrapper
      const json = JSON.parse(result.stdout);
      expect(json.version).toBe(2);
      expect(json.types).toEqual({});
    });

    it('should generate schema that allows creating types', async () => {
      await runCLI(['init', tempDir, '--yes']);

      // Should be able to add a type to the fresh schema
      const result = await runCLI(
        ['schema', 'new', 'type', 'note', '--output', 'json'],
        tempDir
      );

      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================================
  // Error handling
  // ============================================================================

  describe('error handling', () => {
    it('should handle permission errors gracefully', async () => {
      // This test is environment-dependent, skip if not applicable
      // The command should at least not crash with an unhandled error
      const result = await runCLI(['init', '/root/should-not-exist-12345', '--yes']);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBeTruthy();
    });

    it('should output JSON error on failure when --output json', async () => {
      const result = await runCLI(['init', '/nonexistent/path', '--yes', '--output', 'json']);

      expect(result.exitCode).not.toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toBeDefined();
    });
  });

  // ============================================================================
  // Help and usage
  // ============================================================================

  describe('help and usage', () => {
    it('should show help with --help', async () => {
      const result = await runCLI(['init', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initialize a new bwrb vault');
      expect(result.stdout).toContain('--yes');
      expect(result.stdout).toContain('--force');
      expect(result.stdout).toContain('--output');
    });

    it('should show examples in help', async () => {
      const result = await runCLI(['init', '--help']);

      expect(result.stdout).toContain('Examples:');
      expect(result.stdout).toContain('bwrb init');
    });
  });
});
