import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI, TEST_SCHEMA } from '../fixtures/setup.js';
import { parseNote } from '../../../src/lib/frontmatter.js';

describe('bulk command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('basic validation', () => {
    it('should show usage when no targeting provided', async () => {
      const result = await runCLI(['bulk'], vaultDir);
      expect(result.exitCode).toBe(1);
      // New behavior: shows "No files selected" with available options
      expect(result.stderr).toContain('No files selected');
    });

    it('should reject unknown type', async () => {
      const result = await runCLI(['bulk', '--type', 'unknown', '--set', 'status=done'], vaultDir);
      expect(result.exitCode).toBe(1);
      // Error goes to stderr via printError
      expect(result.stderr).toContain('Unknown type: unknown');
    });

    it('should require at least one operation', async () => {
      // Note: --all satisfies the targeting gate, so we can test the operation requirement
      const result = await runCLI(['bulk', 'idea', '--all'], vaultDir);
      expect(result.exitCode).toBe(1);
      // Error goes to stderr via printError
      expect(result.stderr).toContain('No operations specified');
    });

    it('should validate enum values', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=invalid'], vaultDir);
      expect(result.exitCode).toBe(1);
      // Error goes to stderr via printError
      expect(result.stderr).toContain("Invalid value 'invalid' for field 'status'");
    });
  });

  describe('targeting gate (--all flag)', () => {
    it('should succeed with --type selector (type is explicit targeting)', async () => {
      // In unified targeting model, --type IS explicit targeting
      const result = await runCLI(['bulk', '--type', 'idea', '--set', 'status=settled'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
    });

    it('should error when no selectors at all', async () => {
      const result = await runCLI(['bulk', '--set', 'status=settled'], vaultDir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No files selected');
      expect(result.stdout).toContain('--type');
    });

    it('should succeed with --where selector (no --all needed)', async () => {
      const result = await runCLI([
        'bulk', 'idea', 
        '--where', "status == 'raw'",
        '--set', 'status=settled'
      ], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
    });

    it('should succeed with --all flag (no other selectors)', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--set', 'status=settled'
      ], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would affect 2 file');
    });

    it('should succeed with both --where and --all', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--where', "status == 'raw'",
        '--set', 'status=settled'
      ], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
    });

    it('should show targeting error in JSON mode when no selectors', async () => {
      const result = await runCLI([
        'bulk',
        '--set', 'status=settled',
        '--output', 'json'
      ], vaultDir);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('No files selected');
    });

    it('should work with simple filters when type is provided', async () => {
      // Simple filters work but emit deprecation warning; type provides explicit targeting
      const result = await runCLI([
        'bulk', '--type', 'idea',
        '--status=raw',
        '--set', 'priority=high'
      ], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
    });

    it('should work with --all and --execute', async () => {
      const tempVaultDir = await createTestVault();
      try {
        const result = await runCLI([
          'bulk', 'idea',
          '--all',
          '--set', 'status=settled',
          '--execute'
        ], tempVaultDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated 2 files');
      } finally {
        await cleanupTestVault(tempVaultDir);
      }
    });
  });

  describe('dry-run mode', () => {
    it('should show what would change without modifying files', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=backlog'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('status: raw → backlog');
      expect(result.stdout).toContain('--execute');

      // Verify file wasn't changed
      const { frontmatter } = await parseNote(join(vaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.status).toBe('raw');
    });

    it('should show no changes when nothing matches', async () => {
      const result = await runCLI(['bulk', 'idea', '--where', "status == 'settled'", '--set', 'status=raw'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files match');
    });
  });

  describe('--set operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should set a single field', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      // Verify files were changed
      const { frontmatter: fm1 } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(fm1.status).toBe('settled');

      const { frontmatter: fm2 } = await parseNote(join(tempVaultDir, 'Ideas', 'Another Idea.md'));
      expect(fm2.status).toBe('settled');
    });

    it('should set multiple fields', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--set', 'status=settled',
        '--set', 'priority=low',
        '--execute'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.status).toBe('settled');
      expect(frontmatter.priority).toBe('low');
    });

    it('should clear a field with --set field=', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'priority=', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.priority).toBeUndefined();
    });

    it('should allow setting arbitrary fields (not in schema)', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'custom-field=test', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter['custom-field']).toBe('test');
    });
  });

  describe('--rename operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should rename a field', async () => {
      // First add a field to rename
      await runCLI(['bulk', 'idea', '--all', '--set', 'old-field=value', '--execute'], tempVaultDir);
      
      const result = await runCLI(['bulk', 'idea', '--all', '--rename', 'old-field=new-field', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter['old-field']).toBeUndefined();
      expect(frontmatter['new-field']).toBe('value');
    });

    it('should error when target field already exists', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--rename', 'status=priority', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(1);
      // Error goes to stderr via printError
      expect(result.stderr).toContain('target field already exists');
    });
  });

  describe('--delete operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should delete a field', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--delete', 'priority', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.priority).toBeUndefined();
    });

    it('should not fail when field does not exist', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--delete', 'nonexistent', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      // No files should be modified since field doesn't exist
      expect(result.stdout).toContain('No files match');
    });
  });

  describe('--append operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should append to an existing array', async () => {
      // First set tags as an array
      await runCLI(['bulk', 'idea', '--all', '--set', 'tags=existing', '--execute'], tempVaultDir);
      
      const result = await runCLI(['bulk', 'idea', '--all', '--append', 'tags=newtag', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated 2 files');

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.tags).toContain('existing');
      expect(frontmatter.tags).toContain('newtag');
    });

    it('should create array for new field', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--append', 'labels=urgent', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.labels).toEqual(['urgent']);
    });

    it('should convert scalar to array when appending', async () => {
      // First set a scalar value
      await runCLI(['bulk', 'idea', '--all', '--set', 'scalar-field=first', '--execute'], tempVaultDir);
      
      const result = await runCLI(['bulk', 'idea', '--all', '--append', 'scalar-field=second', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter['scalar-field']).toEqual(['first', 'second']);
    });
  });

  describe('--remove operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
      // Set up array field for testing
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Sample Idea.md'),
        `---
type: idea
status: raw
priority: medium
tags:
  - one
  - two
  - three
---
`
      );
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should remove item from array', async () => {
      const result = await runCLI(['bulk', 'idea', '--remove', 'tags=two', '--execute', '--where', "contains(tags, 'two')"], tempVaultDir);
      
      expect(result.exitCode).toBe(0);

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Sample Idea.md'));
      expect(frontmatter.tags).toEqual(['one', 'three']);
    });

    it('should leave empty array after removing last item', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Single Tag.md'),
        `---
type: idea
status: raw
tags:
  - only
---
`
      );

      const result = await runCLI(['bulk', 'idea', '--remove', 'tags=only', '--execute', '--where', "contains(tags, 'only')"], tempVaultDir);
      
      expect(result.exitCode).toBe(0);

      const { frontmatter } = await parseNote(join(tempVaultDir, 'Ideas', 'Single Tag.md'));
      expect(frontmatter.tags).toEqual([]);
    });
  });

  describe('--where filtering', () => {
    it('should filter by expression', async () => {
      const result = await runCLI(['bulk', 'idea', '--set', 'status=settled', '--where', "status == 'raw'"], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).not.toContain('Another Idea.md'); // This one has backlog status
    });

    it('should combine multiple where expressions with AND', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--set', 'status=settled',
        '--where', "status == 'backlog'",
        '--where', "priority == 'high'"
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Another Idea matches both conditions
      expect(result.stdout).toContain('Another Idea.md');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });
  });

  describe('--path filtering', () => {
    // Tests for Issue #148: --path with directory paths should match files in that directory
    // Previously, `--path Ideas/` or `--path Ideas` would fail because minimatch was called
    // directly without normalizing directory paths to globs.
    
    it('should match files with trailing slash (--path Ideas/)', async () => {
      const result = await runCLI(['bulk', '--path', 'Ideas/', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Another Idea.md');
    });

    it('should match files with bare directory name (--path Ideas)', async () => {
      const result = await runCLI(['bulk', '--path', 'Ideas', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Another Idea.md');
    });

    it('should still work with explicit glob (--path Ideas/**)', async () => {
      const result = await runCLI(['bulk', '--path', 'Ideas/**', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Another Idea.md');
    });

    it('should combine --path with --type (AND composition)', async () => {
      const result = await runCLI(['bulk', '--type', 'idea', '--path', 'Ideas/', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Another Idea.md');
    });

    it('should match nested directories with bare path', async () => {
      const result = await runCLI(['bulk', '--path', 'Objectives', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      // Should match files in Objectives/Tasks and Objectives/Milestones
      expect(result.stdout).toContain('Sample Task.md');
      expect(result.stdout).toContain('Active Milestone.md');
    });

    it('should return no files for non-existent directory', async () => {
      const result = await runCLI(['bulk', '--path', 'NonexistentDir/', '--set', 'test=value'], vaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files match');
    });
  });

  describe('simple filters (--field=value syntax)', () => {
    // Note: Simple filters are deprecated but still work when combined with --all or --where.
    // They do NOT satisfy the targeting gate on their own.
    
    it('should filter with equality when used with --all', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--status=raw',
        '--set', 'priority=high'
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Sample Idea has status=raw
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).not.toContain('Another Idea.md');
    });

    it('should filter with negation when used with --all', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--status!=raw',
        '--set', 'priority=low'
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Another Idea has status!=raw (it's backlog)
      expect(result.stdout).toContain('Another Idea.md');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });

    it('should filter with multiple values (OR) when used with --all', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--status=raw,backlog',
        '--set', 'test=value'
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Both files match (raw or backlog)
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Another Idea.md');
    });

    it('should combine simple filters with AND when used with --all', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--status=backlog',
        '--priority=high',
        '--set', 'test=value'
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Another Idea has both status=backlog AND priority=high
      expect(result.stdout).toContain('Another Idea.md');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });

    it('should combine simple filters with --where expressions', async () => {
      // --where satisfies the targeting gate, simple filters add additional filtering
      const result = await runCLI([
        'bulk', 'idea',
        '--status=backlog',
        '--where', "priority == 'high'",
        '--set', 'test=value'
      ], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Another Idea matches both conditions
      expect(result.stdout).toContain('Another Idea.md');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });

    it('should validate filter field names', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--nonexistent=value',
        '--set', 'status=done'
      ], vaultDir);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'nonexistent'");
    });

    it('should validate filter enum values', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--status=invalid',
        '--set', 'priority=high'
      ], vaultDir);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid value 'invalid'");
    });
  });

  describe('--limit option', () => {
    it('should limit number of files affected', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--limit', '1'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would affect 1 file');
    });

    it('should reject invalid limit', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--limit', 'abc'], vaultDir);
      
      expect(result.exitCode).toBe(1);
      // Error goes to stderr via printError
      expect(result.stderr).toContain('Invalid --limit');
    });
  });

  describe('--backup option', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should create backup when --backup is specified', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--execute', '--backup'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Backup created');
      expect(result.stdout).toContain('.bwrb/backups');
    });
  });

  describe('output modes', () => {
    it('should output JSON with --output json', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--output', 'json'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.dryRun).toBe(true);
      expect(json.data.filesModified).toBeGreaterThan(0);
    });

    it('should show minimal output with --quiet', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--quiet'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would affect');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });

    it('should show detailed output with --verbose', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled', '--verbose'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('status:');
    });
  });

  describe('subtype handling', () => {
    it('should work with subtypes', async () => {
      const result = await runCLI(['bulk', 'task', '--all', '--set', 'status=settled'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task.md');
    });

    it('should work with parent type (affecting all subtypes)', async () => {
      const result = await runCLI(['bulk', 'objective', '--all', '--set', 'status=settled'], vaultDir);
      
      expect(result.exitCode).toBe(0);
      // Should show both task and milestone
      expect(result.stdout).toContain('Sample Task.md');
      expect(result.stdout).toContain('Active Milestone.md');
    });
  });

  describe('--move operation', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await createTestVault();
      // Create Archive directory
      await mkdir(join(tempVaultDir, 'Archive'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Archive', 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await cleanupTestVault(tempVaultDir);
    });

    it('should preview move in dry-run mode', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--move', 'Archive/Ideas'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run');
      expect(result.stdout).toContain('Would move');
      expect(result.stdout).toContain('Sample Idea.md');
      expect(result.stdout).toContain('Archive/Ideas/Sample Idea.md');

      // Verify file wasn't moved
      await expect(readFile(join(tempVaultDir, 'Ideas', 'Sample Idea.md'), 'utf-8')).resolves.toBeDefined();
    });

    it('should move files when --execute is used', async () => {
      const result = await runCLI(['bulk', 'idea', '--all', '--move', 'Archive/Ideas', '--execute'], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Moved');

      // Verify files were moved
      await expect(readFile(join(tempVaultDir, 'Archive', 'Ideas', 'Sample Idea.md'), 'utf-8')).resolves.toBeDefined();
      await expect(readFile(join(tempVaultDir, 'Archive', 'Ideas', 'Another Idea.md'), 'utf-8')).resolves.toBeDefined();
    });

    it('should filter files with --where', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--move', 'Archive/Ideas',
        '--where', "status == 'raw'",
        '--execute'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      // Only Sample Idea has status=raw
      expect(result.stdout).toContain('Moved 1 file');

      // Sample Idea should be moved
      await expect(readFile(join(tempVaultDir, 'Archive', 'Ideas', 'Sample Idea.md'), 'utf-8')).resolves.toBeDefined();
      // Another Idea should NOT be moved (it has backlog status)
      await expect(readFile(join(tempVaultDir, 'Ideas', 'Another Idea.md'), 'utf-8')).resolves.toBeDefined();
    });

    it('should update wikilinks when moving files', async () => {
      // Create a task that references an idea
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Tasks', 'Task With Link.md'),
        `---
type: task
status: active
scope: day
---
This task relates to [[Sample Idea]].
`
      );

      // Create another file with same name for disambiguation
      await mkdir(join(tempVaultDir, 'Other'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Other', 'Sample Idea.md'),
        '# Other Sample Idea\nUnmanaged file with same name.'
      );

      const result = await runCLI([
        'bulk', 'idea',
        '--move', 'Archive/Ideas',
        '--where', "status == 'raw'",
        '--execute'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('wikilink');

      // Check that the task file was updated with the new path
      const taskContent = await readFile(join(tempVaultDir, 'Objectives', 'Tasks', 'Task With Link.md'), 'utf-8');
      expect(taskContent).toContain('[[Archive/Ideas/Sample Idea]]');
    });

    it('should not combine --move with other operations', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--move', 'Archive/Ideas',
        '--set', 'status=settled'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot be combined');
    });

    it('should show JSON output with --output json', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--move', 'Archive/Ideas',
        '--output', 'json'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.dryRun).toBe(true);
      expect(json.data.moves).toBeDefined();
      expect(json.data.moves.length).toBeGreaterThan(0);
    });

    it('should handle --quiet mode', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--move', 'Archive/Ideas',
        '--quiet'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would move');
      expect(result.stdout).not.toContain('Sample Idea.md');
    });

    it('should handle --limit option', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--all',
        '--move', 'Archive/Ideas',
        '--limit', '1',
        '--execute'
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Moved 1 file');
    });

    it('should show no files message when nothing matches', async () => {
      const result = await runCLI([
        'bulk', 'idea',
        '--move', 'Archive/Ideas',
        '--where', "status == 'settled'"
      ], tempVaultDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files match');
    });
  });
});

