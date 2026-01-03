import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

    it('should list all subtypes when listing parent type', async () => {
      const result = await runCLI(['list', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Task');
      expect(result.stdout).toContain('Active Milestone');
      expect(result.stdout).toContain('Settled Milestone');
    });

    it('should return empty for type with no files', async () => {
      const result = await runCLI(['list', 'milestone', '--status=raw'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
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

  describe('--paths flag', () => {
    it('should show file paths instead of names', async () => {
      const result = await runCLI(['list', '--paths', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
      expect(result.stdout).toContain('Ideas/Another Idea.md');
    });

    it('should show nested paths for subtypes', async () => {
      const result = await runCLI(['list', '--paths', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Objectives/Tasks/Sample Task.md');
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

    it('should combine --paths with --fields', async () => {
      const result = await runCLI(['list', '--paths', '--fields=status', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PATH');
      expect(result.stdout).toContain('Ideas/');
    });
  });

  describe('simple filters', () => {
    it('should filter by equality', async () => {
      const result = await runCLI(['list', 'idea', '--status=raw'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should filter by OR values', async () => {
      const result = await runCLI(['list', 'idea', '--status=raw,backlog'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
    });

    it('should filter by negation', async () => {
      const result = await runCLI(['list', 'milestone', '--status!=settled'], vaultDir);

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

    it('should error on invalid filter field', async () => {
      const result = await runCLI(['list', 'idea', '--nonexistent=value'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown field');
    });

    it('should error on invalid enum value', async () => {
      const result = await runCLI(['list', 'idea', '--status=invalid'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid value');
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

      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-list-hierarchy-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      // Schema with a recursive type
      const schemaWithRecursive = {
        version: 2,
        enums: {
          status: ['raw', 'backlog', 'in-flight', 'done']
        },
        types: {
          task: {
            recursive: true,
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', enum: 'status', default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
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
      const result = await runCLI(['list', 'task', '--roots', '--status=raw'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Parent Task');
      expect(result.stdout).toContain('Standalone Task');
      // Both roots have status: raw, so both should appear
    });
  });
});
