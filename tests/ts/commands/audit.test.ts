import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestVault, cleanupTestVault, runCLI, TEST_SCHEMA } from '../fixtures/setup.js';

describe('audit command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('valid files', () => {
    it('should report no issues for valid vault files', async () => {
      const result = await runCLI(['audit'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found');
    });

    it('should audit specific type path', async () => {
      const result = await runCLI(['audit', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
    });

    it('should audit subtypes', async () => {
      const result = await runCLI(['audit', 'objective/task'], vaultDir);

      expect(result.exitCode).toBe(0);
    });

    it('should audit parent type and all subtypes', async () => {
      const result = await runCLI(['audit', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('missing required fields', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      // Schema with a required field that has NO default
      const schemaWithRequired = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          idea: {
            ...TEST_SCHEMA.types.idea,
            frontmatter: {
              ...TEST_SCHEMA.types.idea.frontmatter,
              requiredNoDefault: { prompt: 'input', required: true },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(schemaWithRequired, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect missing required field', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Missing Required.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Missing required field: requiredNoDefault');
    });
  });

  describe('invalid enum values', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect invalid enum value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Invalid Status.md'),
        `---
type: idea
status: wip
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Invalid status value: 'wip'");
    });

    it('should suggest similar enum value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Typo Status.md'),
        `---
type: idea
status: baclog
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Did you mean 'backlog'?");
    });
  });

  describe('unknown fields', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should warn about unknown field by default', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Extra Field.md'),
        `---
type: idea
status: raw
priority: medium
customField: value
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      // Unknown fields are warnings by default, not errors
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Unknown field: customField');
    });

    it('should error on unknown field in strict mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Extra Field.md'),
        `---
type: idea
status: raw
priority: medium
customField: value
---
`
      );

      const result = await runCLI(['audit', 'idea', '--strict'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Unknown field: customField');
    });

    it('should allow Obsidian native fields like tags', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'With Tags.md'),
        `---
type: idea
status: raw
priority: medium
tags:
  - test
  - example
---
`
      );

      const result = await runCLI(['audit', 'idea', '--strict'], tempVaultDir);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('orphan files', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect file without type field', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Orphan File.md'),
        `---
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("No 'type' field");
    });
  });

  describe('invalid type', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect invalid type value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Wrong Type.md'),
        `---
type: nonexistent
status: raw
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Invalid type");
      expect(result.stdout).toContain("nonexistent");
    });

    it('should suggest similar type', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Typo Type.md'),
        `---
type: idee
status: raw
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      // Type 'idee' is close enough to 'idea' to suggest
      expect(result.stdout).toContain("idee");
    });
  });

  describe('filtering options', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });

      // Create file with multiple issues
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Multiple Issues.md'),
        `---
type: idea
status: invalid-status
customField: value
---
`
      );
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should filter by --only issue type', async () => {
      const result = await runCLI(['audit', 'idea', '--only', 'invalid-enum'], tempVaultDir);

      expect(result.stdout).toContain('Invalid status value');
      expect(result.stdout).not.toContain('Unknown field');
    });

    it('should filter by --ignore issue type', async () => {
      const result = await runCLI(['audit', 'idea', '--ignore', 'unknown-field'], tempVaultDir);

      expect(result.stdout).toContain('Invalid status value');
      expect(result.stdout).not.toContain('Unknown field');
    });

    it('should filter by --path pattern', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Subdir File.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', '--path', 'Multiple'], tempVaultDir);

      expect(result.stdout).toContain('Multiple Issues.md');
      expect(result.stdout).not.toContain('Subdir File.md');
    });
  });

  describe('JSON output', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should output valid JSON with issues', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad File.md'),
        `---
type: idea
status: invalid
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.files).toBeInstanceOf(Array);
      expect(json.files.length).toBeGreaterThan(0);
      expect(json.files[0].issues).toBeInstanceOf(Array);
      expect(json.summary).toBeDefined();
      expect(json.summary.totalErrors).toBeGreaterThan(0);
    });

    it('should output valid JSON with no issues', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Good File.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.files).toBeInstanceOf(Array);
      expect(json.summary.totalErrors).toBe(0);
    });

    it('should include issue details in JSON', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Detailed Issue.md'),
        `---
