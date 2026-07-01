import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
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

    it('should fail for invalid --where field when --type is provided', async () => {
      const result = await runCLI([
        'audit',
        '--type', 'idea',
        '--where', "unknown_field == 'raw'"
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown field 'unknown_field'");
      expect(result.stderr).toContain("for type 'idea'");
    });

    it('should allow unknown where fields without --type (permissive mode)', async () => {
      const result = await runCLI([
        'audit',
        '--where', "unknown_field == 'raw'"
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('should fail on invalid where syntax', async () => {
      const result = await runCLI([
        'audit',
        '--where', "status == 'raw' &&"
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Expression error in');
      expect(result.stderr).toContain('Expression parse error');
    });

    it('should fail on where runtime errors in json mode', async () => {
      const result = await runCLI([
        'audit',
        '--where', 'missingFn(status)',
        '--output', 'json'
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Expression error in');
      expect(json.error).toContain('Unknown function: missingFn');
      expect(result.stderr).toContain('Expression error in');
    });
  });

  describe('relation field integrity', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-test-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
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

    it('should detect self-reference in parent relation', async () => {
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Self Task.md'),
`---
type: task
status: backlog
parent: "[[Self Task]]"
---
`
      );


      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Self-reference detected: parent points to itself');
    });

    it('should prefer ambiguous-link-target over self-reference when target is ambiguous', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks/Sub'), { recursive: true });

      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Self Task.md'),
`---
type: task
status: backlog
parent: "[[Self Task]]"
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks/Sub', 'Self Task.md'),
`---
type: task
status: backlog
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Ambiguous link target for parent: 'Self Task'");
      expect(result.stdout).not.toContain('Self-reference detected');
    });

    it('should detect ambiguous relation target', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks/Sub'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Ambiguous.md'),
`---
type: task
status: backlog
milestone: "[[Shared]]"
---
`
      );

      await mkdir(join(tempVaultDir, 'Objectives/Milestones/Shared'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Shared.md'),
        `---
type: milestone
status: raw
---
`
      );
      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Shared', 'Shared.md'),
        `---
type: milestone
status: raw
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Ambiguous link target for milestone: 'Shared'");
    });

    it('should detect invalid list elements', async () => {
      const schema = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          task: {
            ...TEST_SCHEMA.types.task,
            fields: {
              ...(TEST_SCHEMA.types.task.fields ?? {}),
              tags: {
                ...(TEST_SCHEMA.types.task.fields?.tags ?? {}),
                prompt: 'select',
                options: ['good', 'bad'],
                multiple: true,
              },
            },
          },
        },
      };

      await writeFile(join(tempVaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));

      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Bad List.md'),
        `---
type: task
status: backlog
priority: medium
tags:
  - good
  - 42
---
`
      );

      const result = await runCLI(['audit', 'task'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Invalid list element in 'tags' at index 1");
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

    it('should ignore built-in id and name fields', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Builtins.md'),
        `---
type: idea
id: 123e4567-e89b-12d3-a456-426614174000
name: Example
status: raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Unknown field: id');
      expect(result.stdout).not.toContain('Unknown field: name');
    });

    it('should not warn on id/name for notes created by bwrb new', async () => {
      const createResult = await runCLI(
        [
          'new',
          'idea',
          '--no-template',
          '--json',
          JSON.stringify({ name: 'Example', status: 'raw' }),
        ],
        tempVaultDir
      );

      const createJson = JSON.parse(createResult.stdout) as { success: boolean; path: string };
      expect(createJson.success).toBe(true);

      const auditResult = await runCLI(['audit', createJson.path], tempVaultDir);

      expect(auditResult.exitCode).toBe(0);
      expect(auditResult.stdout).not.toContain('Unknown field: id');
      expect(auditResult.stdout).not.toContain('Unknown field: name');
    });

    it('should keep strict mode errors for real unknown fields', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Builtins With Extra.md'),
        `---
type: idea
id: 123e4567-e89b-12d3-a456-426614174000
name: Example
status: raw
priority: medium
customField: value
---
`
      );

      const result = await runCLI(['audit', 'idea', '--strict'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Unknown field: customField');
      expect(result.stdout).not.toContain('Unknown field: id');
      expect(result.stdout).not.toContain('Unknown field: name');
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

    it('should exclude built-in fields from unknown-field issues', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Builtins.json.md'),
        `---
type: idea
id: 123e4567-e89b-12d3-a456-426614174000
name: Example
status: raw
priority: medium
customField: value
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      type AuditIssue = { code: string; field?: string };
      const json = JSON.parse(result.stdout) as { files: Array<{ issues: AuditIssue[] }> };
      const unknownIssues = json.files
        .flatMap(file => file.issues)
        .filter((issue): issue is AuditIssue => issue.code === 'unknown-field');
      const unknownFields = unknownIssues.map(issue => issue.field);
      expect(unknownFields).toContain('customField');
      expect(unknownFields).not.toContain('id');
      expect(unknownFields).not.toContain('name');
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

    it('should not flag a missing required field when the field has a default (#743)', async () => {
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

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Fixed: 0 issues');
      expect(result.stdout).toContain('Remaining: 0 issues');
      expect(result.stdout).not.toContain('Added status');
      expect(result.stdout).not.toContain('Fixed: 1 issues');

      // Verify audit --fix left the satisfied-by-default absence untouched.
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Missing Status.md'), 'utf-8');
      expect(content).not.toContain('status: raw');
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

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Issues requiring manual review');
      expect(result.stdout).toContain('Invalid status value');
      expect(result.stdout).toContain('Remaining: 1 issues');
      expect(result.stdout).toContain('Fixed: 0 issues');
    });

    it('should handle mix of fixable and non-fixable issues', async () => {
      // File with blank status (fixable) and invalid enum (not fixable)
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fixable.md'),
        `---
type: idea
status: " "
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
      expect(result.stdout).toContain('Skipped: 0 issues');
    });

    it('should exit with 0 when all issues are fixed', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Missing Status.md'),
        `---
type: idea
status: " "
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Fixed: 1 issues');
      expect(result.stdout).toContain('Remaining: 0 issues');
    });

    it('should auto-migrate unambiguous unknown field in --auto mode', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Deadline Typo.md'),
        `---
type: task
status: backlog
dead_line: 2026-01-01
---
`
      );

      const result = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated dead_line');
      expect(result.stdout).toContain('Remaining: 0 issues');

      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Objectives/Tasks', 'Deadline Typo.md'), 'utf-8');
      expect(content).toContain('deadline: 2026-01-01');
      expect(content).not.toContain('dead_line:');
    });

    it('should never delete orphan or invalid-type files in --auto mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'No Type.md'),
        `---
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad Type.md'),
        `---
type: definitely-not-a-type
status: raw
---
`
      );

      const result = await runCLI(['audit', '--all', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Issues requiring manual review');
      expect(result.stdout).toContain('No Type.md');
      expect(result.stdout).toContain('Bad Type.md');

      const noTypeContent = await readFile(join(tempVaultDir, 'Ideas', 'No Type.md'), 'utf-8');
      const badTypeContent = await readFile(join(tempVaultDir, 'Ideas', 'Bad Type.md'), 'utf-8');
      expect(noTypeContent).toContain('status: raw');
      expect(badTypeContent).toContain('type: definitely-not-a-type');
    });
  });

  describe('audit --fix messaging', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-fix-msg-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TEST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Ideas'), { recursive: true });

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Needs Status.md'),
        `---
type: idea
status: " "
priority: medium
---
`
      );
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('should prompt to rerun with --execute after auto preview', async () => {
      const result = await runCLI(
        ['audit', '--fix', '--auto', '--dry-run', '--path', 'Ideas/**'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Re-run with '--execute' to apply fixes.");
    });

    it('should allow --fix --dry-run without --auto in non-TTY mode', async () => {
      const result = await runCLI(
        ['audit', '--fix', '--dry-run', '--path', 'Ideas/**'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run - no changes written');
      expect(result.stdout).toContain('Would fill status with default "raw"');
      expect(result.stdout).toContain('Would skip: 1 issues');
      expect(result.stderr).not.toContain('requires a TTY');
    });

    it('should not mention --execute after applying fixes', async () => {
      const result = await runCLI(
        ['audit', '--fix', '--auto', '--execute', '--path', 'Ideas/**'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--execute');
      expect(result.stdout).not.toContain("Re-run without '--dry-run'");
    });

    it('should error when --execute is used without --auto', async () => {
      const result = await runCLI(
        ['audit', '--fix', '--execute', '--path', 'Ideas/**'],
        tempVaultDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute requires --fix --auto');
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
      const parsed = JSON.parse(result.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('--fix is not compatible with --output json');
    });

    it('should error when --execute is used with --dry-run', async () => {
      const result = await runCLI(['audit', '--fix', '--auto', '--dry-run', '--execute', '--all'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute cannot be used with --dry-run');
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

      const result = await runCLI(['audit', 'idea', '--fix'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No issues found');
    });

    it('should refuse interactive fix without TTY', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Bad.md'),
        `---
type: idea
status: " "
priority: medium
---
`
      );


      const result = await runCLI(['audit', 'idea', '--fix'], tempVaultDir, 'n\n');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('audit --fix is interactive and requires a TTY');
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

        // The excluded file should not be scanned/reported. This test isn't meant to
        // assert exit code behavior (which depends on whether any issues exist).
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
      expect(orphanIssue.meta?.recommendation?.action).toBe('delete-note');
      expect(orphanIssue.meta?.recommendation?.interactiveOnly).toBe(true);
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

    it('should keep delete-note recommendation when schema has zero types', async () => {
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify({ version: 2, types: {} }, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Inbox'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Inbox', 'No Type.md'),
        `---
status: raw
---
`
      );

      const result = await runCLI(['audit', '--all', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const orphanFile = output.files.find((f: { path: string }) => f.path.includes('No Type.md'));
      expect(orphanFile).toBeDefined();
      const orphanIssue = orphanFile.issues.find((i: { code: string }) => i.code === 'orphan-file');
      expect(orphanIssue).toBeDefined();
      expect(orphanIssue.meta?.recommendation?.action).toBe('delete-note');
      expect(orphanIssue.meta?.recommendation?.interactiveOnly).toBe(true);
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

    it('should not report a broken body wikilink as a frontmatter stale-reference (#652)', async () => {
      // Body link validation (#652) uses its own `broken-body-wikilink` code;
      // frontmatter-only `stale-reference` must never fire on a body link.
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
      const file = output.files.find((f: { path: string }) => f.path.includes('Body Links.md'));
      expect(file).toBeDefined();
      // The body link is flagged as broken-body-wikilink, NOT stale-reference.
      expect(file.issues.some((i: { code: string }) => i.code === 'broken-body-wikilink')).toBe(true);
      expect(file.issues.some((i: { code: string }) => i.code === 'stale-reference')).toBe(false);
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

    it('should report every broken body wikilink (#652)', async () => {
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
      const file = output.files.find((f: { path: string }) => f.path.includes('Multiple Links.md'));
      expect(file).toBeDefined();
      const broken = file.issues.filter((i: { code: string }) => i.code === 'broken-body-wikilink');
      expect(broken).toHaveLength(2);
    });

    it('should resolve broken body wikilinks past aliases and headings (#652)', async () => {
      // The target is missing regardless of `|alias` / `#heading` suffixes, so all
      // three are flagged as broken-body-wikilink (the suffixes are stripped for
      // resolution).
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
      const file = output.files.find((f: { path: string }) => f.path.includes('Complex Links.md'));
      expect(file).toBeDefined();
      const broken = file.issues.filter((i: { code: string }) => i.code === 'broken-body-wikilink');
      expect(broken).toHaveLength(3);
      expect(broken.every((i: { targetName: string }) => i.targetName === 'Missing Note')).toBe(true);
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
          fields: {
            aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
          },
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
            any_ref: {
              prompt: 'relation',
              source: 'any',
            },
          },
        },
        idea: {
          fields: {
            status: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], default: 'raw' },
            aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
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

    it('accepts an alias target when the aliased note satisfies the source type', async () => {
      await writeFile(
        join(tempVaultDir, 'objectives/milestones', 'Launch.md'),
        `---
type: milestone
status: raw
aliases:
  - Release Alias
---
`
      );

      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Alias Ref.md'),
        `---
type: task
status: backlog
milestone: "[[Release Alias]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files).toEqual([]);
    });

    it('accepts path-qualified references for source any', async () => {
      await writeFile(
        join(tempVaultDir, 'ideas', 'Only Wrong.md'),
        `---
type: idea
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Any Ref.md'),
        `---
type: task
status: backlog
any_ref: "[[ideas/Only Wrong]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files).toEqual([]);
    });

    it('reports a clear wrong-type error for a path-qualified reference', async () => {
      await writeFile(
        join(tempVaultDir, 'ideas', 'Only Wrong.md'),
        `---
type: idea
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Path Wrong Type.md'),
        `---
type: task
status: backlog
milestone: "[[ideas/Only Wrong]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Path Wrong Type.md'));
      const sourceIssue = taskFile.issues.find((i: { code: string }) => i.code === 'invalid-source-type');
      expect(sourceIssue).toMatchObject({
        field: 'milestone',
        value: '[[ideas/Only Wrong]]',
        expectedType: 'milestone',
        actualType: 'idea',
        expected: 'milestone',
        autoFixable: false,
      });
      expect(sourceIssue.message).toContain("'milestone' expects milestone");
      expect(sourceIssue.message).toContain("'ideas/Only Wrong' is idea");
    });

    it('accepts a bare ambiguous basename when one candidate has an allowed type', async () => {
      await writeFile(
        join(tempVaultDir, 'objectives/milestones', 'Shared.md'),
        `---
type: milestone
status: raw
---
`
      );
      await writeFile(
        join(tempVaultDir, 'ideas', 'Shared.md'),
        `---
type: idea
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Ambiguous Allowed.md'),
        `---
type: task
status: backlog
milestone: "[[Shared]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.files).toEqual([]);
    });

    it('reports wrong-type when a bare basename has no allowed-type candidates', async () => {
      await writeFile(
        join(tempVaultDir, 'ideas', 'Only Wrong.md'),
        `---
type: idea
status: raw
---
`
      );

      await writeFile(
        join(tempVaultDir, 'objectives/tasks', 'Ambiguous None Allowed.md'),
        `---
type: task
status: backlog
milestone: "[[Only Wrong]]"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const taskFile = output.files.find((f: { path: string }) => f.path.includes('Ambiguous None Allowed.md'));
      const sourceIssue = taskFile.issues.find((i: { code: string }) => i.code === 'invalid-source-type');
      expect(sourceIssue).toMatchObject({
        field: 'milestone',
        value: '[[Only Wrong]]',
        expectedType: 'milestone',
        actualType: 'idea',
        expected: 'milestone',
      });
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
## Steps
- [ ] Step 1

## Notes
`
      );

      await writeFile(
        join(tempVaultDir, 'Objectives/Milestones', 'Correct Milestone.md'),
        `---
type: milestone
status: in-flight
---
## Tasks
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

  // Owned notes (e.g. a `track` owned by an `album` via an `owned` field) live
  // under their owner at `<owner-dir>/<field>/`, NOT in the owned type's own
  // `output_dir`. Regression coverage for #661: audit must not flag a
  // correctly-placed owned note as wrong-directory, while a genuinely-misplaced
  // owned note (outside any valid owner subtree) is still flagged.
  describe('wrong-directory detection for owned notes (#661)', () => {
    let tempVaultDir: string;

    // album (output_dir: Albums) owns `track` (output_dir: Tracks) via `songs`.
    const OWNERSHIP_SCHEMA = {
      version: 2,
      types: {
        album: {
          output_dir: 'Albums',
          fields: {
            type: { value: 'album' },
            status: {
              prompt: 'select',
              options: ['raw', 'in-flight', 'settled'],
              default: 'raw',
              required: true,
            },
            songs: { prompt: 'relation', source: 'track', owned: true },
          },
          field_order: ['type', 'status', 'songs'],
        },
        track: {
          output_dir: 'Tracks',
          fields: { type: { value: 'track' } },
          field_order: ['type'],
        },
        note: {
          output_dir: 'Notes',
          fields: { type: { value: 'note' } },
          field_order: ['type'],
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-owned-wrongdir-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(OWNERSHIP_SCHEMA, null, 2)
      );
      // Owner note + its owned-field subfolder.
      await mkdir(join(tempVaultDir, 'Albums/Best Album/songs'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nstatus: in-flight\n---\n`
      );
      await mkdir(join(tempVaultDir, 'Tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Random'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('does not flag a correctly-placed owned note as wrong-directory', async () => {
      // Owned `track` living under its owner at Albums/Best Album/songs/.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const ownedFile = output.files.find((f: { path: string }) =>
        f.path.includes('Opening Track.md')
      );
      expect(ownedFile).toBeUndefined();
    });

    it('still flags a genuinely-misplaced owned-type note', async () => {
      // A `track` placed in Random/ is NOT under any valid owner subtree, so it
      // is discovered as a plain pooled note and must be flagged against Tracks.
      await writeFile(
        join(tempVaultDir, 'Random', 'Stray Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const strayFile = output.files.find((f: { path: string }) =>
        f.path.includes('Stray Track.md')
      );
      expect(strayFile).toBeDefined();
      const wrongDirIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Tracks');
    });

    it('does not flag a non-owned note nested under its output_dir (#660 unchanged)', async () => {
      // A non-owned `track` filed in a nested subdir of its own output_dir is a
      // correct location and must remain clean.
      await mkdir(join(tempVaultDir, 'Tracks/Sub'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Tracks/Sub', 'Nested Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const nestedFile = output.files.find((f: { path: string }) =>
        f.path.includes('Nested Track.md')
      );
      expect(nestedFile).toBeUndefined();
    });

    it('flags a note whose type differs from the owned field child type placed in an owned-field folder', async () => {
      // A `type: note` note dropped into the `songs/` owned-field folder gets
      // `file.ownership` attached by discovery (folder-location only), but it is
      // NOT a legitimate owned note: the owned field's child type is `track`, not
      // `note`. Its real type (`note`) determines where it belongs, so it must be
      // flagged against note's own output_dir (Notes), not exempted by the
      // owner-subtree rule. (Regression for the Codex P2 false-negative on #701.)
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Misfiled Note.md'),
        `---\ntype: note\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const misfiled = output.files.find((f: { path: string }) =>
        f.path.includes('Misfiled Note.md')
      );
      expect(misfiled).toBeDefined();
      const wrongDirIssue = misfiled.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Notes');
    });

    it('flags an owned-type child under a fake (wrong-type) owner note', async () => {
      // `Albums/Fake/Fake.md` is a fake owner: it exists where an owner note
      // would live, but its `type` is `note`, not `album`. Discovery attaches
      // ownership to children purely from folder structure (the owner note's
      // existence), so a `type: track` child under `Albums/Fake/songs/` arrives
      // with `file.ownership` even though there is no real album owning it.
      // Because the owner note does not actually resolve to the expected owner
      // type, the owner-subtree exemption must NOT apply: the child is flagged
      // against `track`'s own output_dir (Tracks). (Regression for the Codex P2
      // owner-side false-negative on #701.)
      await mkdir(join(tempVaultDir, 'Albums/Fake/songs'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Albums/Fake', 'Fake.md'),
        `---\ntype: note\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Albums/Fake/songs', 'Stranded Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const stranded = output.files.find((f: { path: string }) =>
        f.path.includes('Stranded Track.md')
      );
      expect(stranded).toBeDefined();
      const wrongDirIssue = stranded.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Tracks');
    });
  });

  // A genuinely-misplaced OWNED note — one an owner declares in its `owned`
  // field but which has been moved out of its `<owner-dir>/<field>/` subtree —
  // must be recognised as owned (via the owner's declaration, not its current
  // folder) and reported with the richer `owned-wrong-location` code whose
  // --fix target RESTORES it under its owner, not its type's own output_dir
  // (#702/#703).
  describe('owned-wrong-location detection + fix (#702/#703)', () => {
    let tempVaultDir: string;

    // album (output_dir: Albums) owns `track` (output_dir: Tracks) via `songs`.
    const OWNERSHIP_SCHEMA = {
      version: 2,
      types: {
        album: {
          output_dir: 'Albums',
          fields: {
            type: { value: 'album' },
            songs: { prompt: 'relation', source: 'track', owned: true, multiple: true },
          },
          field_order: ['type', 'songs'],
        },
        track: {
          output_dir: 'Tracks',
          fields: { type: { value: 'track' } },
          field_order: ['type'],
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-owned-loc-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(OWNERSHIP_SCHEMA, null, 2)
      );
      // Owner note declares ownership of "Opening Track" via its `songs` field.
      await mkdir(join(tempVaultDir, 'Albums/Best Album/songs'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Opening Track]]"\n---\n`
      );
      await mkdir(join(tempVaultDir, 'Tracks'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('reports a misplaced owned note as owned-wrong-location (not wrong-directory)', async () => {
      // "Opening Track" is declared owned by Best Album but sits in Tracks/.
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const strayFile = output.files.find((f: { path: string }) =>
        f.path.includes('Opening Track.md')
      );
      expect(strayFile).toBeDefined();

      // Richer owned-wrong-location issue, carrying the owner path, with the
      // RESTORE target under the owner subtree — not Tracks.
      const ownedIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');
      expect(ownedIssue.ownerPath).toBe('Albums/Best Album/Best Album.md');

      // Exactly one location issue — no duplicate generic wrong-directory.
      const wrongDirIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeUndefined();
    });

    it('--fix restores a misplaced owned note under its owner subtree (#702)', async () => {
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(
        ['audit', '--fix', '--all', '--auto', '--execute'],
        tempVaultDir
      );
      expect(result.exitCode).toBe(0);

      // Restored under the owner, NOT stranded in Tracks/.
      const restored = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
        'utf-8'
      ).catch(() => null);
      expect(restored).not.toBeNull();

      const stranded = await readFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        'utf-8'
      ).catch(() => null);
      expect(stranded).toBeNull();

      // Re-audit is clean.
      const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(after.exitCode).toBe(0);
    });

    it('does not flag a correctly-placed declared owned note', async () => {
      // Same declared note, but correctly located under the owner subtree.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const ownedFile = output.files.find((f: { path: string }) =>
        f.path.includes('Opening Track.md')
      );
      expect(ownedFile).toBeUndefined();
    });

    it('still flags a non-owned misplaced track against its own output_dir (unchanged)', async () => {
      // "Random Track" is NOT declared by any owner, so it is a plain misplaced
      // note: the generic wrong-directory check must still target Tracks.
      await mkdir(join(tempVaultDir, 'Misc'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Misc', 'Random Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const strayFile = output.files.find((f: { path: string }) =>
        f.path.includes('Random Track.md')
      );
      expect(strayFile).toBeDefined();
      const wrongDirIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Tracks');
      const ownedIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeUndefined();
    });

    it('restores a note stranded in a deep wrong subfolder under its owner subtree', async () => {
      // The owner subtree (Albums/Best Album/songs) is itself nested under the
      // vault root, and the stray note sits in a deep, unrelated subfolder. The
      // restore target must still be the owner subtree (getOwnedChildFolder on a
      // nested owner path), not the type's top-level Tracks output_dir.
      await mkdir(join(tempVaultDir, 'Tracks/2026/B-sides'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Tracks/2026/B-sides', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const strayFile = output.files.find((f: { path: string }) =>
        f.path.includes('Opening Track.md')
      );
      expect(strayFile).toBeDefined();
      const ownedIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');
      // No duplicate generic wrong-directory.
      const wrongDirIssue = strayFile.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeUndefined();
    });

    // #734: a declared `owned` wikilink written PATH-QUALIFIED, ALIASED, or both
    // must still recognise and restore the misplaced owned note. Previously the
    // declaredOwned key stored the raw target (`tracks/opening track`,
    // `opening track|intro`), so the basename lookup (`opening track`) never
    // matched and the note was missed (or, from another folder, --fix targeted
    // the type dir instead of restoring under the owner).
    it.each([
      ['path-qualified', '[[Tracks/Opening Track]]'],
      ['aliased', '[[Opening Track|Intro]]'],
      ['path + alias', '[[Tracks/Opening Track|Intro]]'],
    ])(
      'recognises + restores a misplaced owned note declared with a %s wikilink',
      async (_label, declaredLink) => {
        // Owner declares ownership using a non-bare wikilink form.
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
          `---\ntype: album\nsongs:\n  - "${declaredLink}"\n---\n`
        );
        // The owned note is misplaced in Tracks/.
        await writeFile(
          join(tempVaultDir, 'Tracks', 'Opening Track.md'),
          `---\ntype: track\n---\n`
        );

        // Detected as owned-wrong-location, restore target under the owner.
        const detect = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        expect(detect.exitCode).toBe(1);
        const output = JSON.parse(detect.stdout);
        const strayFile = output.files.find((f: { path: string }) =>
          f.path.includes('Opening Track.md')
        );
        expect(strayFile).toBeDefined();
        const ownedIssue = strayFile.issues.find(
          (i: { code: string }) => i.code === 'owned-wrong-location'
        );
        expect(ownedIssue).toBeDefined();
        expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');
        expect(ownedIssue.ownerPath).toBe('Albums/Best Album/Best Album.md');
        // Exactly one location issue — no duplicate generic wrong-directory.
        expect(
          strayFile.issues.find((i: { code: string }) => i.code === 'wrong-directory')
        ).toBeUndefined();

        // --fix restores it under the owner subtree, not the type's Tracks dir.
        const fix = await runCLI(
          ['audit', '--fix', '--all', '--auto', '--execute'],
          tempVaultDir
        );
        expect(fix.exitCode).toBe(0);
        const restored = await readFile(
          join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
          'utf-8'
        ).catch(() => null);
        expect(restored).not.toBeNull();
        const stranded = await readFile(
          join(tempVaultDir, 'Tracks', 'Opening Track.md'),
          'utf-8'
        ).catch(() => null);
        expect(stranded).toBeNull();

        // Re-audit is clean.
        const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        expect(after.exitCode).toBe(0);
      }
    );

    // Defect 2 (wrong-TYPE note relocated by basename): declared ownership is
    // matched by basename, but the candidate must also have the owned field's
    // SOURCE type. A correctly-placed, differently-typed note that merely shares
    // a basename with the owner's declared owned reference must NOT be flagged
    // owned-wrong-location nor moved.
    it('does not flag a same-named note of a DIFFERENT type as owned-wrong-location', async () => {
      // Owner declares `songs: [[Opening Track]]` (expects a `track`). But the
      // note named "Opening Track" sitting correctly under Albums/ is itself an
      // `album` — a genuinely different type that just shares the basename.
      await writeFile(
        join(tempVaultDir, 'Albums', 'Opening Track.md'),
        `---\ntype: album\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);

      const sameNamed = output.files.find((f: { path: string }) =>
        f.path.includes('Albums/Opening Track.md')
      );
      // The album-typed note must NOT be flagged owned-wrong-location and must
      // therefore NOT be a move target. (Its own location under Albums/ is
      // correct for an album, so it has no location issue at all.)
      const ownedIssue = sameNamed?.issues?.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeUndefined();
    });

    it('still flags the genuine owned note (correct type) when a wrong-typed same-named note also exists', async () => {
      // A decoy album named "Opening Track" sits (correctly) in Albums/.
      await writeFile(
        join(tempVaultDir, 'Albums', 'Opening Track.md'),
        `---\ntype: album\n---\n`
      );
      // The REAL owned track (correct type) is misplaced in Tracks/.
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);

      // The track is flagged owned-wrong-location...
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Opening Track.md')
      );
      expect(track).toBeDefined();
      const trackOwnedIssue = track.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(trackOwnedIssue).toBeDefined();
      expect(trackOwnedIssue.expectedDirectory).toBe('Albums/Best Album/songs');

      // ...but the album decoy is NOT.
      const album = output.files.find((f: { path: string }) =>
        f.path.includes('Albums/Opening Track.md')
      );
      const albumOwnedIssue = album?.issues?.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(albumOwnedIssue).toBeUndefined();
    });

    // Fake-owner DECLARED-ownership guard (Codex review of #734): a note that
    // sits where an owner note would live (`Albums/Fake/Fake.md`) but whose
    // `type` does NOT resolve to the owner type (`album`) is a FAKE owner. Its
    // `owned`-field declarations must NOT populate `declaredOwned`, so a
    // same-named child-type note elsewhere is left to normal handling and is
    // NEVER flagged owned-wrong-location nor moved under the fake owner. This is
    // the declared-ownership analogue of the colocated/physical fake-owner guard
    // (#661).
    it('does not index declared ownership from a fake (wrong-type) owner note', async () => {
      // Fake owner: lives at an owner-looking path but `type: note`, not album.
      // It still declares `songs: [[Stray Song]]` in frontmatter.
      await mkdir(join(tempVaultDir, 'Albums/Fake'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Albums/Fake', 'Fake.md'),
        `---\ntype: note\nsongs:\n  - "[[Stray Song]]"\n---\n`
      );
      // A genuine `track` named "Stray Song" sits correctly in Tracks/. Since the
      // fake owner must NOT own it, it has no location issue at all (Tracks is its
      // correct output_dir) and must NOT be flagged owned-wrong-location.
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Stray Song.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);

      const song = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Stray Song.md')
      );
      const ownedIssue = song?.issues?.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeUndefined();
    });

    it('falls back to wrong-directory (not owned-wrong-location) for a child of a fake owner', async () => {
      // Same fake owner declaring `[[Stray Song]]`, but the same-named track is
      // genuinely misplaced (in Misc/, not Tracks/). Because the fake owner does
      // NOT contribute declared ownership, this is handled by the normal generic
      // wrong-directory path targeting `track`'s own output_dir (Tracks) — NOT
      // restored under the fake owner via owned-wrong-location.
      await mkdir(join(tempVaultDir, 'Albums/Fake'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Albums/Fake', 'Fake.md'),
        `---\ntype: note\nsongs:\n  - "[[Stray Song]]"\n---\n`
      );
      await mkdir(join(tempVaultDir, 'Misc'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Misc', 'Stray Song.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);

      const song = output.files.find((f: { path: string }) =>
        f.path.includes('Misc/Stray Song.md')
      );
      expect(song).toBeDefined();
      // Normal wrong-directory against the track's own output_dir...
      const wrongDirIssue = song.issues.find(
        (i: { code: string }) => i.code === 'wrong-directory'
      );
      expect(wrongDirIssue).toBeDefined();
      expect(wrongDirIssue.expected).toBe('Tracks');
      // ...and NOT restored under the fake owner.
      const ownedIssue = song.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeUndefined();
    });

    // Defect 1 (DATA LOSS): when the owned-note restore destination is already
    // occupied by a DIFFERENT file, --fix must SKIP the move, report it as a
    // conflict (not "fixed"), and leave BOTH files intact on disk.
    it('--fix skips the owned-note restore when the destination is already occupied (no data loss)', async () => {
      // The misplaced owned track lives in Tracks/...
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        `---\ntype: track\nbody_marker: STRAY\n---\n`
      );
      // ...but a DIFFERENT file already occupies the restore destination under
      // the owner subtree.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
        `---\ntype: track\nbody_marker: OCCUPANT\n---\n`
      );

      const result = await runCLI(
        ['audit', '--fix', '--all', '--auto', '--execute'],
        tempVaultDir
      );

      // Reported as a conflict, not a success.
      expect(result.stdout).toMatch(/Failed to move/i);
      expect(result.stdout).not.toMatch(/✓ Moved/);

      // BOTH files intact with their ORIGINAL contents — nothing overwritten.
      const stray = await readFile(
        join(tempVaultDir, 'Tracks', 'Opening Track.md'),
        'utf-8'
      );
      expect(stray).toContain('STRAY');
      const occupant = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
        'utf-8'
      );
      expect(occupant).toContain('OCCUPANT');
    });

    // #734 (path-qualified over-broadening): an earlier round normalized declared
    // owner wikilinks to BASENAME so a misplaced note could still be found. That
    // over-broadened matching: a PATH-QUALIFIED declaration whose target EXISTS at
    // that exact path would ALSO claim an UNRELATED same-basename note living
    // elsewhere, flagging it owned-wrong-location and trying to move it. The fix
    // resolves a path-qualified declaration to the file at that exact relative
    // path first (via the vault's existing link/path index), and only falls back
    // to basename matching when nothing exists there (genuinely misplaced).
    describe('path-aware declared-ownership resolution (#734)', () => {
      it('does NOT claim an unrelated same-basename sibling when the path-qualified target EXISTS at its path', async () => {
        // Owner declares ownership PATH-QUALIFIED to the song under its subtree.
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
          `---\ntype: album\nsongs:\n  - "[[Albums/Best Album/songs/Owned]]"\n---\n`
        );
        // The declared note actually EXISTS at that path (correctly placed).
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album/songs', 'Owned.md'),
          `---\ntype: track\nmarker: REAL\n---\n`
        );
        // An UNRELATED track of the SAME basename lives elsewhere, correctly under
        // its own output_dir (Tracks/). It is NOT the declared owned note.
        await writeFile(
          join(tempVaultDir, 'Tracks', 'Owned.md'),
          `---\ntype: track\nmarker: SIBLING\n---\n`
        );

        const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        const output = JSON.parse(result.stdout);

        // The unrelated sibling must NOT be flagged owned-wrong-location...
        const sibling = output.files.find((f: { path: string }) =>
          f.path.includes('Tracks/Owned.md')
        );
        const siblingOwnedIssue = sibling?.issues?.find(
          (i: { code: string }) => i.code === 'owned-wrong-location'
        );
        expect(siblingOwnedIssue).toBeUndefined();
        // ...nor any generic wrong-directory (Tracks IS its correct output_dir).
        const siblingWrongDir = sibling?.issues?.find(
          (i: { code: string }) => i.code === 'wrong-directory'
        );
        expect(siblingWrongDir).toBeUndefined();

        // The correctly-placed declared note has no location issue either.
        const real = output.files.find((f: { path: string }) =>
          f.path.includes('Albums/Best Album/songs/Owned.md')
        );
        const realOwnedIssue = real?.issues?.find(
          (i: { code: string }) =>
            i.code === 'owned-wrong-location' || i.code === 'wrong-directory'
        );
        expect(realOwnedIssue).toBeUndefined();
      });

      it('--fix --auto --execute leaves the unrelated sibling untouched (no move/collision)', async () => {
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
          `---\ntype: album\nsongs:\n  - "[[Albums/Best Album/songs/Owned]]"\n---\n`
        );
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album/songs', 'Owned.md'),
          `---\ntype: track\nmarker: REAL\n---\n`
        );
        await writeFile(
          join(tempVaultDir, 'Tracks', 'Owned.md'),
          `---\ntype: track\nmarker: SIBLING\n---\n`
        );

        await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);

        // The sibling stays put with its original content — never moved under the
        // owner (which would also have collided with the real owned note).
        const sibling = await readFile(
          join(tempVaultDir, 'Tracks', 'Owned.md'),
          'utf-8'
        ).catch(() => null);
        expect(sibling).not.toBeNull();
        expect(sibling).toContain('SIBLING');
        // The real owned note is untouched too.
        const real = await readFile(
          join(tempVaultDir, 'Albums/Best Album/songs', 'Owned.md'),
          'utf-8'
        );
        expect(real).toContain('REAL');
      });

      it('still restores a note declared PATH-QUALIFIED but genuinely MISSING at that path (basename fallback)', async () => {
        // Owner points at a path under its subtree, but NO file exists there...
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
          `---\ntype: album\nsongs:\n  - "[[Albums/Best Album/songs/Opening Track]]"\n---\n`
        );
        // ...the note actually lives (misplaced) in Tracks/.
        await writeFile(
          join(tempVaultDir, 'Tracks', 'Opening Track.md'),
          `---\ntype: track\n---\n`
        );

        const detect = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        expect(detect.exitCode).toBe(1);
        const output = JSON.parse(detect.stdout);
        const stray = output.files.find((f: { path: string }) =>
          f.path.includes('Tracks/Opening Track.md')
        );
        expect(stray).toBeDefined();
        const ownedIssue = stray.issues.find(
          (i: { code: string }) => i.code === 'owned-wrong-location'
        );
        expect(ownedIssue).toBeDefined();
        expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');

        // --fix restores it under the owner subtree.
        const fix = await runCLI(
          ['audit', '--fix', '--all', '--auto', '--execute'],
          tempVaultDir
        );
        expect(fix.exitCode).toBe(0);
        const restored = await readFile(
          join(tempVaultDir, 'Albums/Best Album/songs', 'Opening Track.md'),
          'utf-8'
        ).catch(() => null);
        expect(restored).not.toBeNull();
        const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        expect(after.exitCode).toBe(0);
      });

      it('still restores a misplaced note declared with a BARE link (basename match unchanged)', async () => {
        // Bare declaration + a single misplaced note → restored as before.
        await writeFile(
          join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
          `---\ntype: album\nsongs:\n  - "[[Opening Track]]"\n---\n`
        );
        await writeFile(
          join(tempVaultDir, 'Tracks', 'Opening Track.md'),
          `---\ntype: track\n---\n`
        );

        const detect = await runCLI(['audit', '--output', 'json'], tempVaultDir);
        expect(detect.exitCode).toBe(1);
        const output = JSON.parse(detect.stdout);
        const stray = output.files.find((f: { path: string }) =>
          f.path.includes('Tracks/Opening Track.md')
        );
        const ownedIssue = stray.issues.find(
          (i: { code: string }) => i.code === 'owned-wrong-location'
        );
        expect(ownedIssue).toBeDefined();
        expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');
      });
    });
  });

  // #734 multi-owner correctness/safety gaps.
  //
  // Defect A (data-safety): when TWO owners declare an owned note with the same
  // basename, the misplaced note must be surfaced as an AMBIGUOUS-OWNER conflict
  // (`owned-ambiguous-owner`, NOT auto-fixable) so `--fix --auto --execute` never
  // moves it under an arbitrarily-guessed owner.
  //
  // Defect B (missed detection): a note declared by owner A but physically placed
  // under a DIFFERENT valid owner B's owned subtree must still be flagged
  // `owned-wrong-location` targeting A (and `--fix` restores it under A).
  describe('multi-owner owned-note conflicts (#734)', () => {
    let tempVaultDir: string;

    // TWO album-like owner types both own `track`:
    //  - album   (Albums)  via `songs`
    //  - mixtape (Mixtapes) via `tracks`
    const MULTI_OWNER_SCHEMA = {
      version: 2,
      types: {
        album: {
          output_dir: 'Albums',
          fields: {
            type: { value: 'album' },
            songs: { prompt: 'relation', source: 'track', owned: true, multiple: true },
          },
          field_order: ['type', 'songs'],
        },
        mixtape: {
          output_dir: 'Mixtapes',
          fields: {
            type: { value: 'mixtape' },
            tracks: { prompt: 'relation', source: 'track', owned: true, multiple: true },
          },
          field_order: ['type', 'tracks'],
        },
        track: {
          output_dir: 'Tracks',
          fields: { type: { value: 'track' } },
          field_order: ['type'],
        },
        // An UNRELATED, non-owned type. A `note` named the same as an ambiguous
        // owned `track` declaration must NOT be dragged into the ownership
        // machinery (#734 follow-up).
        note: {
          output_dir: 'Notes',
          fields: { type: { value: 'note' } },
          field_order: ['type'],
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-multiowner-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(MULTI_OWNER_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Albums/Best Album/songs'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Mixtapes/Summer Mix/tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Notes'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    // ---- Defect A: ambiguous declared owners ----

    it('reports a basename declared by two owners as owned-ambiguous-owner (not owned-wrong-location)', async () => {
      // Both Best Album and Summer Mix declare ownership of "Shared Hit".
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Shared Hit]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Shared Hit]]"\n---\n`
      );
      // The note itself is misplaced in Tracks/.
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Shared Hit.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);

      const stray = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Shared Hit.md')
      );
      expect(stray).toBeDefined();

      // Ambiguous-owner conflict, NOT auto-fixable.
      const ambiguous = stray.issues.find(
        (i: { code: string }) => i.code === 'owned-ambiguous-owner'
      );
      expect(ambiguous).toBeDefined();
      expect(ambiguous.autoFixable).toBe(false);

      // NOT reported as an auto-fixable owned-wrong-location, and no duplicate
      // generic wrong-directory.
      expect(
        stray.issues.find((i: { code: string }) => i.code === 'owned-wrong-location')
      ).toBeUndefined();
      expect(
        stray.issues.find((i: { code: string }) => i.code === 'wrong-directory')
      ).toBeUndefined();
    });

    it('--fix --auto --execute does NOT move an ambiguous-owner note under a guessed owner', async () => {
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Shared Hit]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Shared Hit]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Shared Hit.md'),
        `---\ntype: track\nmarker: STRAY\n---\n`
      );

      await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);

      // Still in Tracks/, intact — not relocated under EITHER owner.
      const stillStray = await readFile(
        join(tempVaultDir, 'Tracks', 'Shared Hit.md'),
        'utf-8'
      ).catch(() => null);
      expect(stillStray).not.toBeNull();
      expect(stillStray).toContain('STRAY');

      const underAlbum = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Shared Hit.md'),
        'utf-8'
      ).catch(() => null);
      expect(underAlbum).toBeNull();
      const underMixtape = await readFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Shared Hit.md'),
        'utf-8'
      ).catch(() => null);
      expect(underMixtape).toBeNull();

      // The conflict persists on re-audit (it is never auto-resolved).
      const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(after.exitCode).toBe(1);
      const afterOut = JSON.parse(after.stdout);
      const stillNote = afterOut.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Shared Hit.md')
      );
      expect(
        stillNote.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeDefined();
    });

    it('keeps single-owner auto-restore working when another note name is also (singly) declared', async () => {
      // "Shared Hit" is ambiguous; "Solo Hit" is declared by ONE owner only and
      // must still auto-restore as before.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Shared Hit]]"\n  - "[[Solo Hit]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Shared Hit]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Solo Hit.md'),
        `---\ntype: track\n---\n`
      );
      // The ambiguous note physically exists too, so its conflict is emitted.
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Shared Hit.md'),
        `---\ntype: track\n---\n`
      );

      const detect = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(detect.stdout);
      const solo = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Solo Hit.md')
      );
      expect(solo).toBeDefined();
      const ownedIssue = solo.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');

      await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);
      // The single-owner note restores; the ambiguous one stays a conflict.
      const restored = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Solo Hit.md'),
        'utf-8'
      ).catch(() => null);
      expect(restored).not.toBeNull();
      // The ambiguous note was NOT moved under either owner.
      const stillShared = await readFile(
        join(tempVaultDir, 'Tracks', 'Shared Hit.md'),
        'utf-8'
      ).catch(() => null);
      expect(stillShared).not.toBeNull();
      // Ambiguous conflict still present afterwards.
      const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(after.exitCode).toBe(1);
    });

    // ---- #734 follow-up: child-type filter on the ambiguity determination ----

    it('does NOT flag a correctly-filed DIFFERENT-typed note sharing the basename of an ambiguous owned declaration', async () => {
      // Both owners declare ownership of "[[Shared]]" for their owned TRACK
      // fields, so "shared" is an ambiguous owned-track basename. But the actual
      // file Notes/Shared.md is a `type: note`, correctly placed under Notes/.
      // The ambiguity is about TRACKS, not notes — the note must NOT be flagged
      // (neither owned-ambiguous-owner nor owned-wrong-location) and must stay
      // put.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Notes', 'Shared.md'),
        `---\ntype: note\nmarker: KEEP\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Notes/Shared.md')
      );
      // Either the note has no issues at all (so it's not in the report), or it
      // is present but carries NONE of the ownership conflict codes.
      if (note) {
        expect(
          note.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
        ).toBeUndefined();
        expect(
          note.issues.find((i: { code: string }) => i.code === 'owned-wrong-location')
        ).toBeUndefined();
        expect(
          note.issues.find((i: { code: string }) => i.code === 'wrong-directory')
        ).toBeUndefined();
      }

      // --fix --auto --execute must leave the correctly-filed note untouched.
      await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);
      const stillThere = await readFile(
        join(tempVaultDir, 'Notes', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(stillThere).not.toBeNull();
      expect(stillThere).toContain('KEEP');
      // It was NOT pulled under either owner's owned subtree.
      const underAlbum = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(underAlbum).toBeNull();
      const underMixtape = await readFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(underMixtape).toBeNull();
    });

    it('STILL flags a genuinely misplaced TRACK named like an ambiguous declaration', async () => {
      // Same two ambiguous track declarations, but now the basename-sharing file
      // really IS a `track` (and misplaced in Tracks/). The genuine ambiguous
      // case must still fire and must NOT be auto-fixed.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Shared.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Shared.md')
      );
      expect(track).toBeDefined();
      const ambiguous = track.issues.find(
        (i: { code: string }) => i.code === 'owned-ambiguous-owner'
      );
      expect(ambiguous).toBeDefined();
      expect(ambiguous.autoFixable).toBe(false);
      expect(
        track.issues.find((i: { code: string }) => i.code === 'owned-wrong-location')
      ).toBeUndefined();
    });

    // ---- Defect B: declared owner ≠ physical owner ----

    it('flags a note declared by A but physically under owner B, targeting A', async () => {
      // Best Album declares ownership of "Crossover".
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Crossover]]"\n---\n`
      );
      // Summer Mix is a valid owner but does NOT declare "Crossover".
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\n---\n`
      );
      // The note physically sits under Summer Mix's owned subtree (valid owner
      // location), so discovery sets file.ownership = Summer Mix.
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Crossover.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);

      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Crossover.md')
      );
      expect(note).toBeDefined();
      const ownedIssue = note.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      // Restore target is the DECLARING owner A (Best Album), not physical B.
      expect(ownedIssue.expectedDirectory).toBe('Albums/Best Album/songs');
      expect(ownedIssue.ownerPath).toBe('Albums/Best Album/Best Album.md');
    });

    it('--fix restores a note from owner B back under its declaring owner A', async () => {
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Crossover]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Crossover.md'),
        `---\ntype: track\n---\n`
      );

      const fix = await runCLI(
        ['audit', '--fix', '--all', '--auto', '--execute'],
        tempVaultDir
      );
      expect(fix.exitCode).toBe(0);

      // Moved under A...
      const restored = await readFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Crossover.md'),
        'utf-8'
      ).catch(() => null);
      expect(restored).not.toBeNull();
      // ...and removed from B.
      const gone = await readFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Crossover.md'),
        'utf-8'
      ).catch(() => null);
      expect(gone).toBeNull();

      // Re-audit is clean.
      const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(after.exitCode).toBe(0);
    });

    it('does NOT flag a note physically under the SAME owner that declares it', async () => {
      // Declaring owner == physical owner: correct placement, no flag.
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Crossover]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album/songs', 'Crossover.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Crossover.md')
      );
      expect(note).toBeUndefined();
    });

    it('treats a note under B as an ambiguous conflict when BOTH A and B declare it', async () => {
      // Defect A composes with B: if the note physically under B is declared by
      // BOTH owners, it is the ambiguous conflict (not auto-restored to A).
      await writeFile(
        join(tempVaultDir, 'Albums/Best Album', 'Best Album.md'),
        `---\ntype: album\nsongs:\n  - "[[Crossover]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix', 'Summer Mix.md'),
        `---\ntype: mixtape\ntracks:\n  - "[[Crossover]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Mixtapes/Summer Mix/tracks', 'Crossover.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Crossover.md')
      );
      expect(note).toBeDefined();
      expect(
        note.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeDefined();
      expect(
        note.issues.find((i: { code: string }) => i.code === 'owned-wrong-location')
      ).toBeUndefined();
    });
  });

  // #734 (same-owner, multiple owned fields declaring the same basename): ONE
  // owner can have several `owned` fields, each declaring a DIFFERENT child type.
  // If that owner lists the same basename in two of those fields, the per-basename
  // declaration index must keep BOTH declarations (it previously deduped by owner
  // path alone, dropping the LATER field + its child type). The type-aware filter
  // must then resolve a misplaced note via the field whose child type matches it,
  // so a `note` named "Shared" is restored under the owner's `notes/` subfolder —
  // NOT moved to the `note` type's top-level output_dir, and the `track`-field
  // declaration must not shadow it.
  describe('same-owner multi-field owned declarations (#734)', () => {
    let tempVaultDir: string;

    // ONE owner type `project` with TWO owned fields of DIFFERENT child types:
    //  - tracks -> track
    //  - notes  -> note
    const MULTI_FIELD_SCHEMA = {
      version: 2,
      types: {
        project: {
          output_dir: 'Projects',
          fields: {
            type: { value: 'project' },
            tracks: { prompt: 'relation', source: 'track', owned: true, multiple: true },
            notes: { prompt: 'relation', source: 'note', owned: true, multiple: true },
          },
          field_order: ['type', 'tracks', 'notes'],
        },
        track: {
          output_dir: 'Tracks',
          fields: { type: { value: 'track' } },
          field_order: ['type'],
        },
        note: {
          output_dir: 'Notes',
          fields: { type: { value: 'note' } },
          field_order: ['type'],
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-multifield-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(MULTI_FIELD_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Projects/My Project/tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Projects/My Project/notes'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Notes'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('restores a misplaced NOTE under the owner notes/ subfolder when the same owner also declares the basename as a track', async () => {
      // The single owner declares "[[Shared]]" in BOTH its `tracks` (track) and
      // `notes` (note) owned fields. The actual file Shared.md is a `note`,
      // misplaced at the top of Notes/. The `track`-field declaration must NOT
      // shadow the `note`-field one: the note resolves via the `notes -> note`
      // declaration and restores under Projects/My Project/notes.
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ntracks:\n  - "[[Shared]]"\nnotes:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Notes', 'Shared.md'),
        `---\ntype: note\n---\nKEEP\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Notes/Shared.md')
      );
      expect(note).toBeDefined();

      // Reported as owned-wrong-location targeting the owner's NOTES subfolder,
      // not the note type's top-level output_dir, and NOT ambiguous (one owner).
      const ownedIssue = note.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      expect(ownedIssue.expectedDirectory).toBe('Projects/My Project/notes');
      expect(ownedIssue.ownerPath).toBe('Projects/My Project/My Project.md');
      expect(
        note.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeUndefined();

      // --fix moves it under the owner's notes/ subfolder...
      await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);
      const restored = await readFile(
        join(tempVaultDir, 'Projects/My Project/notes', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(restored).not.toBeNull();
      expect(restored).toContain('KEEP');
      // ...and NOT under the tracks/ subfolder, and not left at Notes/.
      const underTracks = await readFile(
        join(tempVaultDir, 'Projects/My Project/tracks', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(underTracks).toBeNull();
      const stillTop = await readFile(
        join(tempVaultDir, 'Notes', 'Shared.md'),
        'utf-8'
      ).catch(() => null);
      expect(stillTop).toBeNull();

      // After the move, the owned-wrong-location issue for this note is resolved:
      // re-auditing the (now correctly-placed) note carries no ownership issue.
      // (The owner's `tracks: [[Shared]]` declaration is now a stale reference to
      // a `note`, surfaced separately as `invalid-source-type` — not this note's
      // concern, and intentionally not part of this assertion.)
      const after = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const afterOut = JSON.parse(after.stdout);
      const movedNote = afterOut.files.find((f: { path: string }) =>
        f.path.includes('Projects/My Project/notes/Shared.md')
      );
      if (movedNote) {
        expect(
          movedNote.issues.find(
            (i: { code: string }) =>
              i.code === 'owned-wrong-location' ||
              i.code === 'owned-ambiguous-owner' ||
              i.code === 'wrong-directory'
          )
        ).toBeUndefined();
      }
    });

    it('symmetrically restores a misplaced TRACK via the tracks field when the same owner also declares the basename as a note', async () => {
      // The mirror of the above: the actual file is a `track`, so it must resolve
      // via the `tracks -> track` declaration even though the same owner ALSO
      // declares the basename as a note. (Guards against an off-by-order fix that
      // only worked when the note-field happened to be scanned second.)
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ntracks:\n  - "[[Shared]]"\nnotes:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Tracks', 'Shared.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Tracks/Shared.md')
      );
      expect(track).toBeDefined();
      const ownedIssue = track.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      expect(ownedIssue.expectedDirectory).toBe('Projects/My Project/tracks');
      expect(
        track.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeUndefined();
    });

    it('does NOT treat a single owner declaring the same basename in two fields as a multi-owner conflict', async () => {
      // Same setup, with the note physically present. Ambiguity is about TWO
      // DISTINCT owners; one owner across two fields is not ambiguous — the type
      // filter disambiguates, and the destination is the same owner.
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ntracks:\n  - "[[Shared]]"\nnotes:\n  - "[[Shared]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Notes', 'Shared.md'),
        `---\ntype: note\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const note = output.files.find((f: { path: string }) =>
        f.path.includes('Notes/Shared.md')
      );
      expect(note).toBeDefined();
      expect(
        note.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeUndefined();
    });
  });

  describe('same-owner wrong-field-subfolder owned note (#734 follow-up)', () => {
    let tempVaultDir: string;

    // ONE owner type `project` with TWO owned fields of the SAME child type:
    //  - tracks -> track
    //  - demos  -> track
    // A `track` declared in field A (demos) but physically sitting under the
    // SAME owner's field B (tracks) subfolder must be restored under demos/.
    const SAME_CHILD_SCHEMA = {
      version: 2,
      types: {
        project: {
          output_dir: 'Projects',
          fields: {
            type: { value: 'project' },
            tracks: { prompt: 'relation', source: 'track', owned: true, multiple: true },
            demos: { prompt: 'relation', source: 'track', owned: true, multiple: true },
          },
          field_order: ['type', 'tracks', 'demos'],
        },
        track: {
          output_dir: 'Tracks',
          fields: { type: { value: 'track' } },
          field_order: ['type'],
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-samefield-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(SAME_CHILD_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Projects/My Project/tracks'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Projects/My Project/demos'), { recursive: true });
      await mkdir(join(tempVaultDir, 'Tracks'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    it('flags owned-wrong-location targeting the DECLARING field subfolder when a track sits under the same owner WRONG field subfolder', async () => {
      // Owner declares the track ONLY in its `demos` field, but the file lives
      // under the same owner's `tracks/` subfolder. Owner matches; the field
      // subfolder does not. Must be flagged owned-wrong-location → demos/.
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ndemos:\n  - "[[My Track]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Projects/My Project/tracks', 'My Track.md'),
        `---\ntype: track\n---\nKEEP\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Projects/My Project/tracks/My Track.md')
      );
      expect(track).toBeDefined();

      const ownedIssue = track.issues.find(
        (i: { code: string }) => i.code === 'owned-wrong-location'
      );
      expect(ownedIssue).toBeDefined();
      // Targets the DECLARING field (demos), NOT the physical field (tracks),
      // and NOT the type's top-level output_dir (Tracks).
      expect(ownedIssue.expectedDirectory).toBe('Projects/My Project/demos');
      expect(ownedIssue.ownerPath).toBe('Projects/My Project/My Project.md');
      // Not ambiguous (single owner), and not a generic wrong-directory.
      expect(
        track.issues.find((i: { code: string }) => i.code === 'owned-ambiguous-owner')
      ).toBeUndefined();
      expect(
        track.issues.find((i: { code: string }) => i.code === 'wrong-directory')
      ).toBeUndefined();

      // --fix restores it under the declaring demos/ subfolder.
      await runCLI(['audit', '--fix', '--all', '--auto', '--execute'], tempVaultDir);
      const restored = await readFile(
        join(tempVaultDir, 'Projects/My Project/demos', 'My Track.md'),
        'utf-8'
      ).catch(() => null);
      expect(restored).not.toBeNull();
      expect(restored).toContain('KEEP');
      const stillUnderTracks = await readFile(
        join(tempVaultDir, 'Projects/My Project/tracks', 'My Track.md'),
        'utf-8'
      ).catch(() => null);
      expect(stillUnderTracks).toBeNull();
    });

    it('does NOT flag a track already in its declaring field subfolder', async () => {
      // Owner declares the track in `demos` and the file lives under demos/.
      // Correctly placed → no ownership/location flag.
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ndemos:\n  - "[[My Track]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Projects/My Project/demos', 'My Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      // A correctly-placed note carries no issues, so it may be absent from the
      // JSON output entirely; if present, it must carry no location issue.
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Projects/My Project/demos/My Track.md')
      );
      expect(
        track?.issues?.find(
          (i: { code: string }) =>
            i.code === 'owned-wrong-location' ||
            i.code === 'owned-ambiguous-owner' ||
            i.code === 'wrong-directory'
        )
      ).toBeUndefined();
    });

    it('honors a PATH-QUALIFIED declaration pointing at the note in ITS DECLARING field subfolder as correctly placed', async () => {
      // Owner declares the track in `demos` with a PATH-QUALIFIED link that
      // resolves to the track sitting under that SAME declaring field (demos/).
      // The actual dir equals the declaring field's expected subfolder, so the
      // note is correctly placed and must NOT be moved (the path-qualified form
      // must not falsely trigger a move against an explicit, satisfied
      // declaration).
      await writeFile(
        join(tempVaultDir, 'Projects/My Project', 'My Project.md'),
        `---\ntype: project\ndemos:\n  - "[[Projects/My Project/demos/My Track]]"\n---\n`
      );
      await writeFile(
        join(tempVaultDir, 'Projects/My Project/demos', 'My Track.md'),
        `---\ntype: track\n---\n`
      );

      const result = await runCLI(['audit', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const track = output.files.find((f: { path: string }) =>
        f.path.includes('Projects/My Project/demos/My Track.md')
      );
      expect(
        track?.issues?.find(
          (i: { code: string }) =>
            i.code === 'owned-wrong-location' ||
            i.code === 'owned-ambiguous-owner' ||
            i.code === 'wrong-directory'
        )
      ).toBeUndefined();
    });
  });

  describe('--execute flag validation', () => {
    it('should error when --execute is used without --fix', async () => {
      const result = await runCLI(['audit', '--execute'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute requires --fix --auto');
    });

    it('should error when --execute is used with --fix but without --auto', async () => {
      const result = await runCLI(['audit', '--fix', '--all', '--execute'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute requires --fix --auto');
    });

    it('should return JsonError when --execute is invalid in --output json mode', async () => {
      const result = await runCLI(['audit', '--execute', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--execute requires --fix --auto');

      const parsed = JSON.parse(result.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('--execute requires --fix --auto');
      expect(parsed.code).toBe(1);
    });
  });

  describe('--dry-run flag validation', () => {
    it('should error when --dry-run is used without --fix', async () => {
      const result = await runCLI(['audit', '--dry-run'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--dry-run requires --fix');
    });
  });

  describe('--fix targeting gate', () => {
    it('should error when --fix is used without targeting', async () => {
      const result = await runCLI(['audit', '--fix'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No files selected. Use --type, --path, --where, --body, or --all.');
      expect(result.stderr).toContain('bwrb audit is read-only');
      expect(result.stderr).toContain('writes by default');
      expect(result.stderr).toContain('bwrb audit --path "Ideas/**" --fix');
      expect(result.stderr).toContain('bwrb audit --all --fix');
      expect(result.stderr).toContain('--dry-run');
    });

    it('should allow --fix when --all is provided', async () => {
      const result = await runCLI(['audit', '--fix', '--all'], vaultDir);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('help and usage', () => {
    it('should document safety note and explicit --all --fix example', async () => {
      const result = await runCLI(['audit', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Safety:');
      expect(result.stdout).toContain('bwrb audit --all --fix');
    });
  });

  describe('wrong-directory auto-fix', () => {
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

      const result = await runCLI(['audit', '--fix', '--auto', '--dry-run', '--all'], tempVaultDir);


      // Should show what would be done
      expect(result.stdout).toContain('Would move to');
      expect(result.stdout).toContain('Ideas/');

      // Verify the file was NOT moved in dry-run mode
      const { access } = await import('fs/promises');
      await expect(access(join(tempVaultDir, 'Objectives', 'Wrong Idea.md'))).resolves.toBeUndefined();
      await expect(access(join(tempVaultDir, 'Ideas', 'Wrong Idea.md'))).rejects.toThrow();
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

    it('should move file with --fix --auto --execute', async () => {
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

      const result = await runCLI(['audit', '--fix', '--auto', '--execute', '--all'], tempVaultDir);

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

    it('should move to the non-doubled target when --vault is relative', async () => {
      const parentDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-rel-vault-'));
      const vaultName = 'collision';
      const relativeVaultDir = join(parentDir, vaultName);

      try {
        await mkdir(join(relativeVaultDir, '.bwrb'), { recursive: true });
        await writeFile(
          join(relativeVaultDir, '.bwrb', 'schema.json'),
          JSON.stringify(TEST_SCHEMA, null, 2)
        );
        await mkdir(join(relativeVaultDir, 'Ideas'), { recursive: true });
        await mkdir(join(relativeVaultDir, 'Objectives'), { recursive: true });
        await writeFile(
          join(relativeVaultDir, 'Objectives', 'Relative Move.md'),
          `---
type: idea
status: raw
priority: medium
---
relative vault body
`
        );

        const result = await runCLI(
          ['-v', vaultName, 'audit', '--fix', '--auto', '--execute', '--all'],
          undefined,
          undefined,
          { cwd: parentDir }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Moved to Ideas/');

        const moved = await readFile(
          join(relativeVaultDir, 'Ideas', 'Relative Move.md'),
          'utf-8'
        );
        expect(moved).toContain('relative vault body');

        await expect(
          readFile(join(relativeVaultDir, vaultName, 'Ideas', 'Relative Move.md'), 'utf-8')
        ).rejects.toThrow();
        await expect(
          readFile(join(relativeVaultDir, 'Objectives', 'Relative Move.md'), 'utf-8')
        ).rejects.toThrow();
      } finally {
        await rm(parentDir, { recursive: true, force: true });
      }
    });

    // Defect 1 (DATA LOSS) on the GENERIC wrong-directory path: the same move
    // primitive guard must protect a plain misplaced note whose destination is
    // already occupied. --fix must SKIP it, report a conflict, and overwrite
    // nothing.
    it('should NOT overwrite an occupied destination on the generic wrong-directory fix', async () => {
      // Misplaced idea in Objectives/...
      await writeFile(
        join(tempVaultDir, 'Objectives', 'Clashing Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
STRAY CONTENT
`
      );
      // ...but a DIFFERENT file already sits at the correct Ideas/ destination.
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Clashing Idea.md'),
        `---
type: idea
status: raw
priority: medium
---
OCCUPANT CONTENT
`
      );

      const result = await runCLI(['audit', '--fix', '--auto', '--execute', '--all'], tempVaultDir);

      // Reported as a conflict, not a success.
      expect(result.stdout).toMatch(/Failed to move/i);

      const { readFile: rf } = await import('fs/promises');
      // BOTH files intact with original contents.
      const stray = await rf(join(tempVaultDir, 'Objectives', 'Clashing Idea.md'), 'utf-8');
      expect(stray).toContain('STRAY CONTENT');
      const occupant = await rf(join(tempVaultDir, 'Ideas', 'Clashing Idea.md'), 'utf-8');
      expect(occupant).toContain('OCCUPANT CONTENT');
    });


    it('should update wikilinks when moving file with --execute', async () => {
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

      const result = await runCLI(['audit', '--fix', '--auto', '--execute', '--all'], tempVaultDir);

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
      expect(typeIssue.meta?.recommendation?.action).toBe('delete-note');
      expect(typeIssue.meta?.recommendation?.interactiveOnly).toBe(true);
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

  // NOTE: trailing-whitespace detection uses raw frontmatter lines (not YAML parsing).
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
      expect(wsIssue.meta.before).toBe('status: raw  ');
      expect(wsIssue.meta.after).toBe('status: raw');
      expect(wsIssue.meta.line).toBe(3);
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
      expect(wsIssue.meta.line).toBe(3);
      expect(wsIssue.meta.before).toBe(' status: "raw"  ');
      expect(wsIssue.meta.after).toBe(' status: "raw"');
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

    it('should preserve CRLF while auto-fixing trailing whitespace', async () => {
      const filePath = join(tempVaultDir, 'Ideas', 'Fix Whitespace CRLF.md');
      await writeFile(
        filePath,
        `---\r\n` +
        `type: idea\r\n` +
        `status: raw  \r\n` +
        `priority: medium\r\n` +
        `---\r\n`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.exitCode).toBe(0);

      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('status: raw\r\n');
      expect(content).not.toContain('status: raw  ');
      expect(content).toContain('\r\n');
      expect(content).not.toContain('status: raw\n');
    });

    it('should not write without --execute', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'No Execute.md'),
        `---
type: idea
status: raw  
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would fix');
      expect(result.stdout).toContain('Would skip');
      expect(result.stdout).toContain('Re-run with');

      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'No Execute.md'), 'utf-8');
      expect(content).toContain('status: raw  ');
    });

  });

  describe('scalar coercion detection and fix', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-coercion-'));
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

    it('should detect string values in boolean and number fields', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'String Scalars.md'),
        `---
type: idea
status: raw
priority: medium
archived: "true"
effort: "3"
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('String Scalars.md'));
      expect(file).toBeDefined();
      const boolIssue = file.issues.find((i: { code: string; field?: string }) => i.code === 'wrong-scalar-type' && i.field === 'archived');
      const numberIssue = file.issues.find((i: { code: string; field?: string }) => i.code === 'wrong-scalar-type' && i.field === 'effort');
      expect(boolIssue).toBeDefined();
      expect(numberIssue).toBeDefined();
      expect(boolIssue.autoFixable).toBe(true);
      expect(numberIssue.autoFixable).toBe(true);
    });

    it('should detect scalar-to-list mismatch for multi-select fields', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Scalar Labels.md'),
        `---
type: idea
status: raw
labels: urgent
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Scalar Labels.md'));
      expect(file).toBeDefined();
      const listIssue = file.issues.find((i: { code: string; field?: string }) => i.code === 'wrong-scalar-type' && i.field === 'labels');
      expect(listIssue).toBeDefined();
      expect(listIssue.expected).toBe('list');
      expect(listIssue.autoFixable).toBe(true);
    });

    it('should detect list-to-scalar mismatch for scalar fields', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'List Priority.md'),
        `---
type: idea
status: raw
priority:
  - high
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('List Priority.md'));
      expect(file).toBeDefined();
      const listIssue = file.issues.find((i: { code: string; field?: string }) => i.code === 'wrong-scalar-type' && i.field === 'priority');
      expect(listIssue).toBeDefined();
      expect(listIssue.expected).toBe('string');
      expect(listIssue.autoFixable).toBe(true);
    });

    it('should not flag non-boolean string values', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Non Boolean.md'),
        `---
 type: idea
 status: raw
 priority: medium
 archived: "yes"
 ---
 `
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Non Boolean.md'));
      expect(file).toBeDefined();
      const boolIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-boolean-coercion');
      expect(boolIssue).toBeUndefined();
    });

    it('should flag invalid date formats for date prompts', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Bad Date.md'),
        `---
type: task
status: backlog
deadline: 01/02/2026
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);

      const file = output.files.find((f: { path: string }) => f.path.includes('Bad Date.md'));
      expect(file).toBeDefined();
      const dateIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-date-format');
      expect(dateIssue).toBeDefined();
      expect(dateIssue.suggestion).toBeUndefined();
    });

    it('should suggest unambiguous date normalization', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Isoish Date.md'),
        `---
type: task
status: backlog
deadline: 2026/1/2
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Isoish Date.md'));
      expect(file).toBeDefined();
      const dateIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-date-format');
      expect(dateIssue).toBeDefined();
      expect(dateIssue.suggestion).toBe('Suggested: 2026-01-02');
      expect(dateIssue.autoFixable).toBe(true);
      expect(dateIssue.meta).toMatchObject({ normalized: '2026-01-02' });
    });

    it('should not flag an empty optional date as invalid-date-format (#614)', async () => {
      // Repro for #614: the write path accepts an empty-string optional date and
      // stores `deadline: ""`. Audit must agree and treat it as "unset" rather
      // than reporting an invalid date format.
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Empty Deadline.md'),
        `---
type: task
status: backlog
deadline: ""
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Empty Deadline.md'));

      if (file) {
        const dateIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-date-format');
        expect(dateIssue).toBeUndefined();
      }
    });

    it('should not flag a blank (whitespace) optional date as invalid-date-format', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Blank Deadline.md'),
        `---
type: task
status: backlog
deadline: "   "
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Blank Deadline.md'));

      if (file) {
        const dateIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-date-format');
        expect(dateIssue).toBeUndefined();
      }
    });

    it('should still flag a non-empty malformed optional date', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Garbage Deadline.md'),
        `---
type: task
status: backlog
deadline: "not-a-date"
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Garbage Deadline.md'));
      expect(file).toBeDefined();
      const dateIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-date-format');
      expect(dateIssue).toBeDefined();
    });

    it('should report an empty required date once as empty-string-required, not invalid-date-format', async () => {
      // A required empty date should follow the same "missing required" path as
      // any other required field — exactly one issue, and not a bogus format
      // error.
      const schema = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          dated: {
            output_dir: 'Dated',
            fields: {
              type: { value: 'dated' },
              when: { prompt: 'date', required: true },
            },
            field_order: ['type', 'when'],
          },
        },
      };
      await writeFile(join(tempVaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));
      await mkdir(join(tempVaultDir, 'Dated'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Dated', 'No When.md'),
        `---
type: dated
when: ""
---
`
      );

      const result = await runCLI(['audit', 'dated', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('No When.md'));
      expect(file).toBeDefined();
      const emptyRequired = file.issues.filter((i: { code: string }) => i.code === 'empty-string-required');
      const dateIssues = file.issues.filter((i: { code: string }) => i.code === 'invalid-date-format');
      expect(emptyRequired).toHaveLength(1);
      expect(dateIssues).toHaveLength(0);
    });

    it('should not flag an empty optional number as wrong-scalar-type (#664)', async () => {
      // Repro for #664: the write path accepts an empty-string optional number and
      // stores `effort: ""`. Audit must agree and treat it as "unset" rather than
      // reporting a wrong-scalar-type error. Mirrors the #614 rule for dates.
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Empty Effort.md'),
        `---
type: idea
status: raw
effort: ""
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Empty Effort.md'));

      if (file) {
        const numberIssue = file.issues.find(
          (i: { code: string; field?: string }) =>
            i.code === 'wrong-scalar-type' && i.field === 'effort'
        );
        expect(numberIssue).toBeUndefined();
      }
    });

    it('should not flag a blank (whitespace) optional number as wrong-scalar-type (#707)', async () => {
      // #707 unifies whitespace handling to trim-everywhere: a whitespace-only
      // value like "   " is "unset" the same as "" across ALL scalar types, on
      // both write and audit. validateFrontmatter now treats blank optional
      // values as unset via the shared `isBlankScalar` helper, so audit must
      // agree and NOT flag a blank optional number. Mirrors the optional-date
      // behaviour (see the blank-date test above), so dates and numbers handle
      // whitespace-only values identically.
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Blank Effort.md'),
        `---
type: idea
status: raw
effort: "   "
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Blank Effort.md'));

      if (file) {
        const numberIssue = file.issues.find(
          (i: { code: string; field?: string }) =>
            i.code === 'wrong-scalar-type' && i.field === 'effort'
        );
        expect(numberIssue).toBeUndefined();
      }
    });

    it('should not flag an empty or blank optional boolean as wrong-scalar-type (#707)', async () => {
      // Booleans must follow the same unified trim-everywhere rule as dates and
      // numbers (#707): both an empty string and a whitespace-only string are
      // "unset" and skipped on write and audit alike.
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Empty Archived.md'),
        `---
type: idea
status: raw
archived: ""
---
`
      );
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Blank Archived.md'),
        `---
type: idea
status: raw
archived: "   "
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);

      for (const name of ['Empty Archived.md', 'Blank Archived.md']) {
        const file = output.files.find((f: { path: string }) => f.path.includes(name));
        if (file) {
          const boolIssue = file.issues.find(
            (i: { code: string; field?: string }) =>
              i.code === 'wrong-scalar-type' && i.field === 'archived'
          );
          expect(boolIssue).toBeUndefined();
        }
      }
    });

    it('should still flag a non-numeric optional number value', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Garbage Effort.md'),
        `---
type: idea
status: raw
effort: "abc"
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Garbage Effort.md'));
      expect(file).toBeDefined();
      const numberIssue = file.issues.find(
        (i: { code: string; field?: string }) =>
          i.code === 'wrong-scalar-type' && i.field === 'effort'
      );
      expect(numberIssue).toBeDefined();
      expect(numberIssue.expected).toBe('number');
    });

    it('should report an empty required number once as empty-string-required, not wrong-scalar-type', async () => {
      // A required empty number should follow the same "missing required" path as
      // any other required field — exactly one issue, and not a bogus scalar-type
      // error. Mirrors the #614 required-date behaviour.
      const schema = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          counted: {
            output_dir: 'Counted',
            fields: {
              type: { value: 'counted' },
              count: { prompt: 'number', required: true },
            },
            field_order: ['type', 'count'],
          },
        },
      };
      await writeFile(join(tempVaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));
      await mkdir(join(tempVaultDir, 'Counted'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Counted', 'No Count.md'),
        `---
type: counted
count: ""
---
`
      );

      const result = await runCLI(['audit', 'counted', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('No Count.md'));
      expect(file).toBeDefined();
      const emptyRequired = file.issues.filter((i: { code: string }) => i.code === 'empty-string-required');
      const scalarIssues = file.issues.filter((i: { code: string }) => i.code === 'wrong-scalar-type');
      expect(emptyRequired).toHaveLength(1);
      expect(scalarIssues).toHaveLength(0);
    });

    it('should not flag a valid optional number (#664 regression)', async () => {
      // A genuine numeric value must remain clean — the #664 blank-skip guard
      // only narrows the empty-string case and must not suppress real numbers.
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Valid Effort.md'),
        `---
type: idea
status: raw
effort: 3
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Valid Effort.md'));

      if (file) {
        const numberIssue = file.issues.find(
          (i: { code: string; field?: string }) =>
            i.code === 'wrong-scalar-type' && i.field === 'effort'
        );
        expect(numberIssue).toBeUndefined();
      }
    });

    it('should report an empty element in a date list once (as invalid-list-element, not invalid-date-format)', async () => {
      // Coordinates with #640/#641: empty list elements are surfaced by the list
      // integrity checker. The per-element date check must skip them so they are
      // not double-reported as invalid-date-format.
      const schema = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          dated: {
            output_dir: 'Dated',
            fields: {
              type: { value: 'dated' },
              dates: { prompt: 'date', multiple: true },
            },
            field_order: ['type', 'dates'],
          },
        },
      };
      await writeFile(join(tempVaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));
      await mkdir(join(tempVaultDir, 'Dated'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Dated', 'Date List.md'),
        `---
type: dated
dates:
  - "2026-01-01"
  - ""
  - "2026-02-01"
---
`
      );

      const result = await runCLI(['audit', 'dated', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Date List.md'));
      expect(file).toBeDefined();
      const dateIssues = file.issues.filter((i: { code: string }) => i.code === 'invalid-date-format');
      expect(dateIssues).toHaveLength(0);
      const listIssues = file.issues.filter((i: { code: string }) => i.code === 'invalid-list-element');
      expect(listIssues).toHaveLength(1);
      expect(listIssues[0].listIndex).toBe(1);
    });

    it('should detect empty required values as empty-string-required', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Empty Status.md'),
        `---
type: idea
status: " "
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Empty Status.md'));
      expect(file).toBeDefined();
      const emptyIssue = file.issues.find((i: { code: string }) => i.code === 'empty-string-required');
      expect(emptyIssue).toBeDefined();
      expect(emptyIssue.autoFixable).toBe(true);
    });

    it('should annotate invalid list elements with metadata', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      await writeFile(
        join(tempVaultDir, 'Objectives/Tasks', 'Bad Tags.md'),
        `---
type: task
status: backlog
tags:
  - good
  - 42
---
`
      );

      const result = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Bad Tags.md'));
      expect(file).toBeDefined();
      const listIssue = file.issues.find((i: { code: string }) => i.code === 'invalid-list-element');
      expect(listIssue).toBeDefined();
      expect(listIssue.meta).toMatchObject({ reason: 'wrong-type', action: 'coerce' });
      expect(listIssue.autoFixable).toBe(true);
    });

    it('should auto-fix string scalars in --auto mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Scalars.md'),
        `---
type: idea
status: raw
priority: medium
archived: "true"
effort: "3"
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Coerced archived to boolean');
      expect(result.stdout).toContain('Coerced effort to number');

      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Scalars.md'), 'utf-8');
      expect(content).toContain('archived: true');
      expect(content).toContain('effort: 3');
      expect(content).not.toContain('archived: "true"');
      expect(content).not.toContain('effort: "3"');
    });

    it('coerces a numeric list element to a quoted string that survives re-audit (#700)', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      const taskPath = join(tempVaultDir, 'Objectives/Tasks', 'Numeric Tag.md');
      await writeFile(
        taskPath,
        `---
type: task
status: backlog
tags:
  - alpha
  - 42
  - beta
---
`
      );

      // First pass: coerce the numeric element.
      const fix = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(fix.stdout).toContain('Fixed tags[1] (coerce)');

      const { readFile } = await import('fs/promises');
      const content = await readFile(taskPath, 'utf-8');
      // The coerced value must serialize as a QUOTED string so it round-trips as
      // a string, not as bare `42` (which would re-flag forever — the #700 trap).
      expect(content).toContain('- "42"');
      expect(content).not.toMatch(/^\s*-\s*42\s*$/m);

      // Second pass: a re-audit must find the element clean — no re-flag. The fix
      // converges in ONE pass (idempotent).
      const reaudit = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(reaudit.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Numeric Tag.md'));
      const listIssues = file
        ? file.issues.filter((i: { code: string }) => i.code === 'invalid-list-element')
        : [];
      expect(listIssues).toHaveLength(0);

      // Re-running the fix must be a no-op (nothing left to coerce).
      const fixAgain = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(fixAgain.stdout).not.toContain('coerce');
      const contentAfter = await readFile(taskPath, 'utf-8');
      expect(contentAfter).toBe(content);
    });

    it('coerces multiple numeric list elements idempotently in one pass (#700)', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      const taskPath = join(tempVaultDir, 'Objectives/Tasks', 'Multi Numeric.md');
      await writeFile(
        taskPath,
        `---
type: task
status: backlog
tags:
  - 1
  - alpha
  - 2
  - 3
---
`
      );

      const fix = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(fix.stdout).toContain('Fixed tags[0] (coerce)');
      expect(fix.stdout).toContain('Fixed tags[2] (coerce)');
      expect(fix.stdout).toContain('Fixed tags[3] (coerce)');

      const { readFile } = await import('fs/promises');
      const content = await readFile(taskPath, 'utf-8');
      // Every numeric element is now a quoted string; the distinct 'alpha' is kept.
      expect(content).toContain('- "1"');
      expect(content).toContain('- alpha');
      expect(content).toContain('- "2"');
      expect(content).toContain('- "3"');

      const reaudit = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(reaudit.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Multi Numeric.md'));
      const listIssues = file
        ? file.issues.filter((i: { code: string }) => i.code === 'invalid-list-element')
        : [];
      expect(listIssues).toHaveLength(0);
    });

    it('coerces a boolean list element to a quoted string that survives re-audit (#700)', async () => {
      await mkdir(join(tempVaultDir, 'Objectives/Tasks'), { recursive: true });
      const taskPath = join(tempVaultDir, 'Objectives/Tasks', 'Bool Tag.md');
      await writeFile(
        taskPath,
        `---
type: task
status: backlog
tags:
  - alpha
  - true
---
`
      );

      const fix = await runCLI(['audit', 'task', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(fix.stdout).toContain('Fixed tags[1] (coerce)');

      const { readFile } = await import('fs/promises');
      const content = await readFile(taskPath, 'utf-8');
      expect(content).toContain('- "true"');

      const reaudit = await runCLI(['audit', 'task', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(reaudit.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Bool Tag.md'));
      const listIssues = file
        ? file.issues.filter((i: { code: string }) => i.code === 'invalid-list-element')
        : [];
      expect(listIssues).toHaveLength(0);
    });
  });

  describe('partial date granularity', () => {
    let tempVaultDir: string;

    const GRANULAR_SCHEMA = {
      version: 2,
      config: { date_granularity: 'day' as const },
      types: {
        person: {
          output_dir: 'People',
          fields: {
            type: { value: 'person' },
            'last-contact': { prompt: 'date' as const, granularity: 'month' as const },
            'first-met': { prompt: 'date' as const, granularity: 'year' as const },
            deadline: { prompt: 'date' as const },
          },
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-granularity-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(GRANULAR_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'People'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    async function auditPerson(filename: string, body: string) {
      await writeFile(join(tempVaultDir, 'People', filename), body);
      const result = await runCLI(['audit', 'person', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      // Files with no issues may be omitted from the report entirely.
      const file = output.files.find((f: { path: string }) => f.path.includes(filename));
      const issues: { code: string; field?: string }[] = file?.issues ?? [];
      return issues.filter((i) => i.code === 'invalid-date-format');
    }

    it('accepts YYYY-MM in a month-granularity field', async () => {
      const issues = await auditPerson(
        'Ada.md',
        `---\ntype: person\nlast-contact: 2026-05\n---\n`
      );
      expect(issues).toHaveLength(0);
    });

    it('accepts a bare year in a year-granularity field', async () => {
      const issues = await auditPerson(
        'Grace.md',
        `---\ntype: person\nfirst-met: "2021"\n---\n`
      );
      expect(issues).toHaveLength(0);
    });

    it('flags a YYYY-MM value in a strict (default) date field', async () => {
      const issues = await auditPerson(
        'Linus.md',
        `---\ntype: person\ndeadline: 2026-05\n---\n`
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].field).toBe('deadline');
    });

    it('flags a bare year in a month-granularity field (too coarse)', async () => {
      const issues = await auditPerson(
        'Edsger.md',
        `---\ntype: person\nlast-contact: "2026"\n---\n`
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].field).toBe('last-contact');
    });

    it('still flags malformed dates in a relaxed field', async () => {
      const issues = await auditPerson(
        'Donald.md',
        `---\ntype: person\nfirst-met: 2026-13\n---\n`
      );
      expect(issues).toHaveLength(1);
    });

    it('flags calendar-invalid full dates (consistent with partials)', async () => {
      const badMonth = await auditPerson(
        'Bjarne.md',
        `---\ntype: person\ndeadline: 2026-13-01\n---\n`
      );
      expect(badMonth).toHaveLength(1);

      const badLeap = await auditPerson(
        'Ken.md',
        `---\ntype: person\ndeadline: 2025-02-29\n---\n`
      );
      expect(badLeap).toHaveLength(1);
    });

    it('treats a YAML-numeric bare year as a date, not a generic scalar', async () => {
      // first-met has year granularity: a numeric 2021 is a valid year, so the
      // only issue is that it should be quoted as a string (not invalid-date-format).
      await writeFile(
        join(tempVaultDir, 'People', 'Rob.md'),
        `---\ntype: person\nfirst-met: 2021\n---\n`
      );
      const result = await runCLI(['audit', 'person', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Rob.md'));
      const codes: string[] = (file?.issues ?? []).map((i: { code: string }) => i.code);
      expect(codes).toContain('wrong-scalar-type');
      expect(codes).not.toContain('invalid-date-format');

      // last-contact has month granularity: numeric 2026 is too coarse → date error,
      // not a generic "should be a string" scalar error.
      await writeFile(
        join(tempVaultDir, 'People', 'James.md'),
        `---\ntype: person\nlast-contact: 2026\n---\n`
      );
      const result2 = await runCLI(['audit', 'person', '--output', 'json'], tempVaultDir);
      const output2 = JSON.parse(result2.stdout);
      const file2 = output2.files.find((f: { path: string }) => f.path.includes('James.md'));
      const issues2: { code: string; field?: string }[] = file2?.issues ?? [];
      const lastContact = issues2.filter((i) => i.field === 'last-contact');
      expect(lastContact).toHaveLength(1);
      expect(lastContact[0].code).toBe('invalid-date-format');
    });
  });

  describe('list/multiple date fields (#593)', () => {
    let tempVaultDir: string;

    // A "list of dates" is modeled as a `date` prompt with `multiple: true`.
    const LIST_DATE_SCHEMA = {
      version: 2,
      config: { date_granularity: 'day' as const },
      types: {
        log: {
          output_dir: 'Logs',
          fields: {
            type: { value: 'log' },
            dates: { prompt: 'date' as const, multiple: true },
            months: { prompt: 'date' as const, multiple: true, granularity: 'month' as const },
          },
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-list-date-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(LIST_DATE_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Logs'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    async function auditDateIssues(filename: string, body: string, field = 'dates') {
      await writeFile(join(tempVaultDir, 'Logs', filename), body);
      const result = await runCLI(['audit', 'log', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes(filename));
      const issues: { code: string; field?: string; listIndex?: number; value?: unknown }[] =
        file?.issues ?? [];
      return issues.filter((i) => i.code === 'invalid-date-format' && i.field === field);
    }

    it('flags an invalid element inside a list of dates (the #593 repro)', async () => {
      const issues = await auditDateIssues(
        'Repro.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - "2026/5/2"\n  - not-a-date\n---\n`
      );
      // Both malformed elements flagged; the valid first element is not.
      expect(issues).toHaveLength(2);
      const indexes = issues.map((i) => i.listIndex).sort();
      expect(indexes).toEqual([1, 2]);
      // The offending value is surfaced per element.
      const byIndex = new Map(issues.map((i) => [i.listIndex, i.value]));
      expect(byIndex.get(1)).toBe('2026/5/2');
      expect(byIndex.get(2)).toBe('not-a-date');
    });

    it('reports a clean list of all-valid dates with no date issues', async () => {
      const issues = await auditDateIssues(
        'Clean.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - "2026-05-20"\n---\n`
      );
      expect(issues).toHaveLength(0);
    });

    it('treats an empty list as clean', async () => {
      const issues = await auditDateIssues(
        'Empty.md',
        `---\ntype: log\ndates: []\n---\n`
      );
      expect(issues).toHaveLength(0);
    });

    it('flags only the invalid element in a mixed list', async () => {
      const issues = await auditDateIssues(
        'Mixed.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - bogus\n  - "2026-12-31"\n---\n`
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].listIndex).toBe(1);
      expect(issues[0].value).toBe('bogus');
    });

    it('respects per-element granularity for a month-granularity list', async () => {
      // YYYY-MM is acceptable at month granularity; a bare year is too coarse.
      const issues = await auditDateIssues(
        'Months.md',
        `---\ntype: log\nmonths:\n  - "2026-05"\n  - "2026"\n---\n`,
        'months'
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].listIndex).toBe(1);
      expect(issues[0].value).toBe('2026');
    });

    // #641: a numeric or empty-string element of a multiple date field must be
    // reported exactly once, consistent with scalar dates and the create/edit
    // path. The date check owns numeric elements (a number in a date field is a
    // date candidate, not a structural wrong-type); checkListElementIntegrity
    // owns null/empty/nested/non-numeric-wrong-type. The two must not both fire
    // for the same element.
    async function auditAllIssues(filename: string, body: string, field = 'dates') {
      await writeFile(join(tempVaultDir, 'Logs', filename), body);
      const result = await runCLI(['audit', 'log', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes(filename));
      const issues: { code: string; field?: string; listIndex?: number; value?: unknown }[] =
        file?.issues ?? [];
      return issues.filter((i) => i.field === field || i.field === undefined);
    }

    it('reports an invalid numeric date-list element once as invalid-date-format (#641)', async () => {
      // At day granularity, numeric 2026 and 5 are not valid dates. Each must be
      // reported once as invalid-date-format and NOT also as invalid-list-element.
      const issues = await auditAllIssues(
        'NumericInvalid.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - 2026\n  - 5\n---\n`
      );
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      const listIssues = issues.filter((i) => i.code === 'invalid-list-element');
      expect(dateIssues.map((i) => i.listIndex).sort()).toEqual([1, 2]);
      expect(listIssues).toHaveLength(0);
    });

    it('reports a valid numeric date-list element once as wrong-scalar-type (#641)', async () => {
      // At year granularity a numeric 2026 IS a valid date; it should be quoted as
      // a string. Reported once as wrong-scalar-type (matching scalar dates), not
      // as invalid-list-element and not as invalid-date-format.
      const yearSchema = {
        version: 2,
        types: {
          log: {
            output_dir: 'Logs',
            fields: {
              type: { value: 'log' },
              years: { prompt: 'date' as const, multiple: true, granularity: 'year' as const },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(yearSchema, null, 2)
      );
      await writeFile(
        join(tempVaultDir, 'Logs', 'NumericValid.md'),
        `---\ntype: log\nyears:\n  - 2026\n---\n`
      );
      const result = await runCLI(['audit', 'log', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('NumericValid.md'));
      const issues: { code: string; listIndex?: number; value?: unknown }[] = file?.issues ?? [];
      const wrongScalar = issues.filter((i) => i.code === 'wrong-scalar-type');
      const listIssues = issues.filter((i) => i.code === 'invalid-list-element');
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      expect(wrongScalar).toHaveLength(1);
      expect(wrongScalar[0].listIndex).toBe(0);
      expect(wrongScalar[0].value).toBe(2026);
      expect(listIssues).toHaveLength(0);
      expect(dateIssues).toHaveLength(0);
    });

    it('reports an empty-string date-list element once as invalid-list-element (#641)', async () => {
      const issues = await auditAllIssues(
        'EmptyElement.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - ""\n  - "2026-02-01"\n---\n`
      );
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      const listIssues = issues.filter((i) => i.code === 'invalid-list-element');
      expect(dateIssues).toHaveLength(0);
      expect(listIssues).toHaveLength(1);
      expect(listIssues[0].listIndex).toBe(1);
    });

    it('reports an invalid date-string element once as invalid-date-format (#641)', async () => {
      const issues = await auditAllIssues(
        'InvalidString.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - not-a-date\n---\n`
      );
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      const listIssues = issues.filter((i) => i.code === 'invalid-list-element');
      expect(dateIssues).toHaveLength(1);
      expect(dateIssues[0].listIndex).toBe(1);
      expect(listIssues).toHaveLength(0);
    });

    it('reports no issues for an all-valid string date list (#641)', async () => {
      const issues = await auditAllIssues(
        'AllValid.md',
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - "2026-02-01"\n---\n`
      );
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      const listIssues = issues.filter((i) => i.code === 'invalid-list-element');
      const wrongScalar = issues.filter((i) => i.code === 'wrong-scalar-type');
      expect(dateIssues).toHaveLength(0);
      expect(listIssues).toHaveLength(0);
      expect(wrongScalar).toHaveLength(0);
    });

    it('does not regress scalar (single-value) date validation', async () => {
      // Scalar date assigned to a multiple field still gets validated and the
      // existing scalar code path is unaffected.
      const scalarSchema = {
        version: 2,
        types: {
          log: {
            output_dir: 'Logs',
            fields: {
              type: { value: 'log' },
              deadline: { prompt: 'date' as const },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(scalarSchema, null, 2)
      );
      await writeFile(
        join(tempVaultDir, 'Logs', 'Scalar.md'),
        `---\ntype: log\ndeadline: not-a-date\n---\n`
      );
      const result = await runCLI(['audit', 'log', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Scalar.md'));
      const issues: { code: string; field?: string; listIndex?: number }[] = file?.issues ?? [];
      const dateIssues = issues.filter((i) => i.code === 'invalid-date-format');
      expect(dateIssues).toHaveLength(1);
      expect(dateIssues[0].field).toBe('deadline');
      // A scalar date error carries no listIndex.
      expect(dateIssues[0].listIndex).toBeUndefined();
    });
  });

  describe('per-element numeric date-list auto-fix (#673)', () => {
    let tempVaultDir: string;

    // A list of years modeled as a `date` prompt with `multiple: true` at year
    // granularity: a bare numeric year is a VALID date that only needs quoting.
    const YEAR_LIST_SCHEMA = {
      version: 2,
      types: {
        log: {
          output_dir: 'Logs',
          fields: {
            type: { value: 'log' },
            years: { prompt: 'date' as const, multiple: true, granularity: 'year' as const },
          },
        },
      },
    };

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-673-'));
      await mkdir(join(tempVaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(YEAR_LIST_SCHEMA, null, 2)
      );
      await mkdir(join(tempVaultDir, 'Logs'), { recursive: true });
    });

    afterEach(async () => {
      await rm(tempVaultDir, { recursive: true, force: true });
    });

    async function auditIssues(filename: string) {
      const result = await runCLI(['audit', 'log', '--output', 'json'], tempVaultDir);
      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes(filename));
      const issues: { code: string; field?: string; listIndex?: number; value?: unknown; autoFixable?: boolean }[] =
        file?.issues ?? [];
      return issues;
    }

    it('flags a valid numeric date-list element as auto-fixable wrong-scalar-type', async () => {
      await writeFile(
        join(tempVaultDir, 'Logs', 'OneNumber.md'),
        `---\ntype: log\nyears:\n  - 2026\n---\n`
      );
      const issues = await auditIssues('OneNumber.md');
      const wrongScalar = issues.filter((i) => i.code === 'wrong-scalar-type');
      expect(wrongScalar).toHaveLength(1);
      expect(wrongScalar[0].listIndex).toBe(0);
      expect(wrongScalar[0].autoFixable).toBe(true);
    });

    it('quotes a valid numeric element in place, leaving the array intact', async () => {
      await writeFile(
        join(tempVaultDir, 'Logs', 'Quote.md'),
        `---\ntype: log\nyears:\n  - "2024"\n  - 2026\n  - "2025"\n---\n`
      );
      const result = await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(result.stdout).toContain('Quoted years[1]');

      const content = await readFile(join(tempVaultDir, 'Logs', 'Quote.md'), 'utf-8');
      // The numeric element is now a quoted string; array order + other elements preserved.
      expect(content).toContain('"2024"');
      expect(content).toContain('"2026"');
      expect(content).toContain('"2025"');
      // No bare numeric element remains (no array collapse to a single scalar).
      expect(content).not.toMatch(/^\s*-\s*2026\s*$/m);
      expect(content).toContain('years:');

      // Re-read through the parser: every element is a string, order preserved.
      const reaudit = await auditIssues('Quote.md');
      expect(reaudit.filter((i) => i.code === 'wrong-scalar-type')).toHaveLength(0);
    });

    it('is idempotent and round-trip stable (the #700 trap)', async () => {
      await writeFile(
        join(tempVaultDir, 'Logs', 'Idem.md'),
        `---\ntype: log\nyears:\n  - 2026\n---\n`
      );
      // First fix run quotes the element.
      const first = await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(first.stdout).toContain('Quoted years[0]');
      const afterFirst = await readFile(join(tempVaultDir, 'Logs', 'Idem.md'), 'utf-8');
      expect(afterFirst).toContain('"2026"');

      // A second audit finds nothing: the value stays a quoted string across the
      // YAML round-trip (no re-flag, no re-quote, never converges-and-diverges).
      const reaudit = await auditIssues('Idem.md');
      expect(reaudit.filter((i) => i.code === 'wrong-scalar-type')).toHaveLength(0);

      // A second fix run is a no-op and the value is unchanged on disk.
      const second = await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      expect(second.stdout).not.toContain('Quoted years[0]');
      const afterSecond = await readFile(join(tempVaultDir, 'Logs', 'Idem.md'), 'utf-8');
      expect(afterSecond).toBe(afterFirst);
    });

    it('quotes multiple numeric elements in one list, with no collapse', async () => {
      await writeFile(
        join(tempVaultDir, 'Logs', 'Multi.md'),
        `---\ntype: log\nyears:\n  - 2024\n  - 2025\n  - 2026\n---\n`
      );
      await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      const content = await readFile(join(tempVaultDir, 'Logs', 'Multi.md'), 'utf-8');
      expect(content).toContain('"2024"');
      expect(content).toContain('"2025"');
      expect(content).toContain('"2026"');
      const reaudit = await auditIssues('Multi.md');
      expect(reaudit.filter((i) => i.code === 'wrong-scalar-type')).toHaveLength(0);
      expect(reaudit.filter((i) => i.code === 'invalid-list-element')).toHaveLength(0);
    });

    it('quotes only the numeric element in a mixed numeric + string list', async () => {
      await writeFile(
        join(tempVaultDir, 'Logs', 'Mixed.md'),
        `---\ntype: log\nyears:\n  - "2024"\n  - 2026\n---\n`
      );
      await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      const content = await readFile(join(tempVaultDir, 'Logs', 'Mixed.md'), 'utf-8');
      expect(content).toContain('"2024"');
      expect(content).toContain('"2026"');
      const reaudit = await auditIssues('Mixed.md');
      expect(reaudit.filter((i) => i.code === 'wrong-scalar-type')).toHaveLength(0);
    });

    it('does NOT auto-quote an invalid numeric date element (stays invalid-date-format)', async () => {
      // At day granularity (default), numeric 13 is not a valid date: it must
      // remain an invalid-date-format flag and must NOT be "fixed" by quoting.
      const daySchema = {
        version: 2,
        config: { date_granularity: 'day' as const },
        types: {
          log: {
            output_dir: 'Logs',
            fields: {
              type: { value: 'log' },
              dates: { prompt: 'date' as const, multiple: true },
            },
          },
        },
      };
      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(daySchema, null, 2)
      );
      await writeFile(
        join(tempVaultDir, 'Logs', 'Invalid.md'),
        `---\ntype: log\ndates:\n  - "2026-01-01"\n  - 13\n---\n`
      );
      const before = await auditIssues('Invalid.md');
      const dateIssues = before.filter((i) => i.code === 'invalid-date-format');
      expect(dateIssues).toHaveLength(1);
      expect(dateIssues[0].listIndex).toBe(1);

      await runCLI(['audit', 'log', '--fix', '--auto', '--execute'], tempVaultDir);
      const content = await readFile(join(tempVaultDir, 'Logs', 'Invalid.md'), 'utf-8');
      // The invalid element is NOT quoted; it stays a bare number and stays flagged.
      expect(content).not.toContain('"13"');
      const after = await auditIssues('Invalid.md');
      expect(after.filter((i) => i.code === 'invalid-date-format')).toHaveLength(1);
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
      expect(casingIssue.meta.suggested).toBe('raw');
      expect(casingIssue.meta.matchedBy).toBe('case-insensitive');
      expect(casingIssue.meta.before).toBe('Raw');
      expect(casingIssue.meta.after).toBe('raw');
    });

    it('should not auto-fix when enum casing is ambiguous', async () => {
      const schemaWithCollision = {
        ...TEST_SCHEMA,
        types: {
          ...TEST_SCHEMA.types,
          idea: {
            ...TEST_SCHEMA.types.idea,
            fields: {
              ...(TEST_SCHEMA.types.idea.fields ?? {}),
              status: {
                ...((TEST_SCHEMA.types.idea.fields ?? {}).status ?? {}),
                options: ['raw', 'RAW'],
              },
            },
          },
        },
      };

      await writeFile(
        join(tempVaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(schemaWithCollision, null, 2)
      );

      await writeFile(
        join(tempVaultDir, 'Ideas', 'Ambiguous Enum.md'),
        `---
type: idea
status: Raw
priority: medium
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Ambiguous Enum.md'));
      expect(file).toBeDefined();
      const casingIssue = file.issues.find((i: { code: string }) => i.code === 'unknown-enum-casing');
      expect(casingIssue).toBeDefined();
      expect(casingIssue.autoFixable).toBe(false);
      expect(casingIssue.meta.candidates).toEqual(['raw', 'RAW']);
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

    it('should detect duplicate values in list (case-sensitive)', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Duplicates.md'),
        `---
type: idea
status: raw
priority: medium
tags:
  - urgent
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
      expect(dupIssue.meta.duplicates).toEqual(['urgent']);
      expect(dupIssue.meta.removedCount).toBe(1);
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
      expect(content).toContain('Urgent');
      // Should only have one of the duplicate values
      const matches = content.match(/\burgent\b/g);
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
      expect(keyIssue.meta.fromKey).toBe('Status');
      expect(keyIssue.meta.toKey).toBe('status');
      expect(keyIssue.meta.before).toBe('Status');
      expect(keyIssue.meta.after).toBe('status');
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
      expect(keyIssue.meta.fromKey).toBe('Status');
      expect(keyIssue.meta.toKey).toBe('status');
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

    it('should mark singular/plural conflicts as non-auto-fixable', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Plural Conflict.md'),
        `---
type: idea
status: raw
priority: medium
tag: urgent
tags: later
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Plural Conflict.md'));
      expect(file).toBeDefined();
      const pluralIssue = file.issues.find((i: { code: string }) => i.code === 'singular-plural-mismatch');
      expect(pluralIssue).toBeDefined();
      expect(pluralIssue.autoFixable).toBe(false);
      expect(pluralIssue.hasConflict).toBe(true);
    });
  });

  describe('frontmatter-not-at-top fixes', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-top-'));
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

    it('should detect frontmatter not at top', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Misplaced.md'),
        `Intro line\n---\ntype: idea\nstatus: raw\npriority: medium\n---\nBody\n`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Misplaced.md'));
      expect(file).toBeDefined();
      const issue = file.issues.find((i: { code: string }) => i.code === 'frontmatter-not-at-top');
      expect(issue).toBeDefined();
      expect(issue.autoFixable).toBe(true);
    });

    it('should ignore non-frontmatter delimiter blocks', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Body Rules.md'),
        `Intro line\n---\nNot frontmatter\n---\nBody\n`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Body Rules.md'));
      expect(file).toBeDefined();
      const issue = file.issues.find((i: { code: string }) => i.code === 'frontmatter-not-at-top');
      expect(issue).toBeUndefined();
    });

    it('should auto-fix frontmatter to the top', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Misplaced.md'),
        `Intro line\n---\ntype: idea\nstatus: raw\npriority: medium\n---\nBody\n`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Moved frontmatter to top');

      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Misplaced.md'), 'utf-8');
      expect(content.startsWith('---')).toBe(true);
      const frontmatterEnd = content.indexOf('---', 3);
      expect(frontmatterEnd).toBeGreaterThan(0);
      expect(content.indexOf('Intro line')).toBeGreaterThan(frontmatterEnd);
    });
  });

  describe('duplicate frontmatter keys', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-duplicates-'));
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

    it('should detect duplicate frontmatter keys', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Duplicate Tags.md'),
        `---
type: idea
status: raw
priority: medium
tags: urgent
tags: urgent
---
`
      );

      const result = await runCLI(['audit', 'idea', '--output', 'json'], tempVaultDir);

      const output = JSON.parse(result.stdout);
      const file = output.files.find((f: { path: string }) => f.path.includes('Duplicate Tags.md'));
      expect(file).toBeDefined();
      const issue = file.issues.find((i: { code: string }) => i.code === 'duplicate-frontmatter-keys');
      expect(issue).toBeDefined();
      expect(issue.duplicateCount).toBe(2);
      expect(issue.autoFixable).toBe(true);
    });

    it('should auto-fix duplicate keys when values match', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Fix Duplicate Tags.md'),
        `---
type: idea
status: raw
priority: medium
tags: urgent
tags: urgent
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto', '--execute'], tempVaultDir);

      expect(result.stdout).toContain('Resolved duplicate key');

      const { readFile } = await import('fs/promises');
      const content = await readFile(join(tempVaultDir, 'Ideas', 'Fix Duplicate Tags.md'), 'utf-8');
      const matches = content.match(/tags:/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('should require manual review when duplicate values differ', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Duplicate Conflict.md'),
        `---
type: idea
status: raw
priority: medium
tags: urgent
tags: later
---
`
      );

      const result = await runCLI(['audit', 'idea', '--fix', '--auto'], tempVaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Issues requiring manual review');
      expect(result.stdout).toContain('Duplicate frontmatter key');
    });
  });

  describe('audit --fix messaging', () => {
    let tempVaultDir: string;

    beforeEach(async () => {
      tempVaultDir = await mkdtemp(join(tmpdir(), 'bwrb-audit-fix-message-'));
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

    it('should include --execute guidance in auto dry-run mode', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Dry Run.md'),
        `---
type: idea
status: " "
priority: medium
---
`
      );

      const result = await runCLI(
        ['audit', '--fix', '--auto', '--path', 'Ideas/**', '--dry-run'],
        tempVaultDir
      );

      expect(result.stdout).toContain('Dry run');
      expect(result.stdout).toContain("Re-run with '--execute' to apply fixes.");

      const content = await readFile(join(tempVaultDir, 'Ideas', 'Dry Run.md'), 'utf-8');
      expect(content).not.toContain('status: raw');
    });

    it('should confirm applied fixes when --execute is provided', async () => {
      await writeFile(
        join(tempVaultDir, 'Ideas', 'Applied Fix.md'),
        `---
type: idea
status: " "
priority: medium
---
`
      );

      const result = await runCLI(
        ['audit', '--fix', '--auto', '--execute', '--path', 'Ideas/**'],
        tempVaultDir
      );

      expect(result.stdout).toContain('Applied fixes');
      expect(result.stdout).not.toContain('--execute');

      const content = await readFile(join(tempVaultDir, 'Ideas', 'Applied Fix.md'), 'utf-8');
      expect(content).toContain('status: raw');
    });
  });
});
