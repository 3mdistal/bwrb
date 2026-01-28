import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

describe('list command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('basic listing', () => {
    it('should list ideas by name', async () => {
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should list subtypes with slash notation', async () => {
      const result = await runCLI(['list', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
    });

    it('should match hyphenated frontmatter keys in --where', async () => {
      const taskDir = join(vaultDir, 'Objectives', 'Tasks');
      await mkdir(taskDir, { recursive: true });
      const notePath = join(taskDir, 'Hyphen Task.md');
      await writeFile(
        notePath,
        [
          '---',
          'type: task',
          'status: backlog',
          'creation-date: 2026-01-28',
          '---',
          '',
          'Test note',
          '',
        ].join('\n')
      );

      const result = await runCLI(
        ['list', 'task', '--where', "creation-date == '2026-01-28'"],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hyphen Task');
    });

    it('should not show deprecation warning for positional type argument', async () => {
      // Positional type is a permanent shortcut for list command (see docs/product/cli-targeting.md)
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('Warning:');
      expect(result.stderr).not.toContain('positional type argument');
    });

    it('should list all subtypes when listing parent type', async () => {
      const result = await runCLI(['list', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).toContain('Settled Milestone');
    });

    it('should return empty for type with no files', async () => {
      const result = await runCLI(['list', 'milestone', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      // Output should indicate no notes found matching the filter
      expect(result.stdout).toContain('No notes found matching');
    });

    it('should sort results alphabetically', async () => {
      const result = await runCLI(['list', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split('\n');
      const anotherIndex = lines.findIndex(l => l.includes('Another Idea'));
      const sampleIndex = lines.findIndex(l => l.includes('Sample Idea'));
      expect(anotherIndex).toBeLessThan(sampleIndex);
    });
  });

  describe('--output flag', () => {
    it('should show file paths with --output paths', async () => {
      const result = await runCLI(['list', '--output', 'paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
    });

    it('should show wikilinks with --output link', async () => {
      const result = await runCLI(['list', '--output', 'link', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[[Sample Idea]]');
      expect(result.stdout).toContain('[[Another Idea]]');
    });

    it('should accept --output tree (falls back to default for non-recursive types)', async () => {
      const result = await runCLI(['list', '--output', 'tree', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      // For non-recursive types, tree falls back to default name output
      // Lists all objectives and subtypes (tasks extend objective)
      expect(result.stdout).toContain('Active Milestone');
    });

    it('should show JSON with --output json', async () => {
      const result = await runCLI(['list', '--output', 'json', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      // --output json outputs raw JSON array
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThan(0);
      expect(json[0]).toHaveProperty('_path');
      expect(json[0]).toHaveProperty('_name');
    });
  });

  describe('deprecated --paths flag', () => {
    it('should show file paths instead of names (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output paths');
    });

    it('should show nested paths for subtypes', async () => {
      const result = await runCLI(['list', '--paths', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/Tasks/Sample Task.md');
    });
  });

  describe('deprecated --tree flag', () => {
    it('should show tree structure (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--tree', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      // For non-recursive types, tree falls back to default name output
      // Tree characters only appear for recursive types with parent-child relationships
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output tree');
    });
  });

  describe('deprecated --json flag', () => {
    it('should show JSON output (with deprecation warning)', async () => {
      const result = await runCLI(['list', '--json', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Deprecated --json outputs raw array (backward compatible)
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(result.stderr).toContain('Warning:');
      expect(result.stderr).toContain('--output json');
    });
  });

  describe('--fields flag', () => {
    it('should show single field in table format', async () => {
      const result = await runCLI(['list', '--fields=status', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('raw');
      expect(result.stdout).toContain('backlog');
    });

    it('should show multiple fields', async () => {
      const result = await runCLI(['list', '--fields=status,priority', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('PRIORITY');
      expect(result.stdout).toContain('medium');
      expect(result.stdout).toContain('high');
    });

    it('should combine --output paths with --fields', async () => {
      // Note: --output paths outputs plain paths, not a table
      // --fields is ignored when output format is paths
      const result = await runCLI(['list', '--output', 'paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/');
    });

    it('should error on unknown field in --fields when type specified', async () => {
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'unknown_field'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'unknown_field' for type 'idea'");
    });

    it('should suggest similar field names for typos in --fields', async () => {
      // statsu is a typo for 'status'
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'statsu'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'statsu'");
      expect(result.stderr).toContain("Did you mean 'status'?");
    });

    it('should allow unknown fields in --fields without --type (permissive mode)', async () => {
      const result = await runCLI(['list', '--fields', 'unknown_field'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should work in permissive mode, showing table with the field (even if empty)
      expect(result.stdout).toContain('UNKNOWN_FIELD');
    });

    it('should show field validation error in JSON mode', async () => {
      const result = await runCLI(['list', '--type', 'idea', '--fields', 'unknown_field', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain("Unknown field 'unknown_field'");
    });
  });

  describe('--where filters', () => {
    it('should filter by equality', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should filter by OR values using || operator', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw' || status == 'backlog'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should filter by negation', async () => {
      const result = await runCLI(['list', 'milestone', '--where', "status != 'settled'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).not.toContain('Settled Milestone');
    });
  });

  describe('--where expression filters', () => {
    it('should filter with equality expression', async () => {
      const result = await runCLI(['list', 'idea', '--where', "status == 'raw'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should filter with comparison expression', async () => {
      const result = await runCLI(['list', 'idea', '--where', "priority == 'high'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).not.toContain('Sample Idea');
    });

    it('should support multiple --where (AND logic)', async () => {
      const result = await runCLI(
        ['list', 'idea', '--where', "status == 'backlog'", '--where', "priority == 'high'"],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      expect(result.stdout).not.toContain('Sample Idea');
    });
  });

  describe('error handling', () => {
    it('should error on unknown type', async () => {
      const result = await runCLI(['list', '--type', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('should show ambiguous error for positional that could be type or path', async () => {
      const result = await runCLI(['list', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Ambiguous argument');
    });

    it('should handle where expressions that match nothing', async () => {
      // Where expressions with valid values that don't match any notes return empty results
      // Using 'settled' which is a valid status but has no matching notes
      const result = await runCLI(['list', 'idea', '--where', "status == 'settled'"], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No notes found matching');
    });

    it('should error on invalid select field value in where expression', async () => {
      // When --type is specified, select field values are validated
      const result = await runCLI(['list', 'idea', '--where', "status == 'nonexistent'"], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid value 'nonexistent' for field 'status'");
      expect(result.stderr).toContain('Valid options:');
    });

    it('should list all notes when no selectors provided (implicit --all for read-only)', async () => {
      const result = await runCLI(['list'], vaultDir);

      // Read-only commands use implicit --all, so this succeeds
      expect(result.exitCode).toBe(0);
      // Should list notes from the vault
      expect(result.stdout).toBeTruthy();
    });
  });

  describe('hierarchy options for recursive types', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      const { mkdtemp, mkdir, writeFile } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-list-hierarchy-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with a recursive type
      const schemaWithRecursive = {
        version: 2,
        types: {
          task: {
            recursive: true,
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'done'], default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithRecursive, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });

      // Create a hierarchy:
      // Parent Task
      //   ├── Child Task 1
      //   │   └── Grandchild Task
      //   └── Child Task 2
      // Standalone Task (no parent)

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Parent Task.md'),
        `---
type: task
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Child Task 1.md'),
        `---
type: task
status: backlog
parent: "[[Parent Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Child Task 2.md'),
        `---
type: task
status: in-flight
parent: "[[Parent Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Grandchild Task.md'),
        `---
type: task
status: done
parent: "[[Child Task 1]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Standalone Task.md'),
        `---
type: task
status: raw
---
`
      );
    });

    afterEach(async () => {
      const { rm } = await import('fs/promises');
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should list only root notes with --roots', async () => {
      const result = await runCLI(['list', 'task', '--roots'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Standalone Task');
      expect(result.stdout).not.toContain('Child Task');
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should list only direct children with --children-of', async () => {
      const result = await runCLI(['list', 'task', '--children-of', '[[Parent Task]]'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      expect(result.stdout).not.toContain('Parent Task');
      expect(result.stdout).not.toContain('Grandchild');
      expect(result.stdout).not.toContain('Standalone');
    });

    it('should list all descendants with --descendants-of', async () => {
      const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      expect(result.stdout).toContain('Grandchild Task');
      expect(result.stdout).not.toContain('Parent Task');
      expect(result.stdout).not.toContain('Standalone');
    });

    it('should limit descendants depth with --depth', async () => {
      const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]', '--depth', '1'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Child Task 1');
      expect(result.stdout).toContain('Child Task 2');
      // Depth 1 means only direct children, not grandchildren
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should render tree structure with --tree', async () => {
      const result = await runCLI(['list', 'task', '--tree'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      // Tree structure should show indentation/connectors
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Child Task');
      expect(result.stdout).toContain('Grandchild');
      expect(result.stdout).toContain('Standalone');
      // Should have tree connectors
      expect(result.stdout).toMatch(/[├└│]/);
    });

    it('should limit tree depth with --depth', async () => {
      const result = await runCLI(['list', 'task', '--tree', '--depth', '2'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Child Task');
      // Depth 2 means roots + children, no grandchildren
      expect(result.stdout).not.toContain('Grandchild');
    });

    it('should combine --roots with other filters', async () => {
      const result = await runCLI(['list', 'task', '--roots', '--where', "status == 'raw'"], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Standalone Task');
      // Both roots have status: raw, so both should appear
    });

    describe('--where hierarchy functions', () => {
      it('should filter with isRoot() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', 'isRoot()'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Parent Task');
        expect(result.stdout).toContain('Standalone Task');
        expect(result.stdout).not.toContain('Child Task');
        expect(result.stdout).not.toContain('Grandchild');
      });

      it('should filter with isChildOf() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', "isChildOf('[[Parent Task]]')"], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Grandchild');
        expect(result.stdout).not.toContain('Standalone');
      });

      it('should filter with isDescendantOf() in --where expression', async () => {
        const result = await runCLI(['list', 'task', '--where', "isDescendantOf('[[Parent Task]]')"], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Standalone');
      });

      it('should combine hierarchy functions with other --where expressions', async () => {
        const result = await runCLI(
          ['list', 'task', '--where', "isDescendantOf('[[Parent Task]]')", '--where', "status == 'done'"],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Child Task 1');
        expect(result.stdout).not.toContain('Child Task 2');
      });

      it('should combine isRoot() with status filter in single expression', async () => {
        const result = await runCLI(
          ['list', 'task', '--where', "isRoot() && status == 'raw'"],
          tempVaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Parent Task');
        expect(result.stdout).toContain('Standalone Task');
      });

      it('should work with negated hierarchy functions', async () => {
        const result = await runCLI(['list', 'task', '--where', '!isRoot()'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).toContain('Grandchild Task');
        expect(result.stdout).not.toContain('Parent Task');
        expect(result.stdout).not.toContain('Standalone Task');
      });
    });

    describe('deprecated hierarchy flags', () => {
      it('should show deprecation warning for --roots', async () => {
        const result = await runCLI(['list', 'task', '--roots'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--roots');
        expect(result.stderr).toContain('isRoot()');
      });

      it('should show deprecation warning for --children-of', async () => {
        const result = await runCLI(['list', 'task', '--children-of', '[[Parent Task]]'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--children-of');
        expect(result.stderr).toContain('isChildOf');
      });

      it('should show deprecation warning for --descendants-of', async () => {
        const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Warning:');
        expect(result.stderr).toContain('--descendants-of');
        expect(result.stderr).toContain('isDescendantOf');
      });

      it('should accept -L as alias for --depth', async () => {
        const result = await runCLI(['list', 'task', '--descendants-of', '[[Parent Task]]', '-L', '1'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Child Task 1');
        expect(result.stdout).toContain('Child Task 2');
        expect(result.stdout).not.toContain('Grandchild');
      });
    });
  });

  describe('--save-as flag', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      const { mkdtemp, mkdir, writeFile } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');

      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-list-save-as-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      const schema = {
        version: 2,
        types: {
          task: {
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['raw', 'active', 'done'], default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schema, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Tasks'), { recursive: true });

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task One.md'),
        `---
type: task
status: active
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task Two.md'),
        `---
type: task
status: done
---
`
      );
    });

    afterEach(async () => {
      const { rm } = await import('fs/promises');
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should save query as dashboard with --save-as', async () => {
      const { readFile, existsSync } = await import('fs');
      const { join } = await import('path');

      const result = await runCLI(['list', '--type', 'task', '--save-as', 'my-tasks'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      // Query results should be shown
      expect(result.stdout).toContain('Task One');
      expect(result.stdout).toContain('Task Two');
      // Confirmation on stderr
      expect(result.stderr).toContain('Dashboard "my-tasks" saved');

      // Verify file was created
      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['my-tasks']).toEqual({ type: 'task' });
    });

    it('should save query with where filter', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--where', "status == 'active'", '--save-as', 'active-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Task One');
      expect(result.stdout).not.toContain('Task Two');
      expect(result.stderr).toContain('Dashboard "active-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['active-tasks']).toEqual({
        type: 'task',
        where: ["status == 'active'"],
      });
    });

    it('should save query with output format', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'paths', '--save-as', 'task-paths'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      // Output format should be paths
      expect(result.stdout).toContain('Tasks/Task One.md');
      expect(result.stderr).toContain('Dashboard "task-paths" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['task-paths']).toEqual({
        type: 'task',
        output: 'paths',
      });
    });

    it('should save query with fields', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--fields', 'status', '--save-as', 'task-table'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STATUS');
      expect(result.stderr).toContain('Dashboard "task-table" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['task-table']).toEqual({
        type: 'task',
        fields: ['status'],
      });
    });

    it('should error when dashboard already exists', async () => {
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'task' } } })
      );

      const result = await runCLI(['list', '--type', 'task', '--save-as', 'existing'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Dashboard "existing" already exists');
      expect(result.stderr).toContain('--force');
    });

    it('should overwrite existing dashboard with --force', async () => {
      const { writeFile, readFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'idea' } } })
      );

      const result = await runCLI(
        ['list', '--type', 'task', '--where', "status == 'active'", '--save-as', 'existing', '--force'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "existing" updated');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await readFile(dashboardsPath, 'utf-8');
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['existing']).toEqual({
        type: 'task',
        where: ["status == 'active'"],
      });
    });

    it('should work with --output json and --save-as', async () => {
      const { join } = await import('path');

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'json', '--save-as', 'json-tasks'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      // JSON output on stdout
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(2);
      // Confirmation on stderr
      expect(result.stderr).toContain('Dashboard "json-tasks" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      expect(dashboards.dashboards['json-tasks']).toEqual({
        type: 'task',
        output: 'json',
      });
    });

    it('should save empty query (no filters) as dashboard', async () => {
      const { join } = await import('path');

      const result = await runCLI(['list', '--save-as', 'all-notes'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Dashboard "all-notes" saved');

      const dashboardsPath = join(tempVaultDir, '.bwrb', 'dashboards.json');
      const content = await import('fs/promises').then(fs => fs.readFile(dashboardsPath, 'utf-8'));
      const dashboards = JSON.parse(content);
      // Empty definition since no filters
      expect(dashboards.dashboards['all-notes']).toEqual({});
    });

    it('should return JSON error when dashboard exists in JSON mode', async () => {
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');

      // Create existing dashboard
      await writeFile(
        join(tempVaultDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { existing: { type: 'task' } } })
      );

      const result = await runCLI(
        ['list', '--type', 'task', '--output', 'json', '--save-as', 'existing'],
        tempVaultDir
      );

      expect(result.exitCode).not.toBe(0);
      // Error should be in stdout as JSON (matches existing json error pattern)
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });
  });
});
