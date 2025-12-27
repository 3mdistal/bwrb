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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
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
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
      tempVaultDir = await mkdtemp(join(tmpdir(), 'ovault-audit-test-'));
      await mkdir(join(tempVaultDir, '.ovault'), { recursive: true });
      await writeFile(
        join(tempVaultDir, '.ovault', 'schema.json'),
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
});
