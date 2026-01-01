/**
 * PTY-based integration tests for the `pika audit --fix` command.
 *
 * Tests interactive fix mode for various audit issues.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  readVaultFile,
  TempVaultFile,
  shouldSkipPtyTests,
} from '../lib/pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

// Schema for audit tests
const AUDIT_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    type: ['idea', 'objective'],
    'objective-type': ['task', 'milestone'],
  },
  types: {
    idea: {
      output_dir: 'Ideas',
      frontmatter: {
        type: { value: 'idea' },
        status: { prompt: 'select', enum: 'status', default: 'raw', required: true },
      },
      frontmatter_order: ['type', 'status'],
    },
    objective: {
      output_dir: 'Objectives',
      subtypes: {
        task: {
          output_dir: 'Tasks',
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'task' },
            status: { prompt: 'select', enum: 'status', default: 'raw', required: true },
          },
          frontmatter_order: ['type', 'objective-type', 'status'],
        },
      },
    },
  },
};

describePty('pika audit --fix command PTY tests', () => {
  beforeAll(() => {
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('orphan file fix', () => {
    it('should fix orphan file by adding type field', async () => {
      // File in Ideas folder but missing type field
      const orphanFile: TempVaultFile = {
        path: 'Ideas/Orphan Idea.md',
        content: `---
status: raw
---

Content without type field.
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          // Wait for audit to start
          await proc.waitFor('Auditing vault', 10000);

          // Should find the orphan file
          await proc.waitFor('Orphan Idea.md', 10000);

          // Should prompt to add type (inferred from directory)
          await proc.waitFor("Add type fields for 'idea'", 10000);

          // Confirm adding type
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should show success
          await proc.waitFor('Added', 5000);

          // Wait for audit to complete
          await proc.waitForStable(500);

          // Verify type was added
          const content = await readVaultFile(vaultPath, 'Ideas/Orphan Idea.md');
          expect(content).toContain('type: idea');
        },
        { files: [orphanFile], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should allow skipping orphan file fix', async () => {
      const orphanFile: TempVaultFile = {
        path: 'Ideas/Skip Me.md',
        content: `---
some-field: value
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Skip Me.md', 10000);

          // Should prompt to add type
          await proc.waitFor("Add type fields", 10000);

          // Decline
          proc.write('n');
          proc.write(Keys.ENTER);

          // Should show skipped
          await proc.waitFor('Skipped', 5000);

          // Wait for audit to complete
          await proc.waitForStable(500);

          // Verify type was NOT added
          const content = await readVaultFile(vaultPath, 'Ideas/Skip Me.md');
          expect(content).not.toContain('type: idea');
        },
        { files: [orphanFile], schema: AUDIT_SCHEMA }
      );
    }, 30000);
  });

  describe('missing required field fix', () => {
    it('should fix missing required field with default value', async () => {
      // File with type but missing required status field
      const missingField: TempVaultFile = {
        path: 'Ideas/Missing Status.md',
        content: `---
type: idea
---

Missing required status.
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Missing Status.md', 10000);

          // Should offer to add with default value
          await proc.waitFor("Add with default", 10000);

          // Confirm
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should show success
          await proc.waitFor('Added status', 5000);

          // Wait for completion
          await proc.waitForStable(500);

          // Verify field was added
          const content = await readVaultFile(vaultPath, 'Ideas/Missing Status.md');
          expect(content).toContain('status: raw');
        },
        { files: [missingField], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should prompt for value when no default available', async () => {
      // Schema without default for a required field
      const noDefaultSchema = {
        ...AUDIT_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            frontmatter: {
              type: { value: 'item' },
              category: { prompt: 'select', enum: 'status', required: true }, // No default
            },
            frontmatter_order: ['type', 'category'],
          },
        },
      };

      const missingField: TempVaultFile = {
        path: 'Items/No Default.md',
        content: `---
type: item
---
`,
      };

      await withTempVault(
        ['audit', 'item', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('No Default.md', 10000);

          // Should prompt to select value
          await proc.waitFor('Select value for category', 10000);

          // Select first option (raw)
          proc.write('1');
          await proc.waitForStable(200);

          // Should show success
          await proc.waitFor('Added category', 5000);

          // Verify field was added
          const content = await readVaultFile(vaultPath, 'Items/No Default.md');
          expect(content).toContain('category: raw');
        },
        { files: [missingField], schema: noDefaultSchema }
      );
    }, 30000);
  });

  describe('invalid enum fix', () => {
    it('should fix invalid enum value by selecting valid option', async () => {
      const invalidEnum: TempVaultFile = {
        path: 'Ideas/Bad Status.md',
        content: `---
type: idea
status: invalid-status-value
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Bad Status.md', 10000);

          // Should prompt to select valid value
          await proc.waitFor('Select valid value for status', 10000);

          // Select 'backlog' (option 2)
          proc.write('2');
          await proc.waitForStable(200);

          // Should show success
          await proc.waitFor('Updated status', 5000);

          // Verify field was updated
          const content = await readVaultFile(vaultPath, 'Ideas/Bad Status.md');
          expect(content).toContain('status: backlog');
          expect(content).not.toContain('invalid-status-value');
        },
        { files: [invalidEnum], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should allow skipping invalid enum fix', async () => {
      const invalidEnum: TempVaultFile = {
        path: 'Ideas/Keep Bad.md',
        content: `---
type: idea
status: keep-this-bad-value
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Keep Bad.md', 10000);

          // Should prompt to select valid value
          await proc.waitFor('Select valid value', 10000);

          // Select [skip] option - it's option 5 (raw=1, backlog=2, in-flight=3, settled=4, [skip]=5)
          proc.write('5');
          await proc.waitForStable(200);

          // Should show skipped
          await proc.waitFor('Skipped', 5000);

          // Verify value was NOT changed
          const content = await readVaultFile(vaultPath, 'Ideas/Keep Bad.md');
          expect(content).toContain('keep-this-bad-value');
        },
        { files: [invalidEnum], schema: AUDIT_SCHEMA }
      );
    }, 30000);
  });

  describe('unknown field fix', () => {
    it('should offer to remove unknown field', async () => {
      const unknownField: TempVaultFile = {
        path: 'Ideas/Extra Field.md',
        content: `---
type: idea
status: raw
extra_unknown_field: some value
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Extra Field.md', 10000);

          // Should offer action for unknown field
          await proc.waitFor("Action for unknown field", 10000);

          // Select [remove field] option
          proc.write('2'); // Assuming [skip] is 1, [remove field] is 2
          await proc.waitForStable(200);

          // Should show success
          await proc.waitFor('Removed field', 5000);

          // Verify field was removed
          const content = await readVaultFile(vaultPath, 'Ideas/Extra Field.md');
          expect(content).not.toContain('extra_unknown_field');
        },
        { files: [unknownField], schema: AUDIT_SCHEMA }
      );
    }, 30000);
  });

  describe('quit during fix', () => {
    it('should quit cleanly when [quit] is selected', async () => {
      const file1: TempVaultFile = {
        path: 'Ideas/Issue 1.md',
        content: `---
status: raw
---
`,
      };
      const file2: TempVaultFile = {
        path: 'Ideas/Issue 2.md',
        content: `---
status: raw
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Issue', 10000);

          // Should prompt for fix
          await proc.waitFor("Add type fields", 10000);

          // Decline to trigger next issue
          proc.write('n');
          proc.write(Keys.ENTER);
          await proc.waitForStable(200);

          // Wait for second file prompt, then send Ctrl+C to quit
          await proc.waitFor("Add type fields", 10000);
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should have exited (Ctrl+C cancels during prompts)
          expect(proc.hasExited()).toBe(true);
        },
        { files: [file1, file2], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should abort on Ctrl+C during fix prompt', async () => {
      const orphanFile: TempVaultFile = {
        path: 'Ideas/Abort Test.md',
        content: `---
some: value
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Abort Test.md', 10000);

          // Wait for prompt
          await proc.waitFor("Add type fields", 10000);

          // Abort with Ctrl+C
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);
          expect(proc.hasExited()).toBe(true);
        },
        { files: [orphanFile], schema: AUDIT_SCHEMA }
      );
    }, 30000);
  });

  describe('format violation fix', () => {
    it('should fix format violation by converting to wikilink', async () => {
      const formatSchema = {
        ...AUDIT_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            frontmatter: {
              type: { value: 'item' },
              link: { prompt: 'input', format: 'wikilink' },
            },
            frontmatter_order: ['type', 'link'],
          },
        },
      };

      // Reference file to make the link valid
      const refFile: TempVaultFile = {
        path: 'Items/Target.md',
        content: `---
type: item
---
`,
      };

      const formatIssue: TempVaultFile = {
        path: 'Items/Bad Format.md',
        content: `---
type: item
link: Target
---
`,
      };

      await withTempVault(
        ['audit', 'item', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Bad Format.md', 10000);

          // Should offer to convert to wikilink format
          await proc.waitFor('Convert to wikilink format', 10000);

          // Confirm
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should show success
          await proc.waitFor('Converted', 5000);

          // Wait for completion
          await proc.waitForStable(500);

          // Verify format was fixed
          const content = await readVaultFile(vaultPath, 'Items/Bad Format.md');
          expect(content).toContain('link: "[[Target]]"');
        },
        { files: [refFile, formatIssue], schema: formatSchema }
      );
    }, 30000);
  });

  describe('auto fix mode', () => {
    it('should automatically fix unambiguous issues with --auto', async () => {
      const orphanFile: TempVaultFile = {
        path: 'Ideas/Auto Fix Me.md',
        content: `---
status: raw
---

Auto-fixable orphan.
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix', '--auto'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auto-fixing', 10000);

          // Should fix automatically without prompting
          await proc.waitFor('Added', 10000);

          // Wait for completion
          await proc.waitForStable(500);

          // Verify type was added
          const content = await readVaultFile(vaultPath, 'Ideas/Auto Fix Me.md');
          expect(content).toContain('type: idea');
        },
        { files: [orphanFile], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should skip ambiguous issues in auto mode', async () => {
      // Schema without default value - can't auto-fix
      const noDefaultSchema = {
        ...AUDIT_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            frontmatter: {
              type: { value: 'item' },
              category: { prompt: 'select', enum: 'status', required: true },
            },
            frontmatter_order: ['type', 'category'],
          },
        },
      };

      const ambiguousFile: TempVaultFile = {
        path: 'Items/Need Manual.md',
        content: `---
type: item
---
`,
      };

      await withTempVault(
        ['audit', 'item', '--fix', '--auto'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auto-fixing', 10000);

          // Should show issues requiring manual review
          await proc.waitFor('manual review', 10000);

          // Wait for completion
          await proc.waitForStable(500);

          // Verify field was NOT added (needs manual input)
          const content = await readVaultFile(vaultPath, 'Items/Need Manual.md');
          expect(content).not.toContain('category:');
        },
        { files: [ambiguousFile], schema: noDefaultSchema }
      );
    }, 30000);
  });
});