describe('bulk positional type argument', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('should not show deprecation warning when using positional type', async () => {
    const result = await runCLI(['bulk', 'idea', '--all', '--set', 'status=settled'], vaultDir);

    expect(result.exitCode).toBe(0);
    // Positional type is a permanent shortcut, not deprecated
    expect(result.stderr).not.toContain('deprecated');
    expect(result.stderr).not.toContain('Deprecated');
    expect(result.stdout).not.toContain('deprecated');
  });

  it('should not show deprecation warning for child type positional', async () => {
    const result = await runCLI(['bulk', 'task', '--all', '--set', 'status=settled'], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('deprecated');
    expect(result.stderr).not.toContain('Deprecated');
  });
});

describe('bulk operations unit tests', () => {
  describe('applyOperations', () => {
    // Import dynamically in tests
    let applyOperations: typeof import('../../../src/lib/bulk/operations.js')['applyOperations'];

    beforeAll(async () => {
      const mod = await import('../../../src/lib/bulk/operations.js');
      applyOperations = mod.applyOperations;
    });

    it('should set field value', () => {
      const fm = { existing: 'value' };
      const { modified, changes } = applyOperations(fm, [
        { type: 'set', field: 'new', value: 'test' }
      ]);
      
      expect(modified.new).toBe('test');
      expect(changes).toHaveLength(1);
      expect(changes[0]?.operation).toBe('set');
    });

    it('should rename field', () => {
      const fm = { old: 'value' };
      const { modified, changes } = applyOperations(fm, [
        { type: 'rename', field: 'old', newField: 'new' }
      ]);
      
      expect(modified.old).toBeUndefined();
      expect(modified.new).toBe('value');
      expect(changes).toHaveLength(1);
      expect(changes[0]?.operation).toBe('rename');
    });

    it('should throw when renaming to existing field', () => {
      const fm = { old: 'value1', new: 'value2' };
      expect(() => {
        applyOperations(fm, [
          { type: 'rename', field: 'old', newField: 'new' }
        ]);
      }).toThrow('target field already exists');
    });

    it('should delete field', () => {
      const fm = { field: 'value' };
      const { modified, changes } = applyOperations(fm, [
        { type: 'delete', field: 'field' }
      ]);
      
      expect(modified.field).toBeUndefined();
      expect(changes).toHaveLength(1);
    });

    it('should append to array', () => {
      const fm = { list: ['a', 'b'] };
      const { modified } = applyOperations(fm, [
        { type: 'append', field: 'list', value: 'c' }
      ]);
      
      expect(modified.list).toEqual(['a', 'b', 'c']);
    });

    it('should not append duplicate value', () => {
      const fm = { list: ['a', 'b'] };
      const { modified, changes } = applyOperations(fm, [
        { type: 'append', field: 'list', value: 'a' }
      ]);
      
      expect(modified.list).toEqual(['a', 'b']);
      expect(changes).toHaveLength(0);
    });

    it('should remove from array', () => {
      const fm = { list: ['a', 'b', 'c'] };
      const { modified } = applyOperations(fm, [
        { type: 'remove', field: 'list', value: 'b' }
      ]);
      
      expect(modified.list).toEqual(['a', 'c']);
    });

    it('should leave empty array after removing last item', () => {
      const fm = { list: ['only'] };
      const { modified } = applyOperations(fm, [
        { type: 'remove', field: 'list', value: 'only' }
      ]);
      
      expect(modified.list).toEqual([]);
    });
  });

  describe('buildOperation', () => {
    let buildOperation: typeof import('../../../src/lib/bulk/operations.js')['buildOperation'];

    beforeAll(async () => {
      const mod = await import('../../../src/lib/bulk/operations.js');
      buildOperation = mod.buildOperation;
    });

    it('should parse set operation', () => {
      const op = buildOperation('set', 'field=value');
      expect(op.type).toBe('set');
      expect(op.field).toBe('field');
      expect(op.value).toBe('value');
    });

    it('should parse clear operation', () => {
      const op = buildOperation('set', 'field=');
      expect(op.type).toBe('clear');
      expect(op.field).toBe('field');
    });

    it('should parse rename operation', () => {
      const op = buildOperation('rename', 'old=new');
      expect(op.type).toBe('rename');
      expect(op.field).toBe('old');
      expect(op.newField).toBe('new');
    });

    it('should parse boolean values', () => {
      const opTrue = buildOperation('set', 'field=true');
      expect(opTrue.value).toBe(true);

      const opFalse = buildOperation('set', 'field=false');
      expect(opFalse.value).toBe(false);
    });

    it('should parse numeric values', () => {
      const op = buildOperation('set', 'count=42');
      expect(op.value).toBe(42);
    });
  });
});
