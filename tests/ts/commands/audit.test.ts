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

    it('should audit child types', async () => {
      const result = await runCLI(['audit', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
    });

    it('should audit parent type and all descendants', async () => {
      const result = await runCLI(['audit', 'objective'], vaultDir);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('missing required fields', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with a required field that has NO default
      const schemaWithRequired = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          idea: {
            ...TEST_SCHEMA.types.idea,
            fields: {
              ...TEST_SCHEMA.types.idea.fields,
              requiredNoDefault: { prompt: 'text', required: true },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      const result = await runCLI(['audit', 'idea', '--only', 'invalid-option'], tempVaultDir);

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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      expect(issue.code).toBe('invalid-option');
      expect(issue.field).toBe('status');
      expect(issue.value).toBe('wip');
      expect(issue.expected).toContain('raw');
    });
  });

  describe('error handling', () => {
    it('should error on ambiguous/unknown positional arg', async () => {
      const result = await runCLI(['audit', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      // With unified targeting, unknown positional args show helpful disambiguation
      expect(result.stderr).toContain('Ambiguous argument');
      expect(result.stderr).toContain('--type=nonexistent');
    });
  });

  describe('summary statistics', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-fix-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

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

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

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

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

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

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-fix-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

      const result = await runCLI(['audit', 'idea', '--fix', '--execute'], tempVaultDir);

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
      const result = await runCLI(['audit', 'idea', '--fix', '--execute'], tempVaultDir, 'n\n');

      expect(result.stdout).toContain('Missing required field: status');
      expect(result.stdout).toContain('Skipped');
    });
  });

  describe('vault-wide scanning', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-vaultwide-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

    it('should respect BWRB_EXCLUDE env var', async () => {
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
      const originalEnv = process.env.BWRB_EXCLUDE;
      process.env.BWRB_EXCLUDE = 'Archive';

      try {
        const result = await runCLI(['audit'], tempVaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('Old Note.md');
        expect(result.stdout).not.toContain('Archive');
      } finally {
        // Restore env
        if (originalEnv === undefined) {
          delete process.env.BWRB_EXCLUDE;
        } else {
          process.env.BWRB_EXCLUDE = originalEnv;
        }
      }
    });

    it('should respect config.excluded_directories (and legacy alias)', async () => {
      const schemaWithExclusions = {
        ...TEST_SCHEMA,
        config: {
          excluded_directories: ['Templates'],
        },
        audit: {
          ignored_directories: ['Archive/Old'],
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-orphan-fix-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

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

      const result = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);

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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-allow-field-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-format-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Use schema with wikilink format field
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
type: milestone
status: in-flight
---
`
      );

      // Create a task with plain text instead of wikilink for milestone
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Bad Format.md'),
        `---
type: task
status: backlog
milestone: Q1 Release
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Bad Format.md'));
      expect(taskFile).toBeDefined();
      const formatIssue = taskFile.issues.find((i: { code: string }) => i.code === 'format-violation');
      expect(formatIssue).toBeDefined();
      expect(formatIssue.field).toBe('milestone');
      expect(formatIssue.autoFixable).toBe(true);
      expect(formatIssue.expectedFormat).toBe('wikilink');
    });

    it('should auto-fix format violation to wikilink', async () => {
      // Create a task with plain text instead of quoted-wikilink
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Fixable.md'),
        `---
type: task
status: backlog
milestone: Q1 Release
---
`
      );

      const result = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);

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
type: task
status: backlog
milestone: "[[Q1 Release]]"
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('format-violation');
    });
  });

  describe('stale reference detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-stale-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
type: task
status: backlog
milestone: "[[Non Existent Milestone]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Stale Ref.md'));
      expect(taskFile).toBeDefined();
      const staleIssue = taskFile.issues.find((i: { code: string }) => i.code === 'stale-reference');
      expect(staleIssue).toBeDefined();
      expect(staleIssue.targetName).toBe('Non Existent Milestone');
      expect(staleIssue.inBody).toBe(false);
    });

    it('should NOT detect stale reference in body content (v1.0 scope is frontmatter only)', async () => {
      // Body content link validation is deferred to v2.0
      // Per product scope, v1.0 only validates frontmatter relation fields
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

      // Should pass with no issues - body links are not validated in v1.0
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files.length).toBe(0); // No files with issues
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
type: milestone
status: in-flight
---
`
      );

      // Create a task with a typo in the milestone name
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Typo Ref.md'),
        `---
type: task
status: backlog
milestone: "[[Q1 Relase]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

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

    it('should NOT report body wikilinks even with multiple stale references (v1.0 scope)', async () => {
      // Body content link validation is deferred to v2.0
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

      // Should pass with no issues - body links are not validated in v1.0
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files.length).toBe(0);
    });

    it('should NOT report body wikilinks with aliases and headings (v1.0 scope)', async () => {
      // Body content link validation is deferred to v2.0
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

      // Should pass with no issues - body links are not validated in v1.0
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files.length).toBe(0);
    });
  });

  describe('schema allowed_extra_fields config', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-schema-allow-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
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
        join(tempVaultDir, '.bwrb', 'schema.json'),
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
      types: {
        objective: {
          fields: {
            status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], default: 'raw' },
          },
        },
        milestone: {
          extends: 'objective',
        },
        task: {
          extends: 'objective',
          fields: {
            milestone: {
              prompt: 'relation',
              source: 'milestone',  // Type-based source
            },
            parent: {
              prompt: 'relation',
              source: 'objective',  // Accepts objective or any descendant
            },
          },
        },
        idea: {
          fields: {
            status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], default: 'raw' },
          },
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-context-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

    it('should reject schemas with invalid structure', async () => {
      // Create an invalid schema (missing required 'types' structure)
      const invalidSchema = {
        version: 2,
        // Missing valid type definitions
        types: {},
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(invalidSchema, null, 2)
      );

      // Create a file that would trigger audit
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Test.md'),
        `---
type: idea
status: raw
---
`
      );

      const result = await runCLI(['audit'], tempVaultDir);

      // Should report invalid type since 'idea' type doesn't exist in this empty schema
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("Invalid type: 'idea'");
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
                prompt: 'relation',
                source: 'milestone',
                multiple: true,
              },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

  describe('positional type argument', () => {
    it('should not show deprecation warning when using positional type', async () => {
      const result = await runCLI(['audit', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Positional type is a permanent shortcut, not deprecated
      expect(result.stderr).not.toContain('deprecated');
      expect(result.stderr).not.toContain('Deprecated');
      expect(result.stdout).not.toContain('deprecated');
    });

    it('should not show deprecation warning for child type positional', async () => {
      const result = await runCLI(['audit', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('deprecated');
      expect(result.stderr).not.toContain('Deprecated');
    });
  });

  describe('parent cycle detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-cycle-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with a recursive type
      const schemaWithRecursive = {
        version: 2,
        types: {
          task: {
            recursive: true,
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], default: 'raw' }
            }
          }
        }
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
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

  describe('wrong-directory detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-wrongdir-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      // Create the expected directories
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives/Milestones'), { recursive: true });
      // Create an unexpected directory for misplaced files
      await mkdir(join(tempVaultDir, 'Random'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect wrong-directory in vault-wide audit', async () => {
      // Create a properly placed file
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Good Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Create a misplaced file: type is 'idea' but it's in Random/ not Ideas/
      await writeFile(
        join(tempVaultDir, 'Random', 'Misplaced Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Run vault-wide audit (no type specified)
      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      
      // Find the misplaced file in results
      const misplacedFile = output.files.find((f: { path: string }) => 
        f.path.includes('Misplaced Idea.md')
      );
      expect(misplacedFile).toBeDefined();
      
      // Should have wrong-directory issue
      const wrongDirIssue = misplacedFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Ideas');
      
      // The properly placed file should NOT appear in results (no issues)
      const goodFile = output.files.find((f: { path: string }) => 
        f.path.includes('Good Idea.md')
      );
      expect(goodFile).toBeUndefined();
    });

    it('should detect wrong-directory in type-specific audit', async () => {
      // Create a file in Objectives/Milestones/ but with type: task
      // This tests the regression case where type-specific audit should still work
      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Wrong Type Here.md'),
        `---
type: task
status: backlog
---
`
      );

      // Run type-specific audit for milestone (which will discover files in Milestones/)
      const result = await runCLI(['audit', 'milestone', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      
      const wrongTypeFile = output.files.find((f: { path: string }) => 
        f.path.includes('Wrong Type Here.md')
      );
      expect(wrongTypeFile).toBeDefined();
      
      // Should detect wrong-directory because file's actual type (task) 
      // should be in Objectives/Tasks, not Objectives/Milestones
      const wrongDirIssue = wrongTypeFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Objectives/Tasks');
    });

    it('should flag files in directories with similar name prefix', async () => {
      // Regression test: "Ideas2" should NOT be considered valid for type expecting "Ideas"
      // This tests segment-aware path matching (Ideas2 !== Ideas)
      await mkdir(join(tempVaultDir, 'Ideas2'), { recursive: true });

      await writeFile(
        join(tempVaultDir, 'Ideas2', 'Wrong Prefix.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      
      const wrongFile = output.files.find((f: { path: string }) => 
        f.path.includes('Wrong Prefix.md')
      );
      expect(wrongFile).toBeDefined();
      
      const wrongDirIssue = wrongFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Ideas');
    });

    it('should not report wrong-directory for correctly placed files', async () => {
      // Create files in their correct directories
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Correct Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Correct Task.md'),
        `---
type: task
status: backlog
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Correct Milestone.md'),
        `---
type: milestone
status: in-flight
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files.length).toBe(0);
      expect(output.summary.totalErrors).toBe(0);
    });

    it('should detect wrong-directory for files in computed default directory location', async () => {
      // All types get a computed output_dir even if not explicitly set.
      // This test verifies behavior when a file is placed in the wrong location
      // relative to the computed default directory.
      const schemaWithComputedDir = {
        version: 2,
        types: {
          note: {
            // No explicit output_dir - will compute to 'notes'
            fields: {
              status: { prompt: 'select', options: ['raw', 'done'], default: 'raw' },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithComputedDir, null, 2)
      );

      // Create directory for correct placement
      await mkdir(join(tempVaultDir, 'notes'), { recursive: true });

      // Create a note in the correct computed location
      await writeFile(
        join(tempVaultDir, 'notes', 'Correct Note.md'),
        `---
type: note
status: raw
---
`
      );

      // Create a note in wrong location
      await writeFile(
        join(tempVaultDir, 'Random', 'Wrong Note.md'),
        `---
type: note
status: raw
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      
      // The wrongly placed note should have wrong-directory issue
      const wrongFile = output.files.find((f: { path: string }) => 
        f.path.includes('Wrong Note.md')
      );
      expect(wrongFile).toBeDefined();
      const wrongDirIssue = wrongFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('notes');
      
      // The correctly placed note should have no issues
      const correctFile = output.files.find((f: { path: string }) => 
        f.path.includes('Correct Note.md')
      );
      expect(correctFile).toBeUndefined();
    });
  });

  describe('--execute flag validation', () => {
    it('should error when --execute is used without --fix', async () => {
      const result = await runCLI(['audit', '--execute'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute requires --fix');
    });

    it('should accept --execute with --fix', async () => {
      const result = await runCLI(['audit', '--fix', '--execute'], vaultDir);

      // Should run successfully (no issues in test vault)
      expect(result.exitCode).toBe(0);
    });
  });

  describe('wrong-directory auto-fix with --execute', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-wrong-dir-fix-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Objectives'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should show move preview without --execute', async () => {
      // Create idea in wrong directory
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Wrong Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', '--fix', '--auto'], tempVaultDir);


      // Should show what would be done
      expect(result.stdout).toContain('Would move to');
      expect(result.stdout).toContain('Ideas/');
      expect(result.stdout).toContain('--execute to apply');
    });

    it('should mark wrong-directory as auto-fixable in JSON output', async () => {
      // Create idea in wrong directory
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Wrong Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const wrongFile = output.files.find((f: { path: string }) => f.path.includes('Wrong Idea.md'));
      expect(wrongFile).toBeDefined();
      const wrongDirIssue = wrongFile.issues.find((i: { code: string }) => i.code === 'wrong-directory');
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.autoFixable).toBe(true);
      expect(wrongDirIssue.expectedDirectory).toBe('Ideas');
    });

    it('should move file with --execute', async () => {
      // Create idea in wrong directory
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Misplaced Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
Content here
`
      );

      const result = await runCLI(['audit', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Moved to Ideas/');
      expect(result.exitCode).toBe(0);

      // Verify the file was actually moved
      const { readFile: rf, access } = await import('fs/promises');
      
      // Old location should not exist
      await expect(access(join(tempVaultDir, 'Objectives', 'Misplaced Idea.md'))).rejects.toThrow();
      
      // New location should exist with correct content
      const content = await rf(join(tempVaultDir, 'Ideas', 'Misplaced Idea.md'), 'utf-8');
      expect(content).toContain('type: idea');
      expect(content).toContain('Content here');
    });

    it('should update wikilinks when moving file', async () => {
      // Create idea in wrong directory
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Linked Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
`
      );

      // Create file that links to it
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Linking Note.md'),
        `---
type: idea
status: raw
priority: medium
---

See [[Linked Idea]] for more info.
`
      );

      const result = await runCLI(['audit', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Moved to Ideas/');
      // Wikilinks should be updated (or stay the same if basename unique)
      
      // Verify the link still works (file was moved, link updated if needed)
      const { readFile: rf, access } = await import('fs/promises');
      await expect(access(join(tempVaultDir, 'Ideas', 'Linked Idea.md'))).resolves.toBeUndefined();
    });
  });

  describe('parent-cycle detection', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-parent-cycle-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Create a schema with recursive type
      const schemaWithRecursive = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          recursive: {
            output_dir: 'Recursive',
            recursive: true,
            fields: {
              status: { prompt: 'select', options: ['active', 'done'], default: 'active' },
              parent: { prompt: 'relation', source: 'recursive' },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithRecursive, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Recursive'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect self-referencing parent', async () => {
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Self Ref.md'),
        `---
type: recursive
status: active
parent: "[[Self Ref]]"
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Self Ref.md'));
      expect(file).toBeDefined();
      const cycleIssue = file.issues.find((i: { code: string }) => i.code === 'parent-cycle');
      expect(cycleIssue).toBeDefined();
      expect(cycleIssue.cyclePath).toContain('Self Ref');
    });

    it('should detect two-node parent cycle', async () => {
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Node A.md'),
        `---
type: recursive
status: active
parent: "[[Node B]]"
---
`
      );
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Node B.md'),
        `---
type: recursive
status: active
parent: "[[Node A]]"
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      // At least one of them should have a cycle detected
      const fileWithCycle = output.files.find((f: { path: string; issues: { code: string }[] }) => 
        f.issues.some((i: { code: string }) => i.code === 'parent-cycle')
      );
      expect(fileWithCycle).toBeDefined();
    });

    it('should not report cycle for valid parent chain', async () => {
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Parent.md'),
        `---
type: recursive
status: active
---
`
      );
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Child.md'),
        `---
type: recursive
status: active
parent: "[[Parent]]"
---
`
      );
      await writeFile(
        join(tempVaultDir, 'Recursive', 'Grandchild.md'),
        `---
type: recursive
status: active
parent: "[[Child]]"
---
`
      );

      const result = await runCLI(['audit', 'recursive'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('parent-cycle');
    });
  });

  describe('invalid-type interactive fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-invalid-type-fix-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should offer type selection for invalid-type in interactive fix mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Invalid Type.md'),
        `---
type: notavalidtype
status: raw
---
`
      );

      // Just check that we see the issue and suggestion - full interactive testing done in PTY tests
      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Invalid Type.md'));
      expect(file).toBeDefined();
      const typeIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-type');
      expect(typeIssue).toBeDefined();
      expect(typeIssue.value).toBe('notavalidtype');
    });

    it('should show suggestion for typo in type', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Typo Type.md'),
        `---
type: idee
status: raw
---
`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Typo Type.md'));
      expect(file).toBeDefined();
      const typeIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-type');
      expect(typeIssue).toBeDefined();
      // Should suggest 'idea' for 'idee'
      expect(typeIssue.suggestion).toContain('idea');
    });
  });

  // ============================================================================
  // Phase 2: Low-risk hygiene auto-fixes
  // ============================================================================

  // NOTE: trailing-whitespace detection is NOT possible because YAML parsers
  // (gray-matter) strip trailing whitespace during parsing. These tests are
  // skipped until we implement raw string detection before YAML parsing.
  describe('trailing-whitespace detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-whitespace-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect trailing whitespace in field value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Trailing Space.md'),
        `---
type: idea
status: raw  
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Trailing Space.md'));
      expect(file).toBeDefined();
      const wsIssue = file.issues.find((i: { code: string }) => i.code === 'trailing-whitespace');
      expect(wsIssue).toBeDefined();
      expect(wsIssue.field).toBe('status');
      expect(wsIssue.autoFixable).toBe(true);
    });

    it('should detect trailing whitespace after closing quote', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Quoted Trailing Space.md'),
        `---
 type: idea
 status: "raw"  
 priority: medium
 ---
 `
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Quoted Trailing Space.md'));
      expect(file).toBeDefined();
      const wsIssue = file.issues.find((i: { code: string }) => i.code === 'trailing-whitespace');
      expect(wsIssue).toBeDefined();
      expect(wsIssue.field).toBe('status');
      expect(wsIssue.lineNumber).toBe(3);
    });

    it('should not flag whitespace inside quotes', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Quoted Internal Space.md'),
        `---
 type: idea
 status: "raw  "
 priority: medium
 ---
 `
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Quoted Internal Space.md'));
      expect(file).toBeDefined();
      const wsIssue = file.issues.find((i: { code: string }) => i.code === 'trailing-whitespace');
      expect(wsIssue).toBeUndefined();
    });

    it('should not flag trailing whitespace inside block scalar content', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Block Scalar.md'),
        `---
 type: idea
 status: raw
 priority: medium
 notes: |
   hello  
   world
 ---
 `
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Block Scalar.md'));
      expect(file).toBeDefined();
      const wsIssue = file.issues.find((i: { code: string }) => i.code === 'trailing-whitespace');
      expect(wsIssue).toBeUndefined();
    });

    it('should auto-fix trailing whitespace', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Whitespace.md'),
        `---
type: idea
status: raw  
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Trimmed whitespace');
      expect(result.stdout).toContain('Fixed: 1');

      // Verify the file was fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Whitespace.md'), 'utf-8');
      expect(content).toContain('status: raw\n');
      expect(content).not.toContain('status: raw  ');
    });
  });

  describe('invalid-boolean-coercion detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-boolean-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with a boolean field
      const schemaWithBoolean = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          idea: {
            ...TEST_SCHEMA.types.idea,
            fields: {
              ...TEST_SCHEMA.types.idea.fields,
              archived: { prompt: 'boolean', required: false },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithBoolean, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect string "true" in boolean field', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'String Boolean.md'),
        `---
type: idea
status: raw
priority: medium
archived: "true"
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('String Boolean.md'));
      expect(file).toBeDefined();
      const boolIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-boolean-coercion');
      expect(boolIssue).toBeDefined();
      expect(boolIssue.field).toBe('archived');
      expect(boolIssue.autoFixable).toBe(true);
    });

    it('should auto-fix string "true" to boolean', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Boolean.md'),
        `---
type: idea
status: raw
priority: medium
archived: "true"
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Coerced');
      expect(result.stdout).toContain('boolean');

      // Verify the file was fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Boolean.md'), 'utf-8');
      expect(content).toContain('archived: true');
      expect(content).not.toContain('archived: "true"');
    });
  });

  describe('unknown-enum-casing detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-enum-casing-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect wrong casing in enum value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Wrong Case.md'),
        `---
type: idea
status: Raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Wrong Case.md'));
      expect(file).toBeDefined();
      const casingIssue = file.issues.find((i: { code: string }) => i.code === 'unknown-enum-casing');
      expect(casingIssue).toBeDefined();
      expect(casingIssue.field).toBe('status');
      expect(casingIssue.canonicalValue).toBe('raw');
      expect(casingIssue.autoFixable).toBe(true);
    });

    it('should auto-fix enum casing', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Case.md'),
        `---
type: idea
status: Raw
priority: Medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Fixed');
      expect(result.stdout).toContain('casing');

      // Verify the file was fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Case.md'), 'utf-8');
      expect(content).toContain('status: raw');
      expect(content).toContain('priority: medium');
    });
  });

  describe('duplicate-list-values detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-duplicate-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect duplicate values in list (case-insensitive)', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Duplicates.md'),
        `---
type: idea
status: raw
priority: medium
tags:
  - urgent
  - Urgent
  - important
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Duplicates.md'));
      expect(file).toBeDefined();
      const dupIssue = file.issues.find((i: { code: string }) => i.code === 'duplicate-list-values');
      expect(dupIssue).toBeDefined();
      expect(dupIssue.field).toBe('tags');
      expect(dupIssue.autoFixable).toBe(true);
    });

    it('should auto-fix duplicate list values', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Dups.md'),
        `---
type: idea
status: raw
priority: medium
tags:
  - urgent
  - Urgent
  - important
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Deduplicated');

      // Verify the file was fixed - should keep first occurrence
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Dups.md'), 'utf-8');
      expect(content).toContain('urgent');
      expect(content).toContain('important');
      // Should only have one of the duplicate values
      const matches = content.match(/urgent/gi);
      expect(matches?.length).toBe(1);
    });
  });

  describe('frontmatter-key-casing detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-key-casing-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect wrong key casing', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Wrong Key.md'),
        `---
type: idea
Status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Wrong Key.md'));
      expect(file).toBeDefined();
      const keyIssue = file.issues.find((i: { code: string }) => i.code === 'frontmatter-key-casing');
      expect(keyIssue).toBeDefined();
      expect(keyIssue.field).toBe('Status');
      expect(keyIssue.canonicalKey).toBe('status');
      expect(keyIssue.autoFixable).toBe(true);
    });

    it('should auto-fix key casing', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Key.md'),
        `---
type: idea
Status: raw
Priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Renamed');

      // Verify the file was fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Key.md'), 'utf-8');
      expect(content).toContain('status: raw');
      expect(content).toContain('priority: medium');
      expect(content).not.toContain('Status:');
      expect(content).not.toContain('Priority:');
    });

    it('should handle conflict when both casings exist', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Conflict.md'),
        `---
type: idea
status: raw
Status: backlog
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Conflict.md'));
      expect(file).toBeDefined();
      const keyIssue = file.issues.find((i: { code: string }) => i.code === 'frontmatter-key-casing');
      expect(keyIssue).toBeDefined();
      expect(keyIssue.hasConflict).toBe(true);
      // Should not be auto-fixable when both have values
      expect(keyIssue.autoFixable).toBe(false);
    });
  });

  describe('singular-plural-mismatch detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-plural-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      // Schema with plural 'tags' field
      const schemaWithTags = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          idea: {
            ...TEST_SCHEMA.types.idea,
            fields: {
              ...TEST_SCHEMA.types.idea.fields,
              tags: { prompt: 'list', required: false },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithTags, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should detect singular when plural expected', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Singular.md'),
        `---
type: idea
status: raw
priority: medium
tag: urgent
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Singular.md'));
      expect(file).toBeDefined();
      const pluralIssue = file.issues.find((i: { code: string }) => i.code === 'singular-plural-mismatch');
      expect(pluralIssue).toBeDefined();
      expect(pluralIssue.field).toBe('tag');
      expect(pluralIssue.canonicalKey).toBe('tags');
      expect(pluralIssue.autoFixable).toBe(true);
    });

    it('should auto-fix singular to plural', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Plural.md'),
        `---
type: idea
status: raw
priority: medium
tag: urgent
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Renamed');
      expect(result.stdout).toContain('tag');
      expect(result.stdout).toContain('tags');

      // Verify the file was fixed
      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Plural.md'), 'utf-8');
      expect(content).toContain('tags: urgent');
      expect(content).not.toContain('tag:');
    });
  });
});
