/**
 * PTY-based integration tests for the `bwrb audit --fix` command.
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

// Import shared schema for audit tests
import { BASELINE_SCHEMA } from '../fixtures/schemas.js';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

describePty('bwrb audit --fix command PTY tests', () => {
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
        { files: [orphanFile], schema: BASELINE_SCHEMA }
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
        { files: [orphanFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);
  });

  describe('relation field fixes', () => {
    it('should clear self-reference in parent field', async () => {
      const taskFile: TempVaultFile = {
        path: 'Objectives/Tasks/Self Task.md',
        content: `---
type: task
status: backlog
parent: [[Self Task]]
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Self Task.md', 10000);
          await proc.waitFor('Self-reference detected', 10000);
          await proc.waitFor('Action for self-reference', 10000);

          proc.write('1');
          proc.write(Keys.ENTER);

          await proc.waitFor('Cleared parent', 5000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Self Task.md');
          expect(content).not.toContain('parent: [[Self Task]]');
        },
        { files: [taskFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should resolve ambiguous relation target', async () => {
      const taskFile: TempVaultFile = {
        path: 'Objectives/Tasks/Ambiguous Task.md',
        content: `---
type: task
status: backlog
milestone: [[Shared]]
---
`,
      };
      const milestoneFile: TempVaultFile = {
        path: 'Objectives/Milestones/Shared.md',
        content: `---
type: milestone
status: raw
---
`,
      };
      const milestoneFolderFile: TempVaultFile = {
        path: 'Objectives/Milestones/Shared/Shared.md',
        content: `---
type: milestone
status: raw
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Ambiguous Task.md', 10000);
          await proc.waitFor('Ambiguous link target', 10000);
          await proc.waitFor('Select target for milestone', 10000);

          proc.write('1');
          proc.write(Keys.ENTER);

          await proc.waitFor('Updated milestone', 5000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Ambiguous Task.md');
          expect(content).toContain('milestone:');
          expect(content).toContain('[[Objectives/Milestones/Shared]]');
          expect(content).not.toContain('milestone: [[Shared]]');
        },
        { files: [taskFile, milestoneFile, milestoneFolderFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should remove invalid list element', async () => {
      const taskFile: TempVaultFile = {
        path: 'Objectives/Tasks/Bad Tags.md',
        content: `---
type: task
status: backlog
tags:
  - good
  - 42
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Bad Tags.md', 10000);
          await proc.waitFor('Invalid list element', 10000);
          await proc.waitFor('Fix list value for tags', 10000);

          proc.write('1');
          proc.write(Keys.ENTER);

          await proc.waitFor('Removed invalid element', 5000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Bad Tags.md');
          expect(content).toContain('- good');
          expect(content).not.toContain('- 42');
        },
        { files: [taskFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);
  });

  describe('missing required field fix', () => {
    it('should add required field with default value', async () => {
      const missingField: TempVaultFile = {
        path: 'Ideas/Missing Status.md',
        content: `---
type: idea
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Missing Status.md', 10000);

          // Should offer to add with default value
          await proc.waitFor('Add with default', 10000);

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
        { files: [missingField], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should treat empty required values as missing', async () => {
      const emptyRequired: TempVaultFile = {
        path: 'Ideas/Empty Required.md',
        content: `---
type: idea
status: " "
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Empty Required.md', 10000);
          await proc.waitFor('Missing required field: status', 10000);
          await proc.waitFor('Add with default', 10000);

          proc.write('y');
          proc.write(Keys.ENTER);

          await proc.waitFor('Added status', 5000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Ideas/Empty Required.md');
          expect(content).toContain('status: raw');
        },
        { files: [emptyRequired], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should prompt for value when no default available', async () => {
      // Schema without default for a required field
      const noDefaultSchema = {
        ...BASELINE_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            fields: {
              type: { value: 'item' },
              category: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], required: true },
            },
            field_order: ['type', 'category'],
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
        { files: [invalidEnum], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should prompt for invalid date formats', async () => {
      const invalidDate: TempVaultFile = {
        path: 'Objectives/Tasks/Bad Date.md',
        content: `---
type: task
status: backlog
deadline: 01/02/2026
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Bad Date.md', 10000);
          await proc.waitFor('Invalid date', 10000);
          await proc.waitFor('Enter YYYY-MM-DD for deadline', 10000);

          proc.write('2026-02-01');
          proc.write(Keys.ENTER);

          await proc.waitFor('Updated deadline: 2026-02-01', 10000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Bad Date.md');
          expect(content).toContain('deadline: 2026-02-01');
        },
        { files: [invalidDate], schema: AUDIT_SCHEMA }
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
        { files: [invalidEnum], schema: BASELINE_SCHEMA }
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
          await proc.waitFor('Select target for unknown field', 10000);

          // Select [remove field] option
          proc.write('2'); // [skip]=1, [remove field]=2
          await proc.waitForStable(200);

          // Should show success
          await proc.waitFor('Removed field', 5000);

          // Verify field was removed
          const content = await readVaultFile(vaultPath, 'Ideas/Extra Field.md');
          expect(content).not.toContain('extra_unknown_field');
        },
        { files: [unknownField], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should migrate unknown field to exact normalized match', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Deadline Typo.md',
        content: `---
type: task
status: backlog
dead_line: 2026-01-01
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Deadline Typo.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);

          // deadline should be the top candidate
          proc.write('1');
          await proc.waitForStable(200);

          await proc.waitFor('Migrated dead_line → deadline', 5000);
          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Deadline Typo.md');
          expect(content).toContain('deadline: 2026-01-01');
          expect(content).not.toContain('dead_line:');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should warn before overwriting existing target field', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Deadline Overwrite.md',
        content: `---
type: task
status: backlog
deadline: 2025-01-01
dead_line: 2026-01-01
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Deadline Overwrite.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);
          proc.write('1'); // deadline candidate
          await proc.waitForStable(200);

          await proc.waitFor("Overwrite existing 'deadline' value?", 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          await proc.waitFor('Skipped', 5000);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Deadline Overwrite.md');
          expect(content).toContain('deadline: 2025-01-01');
          expect(content).toContain('dead_line: 2026-01-01');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should overwrite existing target field when confirmed', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Deadline Overwrite Yes.md',
        content: `---
type: task
status: backlog
deadline: 2025-01-01
dead_line: 2026-01-01
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Deadline Overwrite Yes.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);
          proc.write('1'); // deadline candidate
          await proc.waitForStable(200);

          await proc.waitFor("Overwrite existing 'deadline' value?", 10000);
          proc.write('y');
          proc.write(Keys.ENTER);

          await proc.waitFor('Migrated dead_line → deadline', 5000);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Deadline Overwrite Yes.md');
          expect(content).toContain('deadline: 2026-01-01');
          expect(content).not.toContain('dead_line: 2026-01-01');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should require extra confirmation on TYPE MISMATCH', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Tag Mismatch.md',
        content: `---
type: task
status: backlog
tag: foo
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Tag Mismatch.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);
          proc.write('1'); // tags (TYPE MISMATCH)
          await proc.waitForStable(200);

          await proc.waitFor('TYPE MISMATCH: Proceed with migration?', 10000);
          proc.write('y');
          await proc.waitForStable(200);

          await proc.waitFor('Migrated tag → tags', 5000);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Tag Mismatch.md');
          expect(content).toContain('tags: foo');
          expect(content).not.toContain('tag: foo');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should migrate singular/plural match when shape is compatible', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Tag List.md',
        content: `---
type: task
status: backlog
tag:
  - foo
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Tag List.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);
          proc.write('1'); // tags candidate
          await proc.waitForStable(200);

          await proc.waitFor('Migrated tag → tags', 5000);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Tag List.md');
          expect(content).toContain('tags:');
          expect(content).not.toContain('tag:');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should not write unknown-field migrations in dry-run mode', async () => {
      const file: TempVaultFile = {
        path: 'Objectives/Tasks/Deadline Dry Run.md',
        content: `---
type: task
status: backlog
dead_line: 2026-01-01
---
`,
      };

      await withTempVault(
        ['audit', 'task', '--fix', '--strict', '--dry-run'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Deadline Dry Run.md', 10000);

          await proc.waitFor('Select target for unknown field', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          await proc.waitFor('Migrated dead_line → deadline', 5000);

          const content = await readVaultFile(vaultPath, 'Objectives/Tasks/Deadline Dry Run.md');
          expect(content).toContain('dead_line: 2026-01-01');
          expect(content).not.toContain('deadline: 2026-01-01');
        },
        { files: [file], schema: BASELINE_SCHEMA }
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
        { files: [file1, file2], schema: BASELINE_SCHEMA }
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
        { files: [orphanFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);
  });

  describe('format violation fix', () => {
    it('should fix format violation by converting to wikilink', async () => {
      const formatSchema = {
        ...BASELINE_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            fields: {
              type: { value: 'item' },
              // relation fields should use wikilink format (from global config)
              link: { prompt: 'relation', source: 'item' },
            },
            field_order: ['type', 'link'],
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

          // Verify format was fixed - should now be a wikilink
          const content = await readVaultFile(vaultPath, 'Items/Bad Format.md');
          expect(content).toContain('[[Target]]');
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
        ['audit', 'idea', '--fix', '--auto', '--execute'],
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
        { files: [orphanFile], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should auto-coerce wrong scalar type', async () => {
      const scalarFile: TempVaultFile = {
        path: 'Ideas/Scalar Coerce.md',
        content: `---
type: idea
status: raw
priority: medium
archived: "false"
effort: "5"
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix', '--auto', '--execute'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auto-fixing', 10000);
          await proc.waitFor('Coerced archived to boolean', 10000);
          await proc.waitFor('Coerced effort to number', 10000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Ideas/Scalar Coerce.md');
          expect(content).toContain('archived: false');
          expect(content).toContain('effort: 5');
        },
        { files: [scalarFile], schema: AUDIT_SCHEMA }
      );
    }, 30000);

    it('should skip ambiguous issues in auto mode', async () => {
      // Schema without default value - can't auto-fix
      const noDefaultSchema = {
        ...BASELINE_SCHEMA,
        types: {
          item: {
            output_dir: 'Items',
            fields: {
              type: { value: 'item' },
              category: { prompt: 'select', options: ['raw', 'backlog', 'in-flight', 'settled'], required: true },
            },
            field_order: ['type', 'category'],
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
        ['audit', 'item', '--fix', '--auto', '--execute'],
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

  describe('Phase 4 structural fixes', () => {
    it('should move frontmatter to top when eligible', async () => {
      const file: TempVaultFile = {
        path: 'Ideas/Frontmatter Not Top.md',
        content: `Intro line before frontmatter.

---
type: idea
status: raw
---

Body content.
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Frontmatter Not Top.md', 10000);
          await proc.waitFor('Frontmatter is not at the top', 10000);
          await proc.waitFor('Move frontmatter to the top of the file', 10000);

          proc.write('y');
          proc.write(Keys.ENTER);

          await proc.waitFor('Moved frontmatter to top', 10000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Ideas/Frontmatter Not Top.md');
          expect(content.startsWith('---')).toBe(true);
          expect(content).toContain('type: idea');
          expect(content).toContain('Intro line before frontmatter');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should resolve duplicate frontmatter keys interactively', async () => {
      const file: TempVaultFile = {
        path: 'Ideas/Duplicate Keys.md',
        content: `---
type: idea
status: raw
status: backlog
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auditing vault', 10000);
          await proc.waitFor('Duplicate Keys.md', 10000);
          await proc.waitFor('Duplicate frontmatter key: status', 10000);
          await proc.waitFor("Resolve duplicate key 'status'", 10000);

          // Select "keep first" (option 2)
          proc.write('2');
          await proc.waitForStable(500);

          await proc.waitFor('Resolved duplicate key', 10000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Ideas/Duplicate Keys.md');
          expect(content).toContain('status: raw');
          expect(content).not.toContain('status: backlog');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);

    it('should auto-fix malformed wikilinks in frontmatter', async () => {
      const file: TempVaultFile = {
        path: 'Ideas/Bad Link.md',
        content: `---
type: idea
status: raw
broken: "[[Target]"
---
`,
      };

      await withTempVault(
        ['audit', 'idea', '--fix', '--auto', '--execute'],
        async (proc, vaultPath) => {
          await proc.waitFor('Auto-fixing', 10000);
          await proc.waitFor('Fixed malformed wikilink', 10000);
          await proc.waitForStable(500);

          const content = await readVaultFile(vaultPath, 'Ideas/Bad Link.md');
          expect(content).toContain('[[Target]]');
        },
        { files: [file], schema: BASELINE_SCHEMA }
      );
    }, 30000);
  });
});