type: idea
status: wip
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const json = JSON.parse(result.stdout);
      const issue = json.files[0].issues[0];
      expect(issue.severity).toBe('error');
      expect(issue.code).toBe('invalid-enum');
      expect(issue.field).toBe('status');
      expect(issue.value).toBe('wip');
      expect(issue.expected).toContain('raw');
    });
  });

  describe('error handling', () => {
    it('should error on unknown type', async () => {
      const result = await runCLI(['audit', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });
  });

  describe('summary statistics', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should display summary with multiple files', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Good.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad1.md'),
        `---
type: idea
status: invalid1
priority: medium
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad2.md'),
        `---
type: idea
status: invalid2
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Summary:');
      expect(result.stdout).toContain('Files with issues: 2');
      expect(result.stdout).toContain('Total errors: 2');
    });
  });

  describe('--fix --auto mode', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-fix-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should auto-fix missing required field with default', async () => {
      // Create a file missing the 'status' field (which has default: 'raw')
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Missing Status.md'),
        `---
type: idea
priority: medium
---
Some content
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.stdout).toContain('Auto-fixing');
      expect(result.stdout).toContain('Added status');
      expect(result.stdout).toContain('Fixed: 1 issues');

      // Verify the file was actually fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Missing Status.md'), 'utf-8');
      expect(content).toContain('status: raw');
    });

    it('should report non-fixable issues for manual review', async () => {
      // Create a file with an invalid enum value (not auto-fixable)
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Invalid Enum.md'),
        `---
type: idea
status: invalid-status
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Issues requiring manual review');
      expect(result.stdout).toContain('Invalid status value');
      expect(result.stdout).toContain('Remaining: 1 issues');
    });

    it('should handle mix of fixable and non-fixable issues', async () => {
      // File with missing status (fixable) and invalid enum (not fixable)
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fixable.md'),
        `---
type: idea
priority: medium
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Not Fixable.md'),
        `---
type: idea
status: bad-value
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.stdout).toContain('Fixed: 1 issues');
      expect(result.stdout).toContain('Remaining: 1 issues');
    });

    it('should exit with 0 when all issues are fixed', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Missing Status.md'),
        `---
type: idea
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Fixed: 1 issues');
      expect(result.stdout).toContain('Remaining: 0 issues');
    });
  });

  describe('--fix option validation', () => {
    it('should error when --auto is used without --fix', async () => {
      const result = await runCLI(['audit', '--auto'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--auto requires --fix');
    });

    it('should error when --fix is used with --output json', async () => {
      const result = await runCLI(['audit', '--fix', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--fix is not compatible with --output json');
    });
  });

  describe('--fix interactive mode', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-fix-test-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should show no issues message when vault is clean', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Good.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found');
    });

    it('should skip issues when user provides no input in interactive mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad.md'),
        `---
type: idea
priority: medium
---
`
      );

      // Interactive mode with 'n' input (decline fix) followed by newline
      // This should decline the prompt and skip the issue
      const result = await runCLI(['audit', 'idea', '--fix'], tempVaultDir, 'n\n');

      expect(result.stdout).toContain('Missing required field: status');
      expect(result.stdout).toContain('Skipped');
    });
  });

  describe('vault-wide scanning', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-vaultwide-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect orphan files outside managed directories', async () => {
      // Create a file in an unmanaged directory (not Ideas/, Objectives/, etc.)
      await mkdir(join(tempVaultDir, 'Random'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Random', 'Stray Note.md'),
        `---
title: Some random note
---
No type field here.
`
      );

      // Run audit without specifying a type (vault-wide scan)
      const result = await runCLI(['audit'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Stray Note.md');
      expect(result.stdout).toContain("No 'type' field");
    });

    it('should detect files at vault root without type', async () => {
      await writeFile(
        join(tempVaultDir, 'Root Note.md'),
        `---
title: A root level note
---
`
      );

      const result = await runCLI(['audit'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Root Note.md');
      expect(result.stdout).toContain("No 'type' field");
    });

    it('should exclude hidden directories (starting with .)', async () => {
      // Create a file in a hidden directory
      await mkdir(join(tempVaultDir, '.hidden'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.hidden', 'Secret.md'),
        `---
title: Hidden file
---
`
      );

      // Also create a valid file so audit runs
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Valid.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Secret.md');
      expect(result.stdout).not.toContain('.hidden');
    });

    it('should respect .gitignore patterns', async () => {
      // Create a .gitignore
      await writeFile(
        join(tempVaultDir, '.gitignore'),
        'ignored-dir/\n*.tmp.md\n'
      );

      // Create files that should be ignored
      await mkdir(join(tempVaultDir, 'ignored-dir'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'ignored-dir', 'Ignored.md'),
        `---
title: Should be ignored
---
`
      );

      await writeFile(
        join(tempVaultDir, 'temp.tmp.md'),
        `---
title: Temp file
---
`
      );

      // Create a valid file
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Valid.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Ignored.md');
      expect(result.stdout).not.toContain('temp.tmp.md');
    });

    it('should respect PIKA_AUDIT_EXCLUDE env var', async () => {
      // Create a directory that should be excluded via env var
      await mkdir(join(tempVaultDir, 'Archive'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Archive', 'Old Note.md'),
        `---
title: Archived
---
`
      );

      // Create a valid file
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Valid.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Set env var and run
      const originalEnv = process.env.PIKA_AUDIT_EXCLUDE;
      process.env.PIKA_AUDIT_EXCLUDE = 'Archive';

      try {
        const result = await runCLI(['audit'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('Old Note.md');
        expect(result.stdout).not.toContain('Archive');
      } finally {
        // Restore env
        if (originalEnv === undefined) {
          delete process.env.PIKA_AUDIT_EXCLUDE;
        } else {
          process.env.PIKA_AUDIT_EXCLUDE = originalEnv;
        }
      }
    });

    it('should respect schema audit.ignored_directories config', async () => {
      // Update schema with ignored_directories
      const schemaWithExclusions = {
        ...TEST_SCHEMA,
        audit: {
          ignored_directories: ['Templates', 'Archive/Old'],
        },
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(schemaWithExclusions, null, 2)
      );

      // Create directories that should be excluded
      await mkdir(join(tempVaultDir, 'Templates'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Templates', 'Template.md'),
        `---
title: A template
---
`
      );

      await mkdir(join(tempVaultDir, 'Archive', 'Old'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Archive', 'Old', 'Ancient.md'),
        `---
title: Old stuff
---
`
      );

      // Create a valid file
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Valid.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Template.md');
      expect(result.stdout).not.toContain('Ancient.md');
    });
  });

  describe('orphan-file auto-fix with inferred type', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-orphan-fix-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives', 'Tasks'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should auto-fix orphan file in managed directory with inferred type', async () => {
      // Create a file in Ideas/ without type field
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Missing Type.md'),
        `---
status: raw
priority: medium
---
Some content
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.stdout).toContain('Auto-fixing');
      expect(result.stdout).toContain('type: idea');
      expect(result.stdout).toContain('from directory');
      expect(result.stdout).toContain('Fixed: 1 issues');

      // Verify the file was actually fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Missing Type.md'), 'utf-8');
      expect(content).toContain('type: idea');
    });

    it('should auto-fix orphan file with nested type path', async () => {
      // Create a file in Objectives/Tasks/ without type fields
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Tasks', 'Missing Type.md'),
        `---
status: backlog
milestone: "[[Test Milestone]]"
---
Task content
`
      );

      const result = await runCLI(['audit', 'objective/task', '--fix', '--auto'], tempVaultDir);

      expect(result.stdout).toContain('Auto-fixing');
      // In the new inheritance model, we use a single 'type: task' field instead of 'type: objective' + 'objective-type: task'
      expect(result.stdout).toContain('type: task');
      expect(result.stdout).toContain('Fixed: 1 issues');

      // Verify the file was actually fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Objectives', 'Tasks', 'Missing Type.md'), 'utf-8');
      expect(content).toContain('type: task');
    });

    it('should mark orphan-file as auto-fixable when inferred type is available', async () => {
      // Create a file in Ideas/ without type field
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Orphan.md'),
        `---
status: raw
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const orphanIssue = output.files[0].issues.find((i: { code: string }) => i.code === 'orphan-file');
      expect(orphanIssue).toBeDefined();
      expect(orphanIssue.autoFixable).toBe(true);
    });

    it('should NOT mark orphan-file as auto-fixable when no inferred type', async () => {
      // Create a file outside managed directories
      await mkdir(join(tempVaultDir, 'Random'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Random', 'Stray.md'),
        `---
title: Random note
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const strayFile = output.files.find((f: { path: string }) => f.path.includes('Stray.md'));
      expect(strayFile).toBeDefined();
      const orphanIssue = strayFile.issues.find((i: { code: string }) => i.code === 'orphan-file');
      expect(orphanIssue).toBeDefined();
      expect(orphanIssue.autoFixable).toBe(false);
    });
  });

  describe('--allow-field option', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-allow-field-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should allow extra field with --allow-field option', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Extra Field.md'),
        `---
type: idea
status: raw
priority: medium
customField: value
---
`
      );

      // Without --allow-field, should warn
      const result1 = await runCLI(['audit', 'idea'], tempVaultDir);
      expect(result1.stdout).toContain('Unknown field: customField');

      // With --allow-field, should not warn
      const result2 = await runCLI(['audit', 'idea', '--allow-field', 'customField'], tempVaultDir);
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout).not.toContain('customField');
    });

    it('should allow multiple fields with repeated --allow-field', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Multiple Extra.md'),
        `---
type: idea
status: raw
priority: medium
customField1: value1
customField2: value2
---
`
      );

      const result = await runCLI(['audit', 'idea', '--allow-field', 'customField1', '--allow-field', 'customField2'], tempVaultDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('customField1');
      expect(result.stdout).not.toContain('customField2');
    });

    it('should still error on unknown field in strict mode even with different allow-field', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Extra Field.md'),
        `---
type: idea
status: raw
priority: medium
customField: value
otherField: value
---
`
      );

      // Allow one field but not the other in strict mode
      const result = await runCLI(['audit', 'idea', '--strict', '--allow-field', 'customField'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('customField');
      expect(result.stdout).toContain('Unknown field: otherField');
    });
  });

  describe('format violation detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-format-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      // Use schema with wikilink format field
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives/Milestones'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect format violation when wikilink field contains plain text', async () => {
      // Create a milestone for reference
      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Q1 Release.md'),
        `---
type: objective
objective-type: milestone
status: in-flight
---
`
      );

      // Create a task with plain text instead of wikilink for milestone
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Bad Format.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: Q1 Release
---
`
      );

      const result = await runCLI(['audit', 'objective/task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Bad Format.md'));
      expect(taskFile).toBeDefined();
      const formatIssue = taskFile.issues.find((i: { code: string }) => i.code === 'format-violation');
      expect(formatIssue).toBeDefined();
      expect(formatIssue.field).toBe('milestone');
      expect(formatIssue.autoFixable).toBe(true);
      expect(formatIssue.expectedFormat).toBe('quoted-wikilink');
    });

    it('should auto-fix format violation to wikilink', async () => {
      // Create a task with plain text instead of quoted-wikilink
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Fixable.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: Q1 Release
---
`
      );

      const result = await runCLI(['audit', 'objective/task', '--fix', '--auto'], tempVaultDir);

      expect(result.stdout).toContain('Fixed');
      expect(result.stdout).toContain('milestone');

      // Verify the file was fixed
      const { readFile: rf } = await import('fs/promises');
      const content = await rf(join(tempVaultDir, 'Objectives/Tasks', 'Fixable.md'), 'utf-8');
      expect(content).toContain('"[[Q1 Release]]"');
    });

    it('should not report format violation for correctly formatted wikilink', async () => {
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Good Format.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: "[[Q1 Release]]"
---
`
      );

      const result = await runCLI(['audit', 'objective/task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('format-violation');
    });
  });

  describe('stale reference detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-stale-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives/Milestones'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect stale reference in frontmatter wikilink field', async () => {
      // Create a task pointing to non-existent milestone
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Stale Ref.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: "[[Non Existent Milestone]]"
---
`
      );

      const result = await runCLI(['audit', 'objective/task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Stale Ref.md'));
      expect(taskFile).toBeDefined();
      const staleIssue = taskFile.issues.find((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssue).toBeDefined();
      expect(staleIssue.targetName).toBe('Non Existent Milestone');
      expect(staleIssue.inBody).toBe(false);
    });

    it('should detect stale reference in body content', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Body Links.md'),
        `---
type: idea
status: raw
priority: medium
---

This idea references [[Non Existent Note]] which doesn't exist.
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const ideaFile = output.files.find((f: { path: string }) => f.path.includes('Body Links.md'));
      expect(ideaFile).toBeDefined();
      const staleIssue = ideaFile.issues.find((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssue).toBeDefined();
      expect(staleIssue.targetName).toBe('Non Existent Note');
      expect(staleIssue.inBody).toBe(true);
      expect(staleIssue.lineNumber).toBeGreaterThan(0);
    });

    it('should not report stale reference for existing file', async () => {
      // Create target file first
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Target Note.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Create file linking to it
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Linking Note.md'),
        `---
type: idea
status: raw
priority: medium
---

This links to [[Target Note]] which exists.
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('stale-reference');
    });

    it('should suggest similar files for stale references', async () => {
      // Create a milestone with a similar name
      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Q1 Release.md'),
        `---
type: objective
objective-type: milestone
status: in-flight
---
`
      );

      // Create a task with a typo in the milestone name
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Typo Ref.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: "[[Q1 Relase]]"
---
`
      );

      const result = await runCLI(['audit', 'objective/task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Typo Ref.md'));
      expect(taskFile).toBeDefined();
      const staleIssue = taskFile.issues.find((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssue).toBeDefined();
      expect(staleIssue.similarFiles).toBeDefined();
      expect(staleIssue.similarFiles.length).toBeGreaterThan(0);
      // Should suggest Q1 Release as a similar file
      expect(staleIssue.similarFiles.some((f: string) => f.includes('Q1 Release'))).toBe(true);
    });

    it('should handle multiple wikilinks in body content', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Multiple Links.md'),
        `---
type: idea
status: raw
priority: medium
---

First link: [[Missing One]]
Second link: [[Missing Two]]
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const ideaFile = output.files.find((f: { path: string }) => f.path.includes('Multiple Links.md'));
      expect(ideaFile).toBeDefined();
      const staleIssues = ideaFile.issues.filter((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssues.length).toBe(2);
      expect(staleIssues.some((i: { targetName: string }) => i.targetName === 'Missing One')).toBe(true);
      expect(staleIssues.some((i: { targetName: string }) => i.targetName === 'Missing Two')).toBe(true);
    });

    it('should handle wikilinks with aliases and headings', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Complex Links.md'),
        `---
type: idea
status: raw
priority: medium
---

Link with alias: [[Missing Note|Custom Alias]]
Link with heading: [[Missing Note#Section]]
Link with both: [[Missing Note#Section|Alias]]
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const ideaFile = output.files.find((f: { path: string }) => f.path.includes('Complex Links.md'));
      expect(ideaFile).toBeDefined();
      const staleIssues = ideaFile.issues.filter((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssues.length).toBe(3);
      // All should target "Missing Note"
      staleIssues.forEach((issue: { targetName: string }) => {
        expect(issue.targetName).toBe('Missing Note');
      });
    });
  });

  describe('schema allowed_extra_fields config', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-schema-allow-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should respect schema audit.allowed_extra_fields', async () => {
      // Create schema with allowed_extra_fields
      const schemaWithAllowed = {
        ...TEST_SCHEMA,
        audit: {
          allowed_extra_fields: ['legacyField', 'customData'],
        },
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(schemaWithAllowed, null, 2)
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'With Allowed.md'),
        `---
type: idea
status: raw
priority: medium
legacyField: some value
customData: other value
unknownField: should warn
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      // Should not warn about allowed fields
      expect(result.stdout).not.toContain('legacyField');
      expect(result.stdout).not.toContain('customData');
      // Should still warn about unknown field
      expect(result.stdout).toContain('unknownField');
    });
  });

  describe('context field source type validation', () => {
    let tempVaultDir: string;

    // V2 schema with type-based sources
    const V2_SCHEMA = {
      version: 2,
      enums: {
        status: ['raw', 'backlog', 'in-flight', 'settled'],
      },
      types: {
        objective: {
          fields: {
            status: { prompt: 'select', enum: 'status', default: 'raw' },
          },
        },
        milestone: {
          extends: 'objective',
        },
        task: {
          extends: 'objective',
          fields: {
            milestone: {
              prompt: 'dynamic',
              source: 'milestone',  // Type-based source
              format: 'wikilink',
            },
            parent: {
              prompt: 'dynamic',
              source: 'objective',  // Accepts objective or any descendant
              format: 'wikilink',
            },
          },
        },
        idea: {
          fields: {
            status: { prompt: 'select', enum: 'status', default: 'raw' },
          },
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-context-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(V2_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'objectives/milestones'), { recursive: true });
      await mkdir(join(tempVaultDir, 'objectives/tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect type mismatch when context field references wrong type', async () => {
      // Create a task (wrong type for milestone field)
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Some Task.md'),
        `---
type: task
status: backlog
---
`
      );

      // Create another task that incorrectly references the first task as a milestone
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Bad Ref.md'),
        `---
type: task
status: backlog
milestone: "[[Some Task]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const badRefFile = output.files.find((f: { path: string }) => f.path.includes('Bad Ref.md'));
      expect(badRefFile).toBeDefined();
      const sourceIssue = badRefFile.issues.find((i: { code: string }) => i.code === 'invalid-source-type');
      expect(sourceIssue).toBeDefined();
      expect(sourceIssue.field).toBe('milestone');
      expect(sourceIssue.expectedType).toBe('milestone');
      expect(sourceIssue.actualType).toBe('task');
    });

    it('should not report error when context field references correct type', async () => {
      // Create a milestone (correct type)
      await writeFile(
        join(tempVaultDir, 'objectives/milestones', 'Q1 Release.md'),
        `---
type: milestone
status: in-flight
---
`
      );

      // Create a task that correctly references the milestone
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Good Ref.md'),
        `---
type: task
status: backlog
milestone: "[[Q1 Release]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('invalid-source-type');
    });

    it('should accept descendant types when source is parent type', async () => {
      // Create a task (descendant of objective)
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Parent Task.md'),
        `---
type: task
status: in-flight
---
`
      );

      // Create another task that references the first via parent field (source: objective)
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Child Task.md'),
        `---
type: task
status: backlog
parent: "[[Parent Task]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('invalid-source-type');
    });

    it('should skip validation for non-existent references (stale-reference handles those)', async () => {
      // Create a task that references a non-existent milestone
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Orphan Ref.md'),
        `---
type: task
status: backlog
milestone: "[[Non Existent]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const orphanFile = output.files.find((f: { path: string }) => f.path.includes('Orphan Ref.md'));
      expect(orphanFile).toBeDefined();
      
      // Should have stale-reference but NOT invalid-source-type
      const staleIssue = orphanFile.issues.find((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssue).toBeDefined();
      
      const sourceIssue = orphanFile.issues.find((i: { code: string }) => i.code === 'invalid-source-type');
      expect(sourceIssue).toBeUndefined();
    });

    it('should skip validation for legacy dynamic_sources', async () => {
      // Create a schema with legacy dynamic_sources
      const legacySchema = {
        ...TEST_SCHEMA,  // Uses dynamic_sources
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(legacySchema, null, 2)
      );

      // Create directories for legacy schema
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });

      // Create an idea (wrong type for milestone field which uses dynamic_source)
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Some Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Create a task referencing the idea as milestone (would be wrong type, but uses dynamic_source)
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Task With Legacy.md'),
        `---
type: objective
objective-type: task
status: backlog
milestone: "[[Some Idea]]"
---
`
      );

      const result = await runCLI(['audit', 'objective/task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Task With Legacy.md'));
      
      // Should NOT have invalid-source-type (legacy dynamic_sources are skipped)
      if (taskFile) {
        const sourceIssue = taskFile.issues.find((i: { code: string }) => i.code === 'invalid-source-type');
        expect(sourceIssue).toBeUndefined();
      }
    });

    it('should validate all values when field has multiple values', async () => {
      // Update schema to have a multiple wikilink field
      const schemaWithMultiple = {
        ...V2_SCHEMA,
        types: {
          ...V2_SCHEMA.types,
          task: {
            ...V2_SCHEMA.types.task,
            fields: {
              ...V2_SCHEMA.types.task.fields,
              milestones: {
                prompt: 'dynamic',
                source: 'milestone',
                format: 'wikilink',
                multiple: true,
              },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.pika', 'schema.json'),
        JSON.stringify(schemaWithMultiple, null, 2)
      );

      // Create a milestone
      await writeFile(
        join(tempVaultDir, 'objectives/milestones', 'Good Milestone.md'),
        `---
type: milestone
status: in-flight
---
`
      );

      // Create an idea (wrong type)
      await writeFile(
        join(tempVaultDir, 'ideas', 'Bad Idea.md'),
        `---
type: idea
status: raw
---
`
      );

      // Create a task with array of milestones, one valid and one invalid
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Multi Ref.md'),
        `---
type: task
status: backlog
milestones:
  - "[[Good Milestone]]"
  - "[[Bad Idea]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Multi Ref.md'));
      expect(taskFile).toBeDefined();
      
      const sourceIssues = taskFile.issues.filter((i: { code: string }) => i.code === 'invalid-source-type');
      expect(sourceIssues.length).toBe(1);
      expect(sourceIssues[0].actualType).toBe('idea');
    });

    it('should include helpful error message with type info', async () => {
      // Create an idea (wrong type)
      await writeFile(
        join(tempVaultDir, 'ideas', 'Some Idea.md'),
        `---
type: idea
status: raw
---
`
      );

      // Create a task that incorrectly references an idea as milestone
      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Wrong Type.md'),
        `---
type: task
status: backlog
milestone: "[[Some Idea]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Type mismatch');
      expect(result.stdout).toContain('milestone');
      expect(result.stdout).toContain('idea');
    });
  });

  describe('parent cycle detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'pika-audit-cycle-'));
      await mkdir(join(tempVaultDir, '.pika'), { recursive: true });
      // Schema with a recursive type
      const schemaWithRecursive = {
        version: 2,
        enums: {
          status: ['raw', 'backlog', 'in-flight', 'settled']
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
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect direct parent cycle (A -> A)', async () => {
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Self Referencing.md'),
        `---
type: task
status: raw
parent: "[[Self Referencing]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Parent cycle detected');
      expect(result.stdout).toContain('Self Referencing');
    });

    it('should detect indirect parent cycle (A -> B -> A)', async () => {
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task A.md'),
        `---
type: task
status: raw
parent: "[[Task B]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task B.md'),
        `---
type: task
status: raw
parent: "[[Task A]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Parent cycle detected');
    });

    it('should detect longer parent cycles (A -> B -> C -> A)', async () => {
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task A.md'),
        `---
type: task
status: raw
parent: "[[Task B]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task B.md'),
        `---
type: task
status: raw
parent: "[[Task C]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Task C.md'),
        `---
type: task
status: raw
parent: "[[Task A]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Parent cycle detected');
    });

    it('should not flag valid parent chains', async () => {
      await writeFile(
        join(tempVaultDir, 'Tasks', 'Parent Task.md'),
        `---
type: task
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Child Task.md'),
        `---
type: task
status: raw
parent: "[[Parent Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Tasks', 'Grandchild Task.md'),
        `---
type: task
status: raw
parent: "[[Child Task]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found');
    });
  });
});
