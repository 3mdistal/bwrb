/**
 * PTY-based integration tests for confirmation prompts.
 *
 * Tests promptConfirm from src/lib/prompt.ts using real terminal processes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  spawnOvault,
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  vaultFileExists,
  readVaultFile,
  TempVaultFile,
  shouldSkipPtyTests,
} from './pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

// Schema for testing confirmation prompts (used by edit command)
const EDIT_TEST_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
  },
  types: {
    idea: {
      output_dir: 'Ideas',
      name_field: 'Idea name',
      frontmatter: {
        type: { value: 'idea' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
      },
      frontmatter_order: ['type', 'status'],
      body_sections: [
        { title: 'Notes', level: 2, content_type: 'paragraphs' },
      ],
    },
  },
};

describePty('Confirmation Prompt PTY tests', () => {
  beforeAll(() => {
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('promptConfirm (y/n input)', () => {
    it('should accept "y" as confirmation', async () => {
      // Create a file that's missing the "Notes" section to trigger the confirm prompt
      const existingFile: TempVaultFile = {
        path: 'Ideas/Test Idea.md',
        content: `---
type: idea
status: raw
---

Some content without the Notes section.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Test Idea.md'],
        async (proc, vaultPath) => {
          // Wait for the edit to start
          await proc.waitFor('Editing:', 10000);

          // Wait for status field display
          await proc.waitFor('status', 10000);

          // Keep current value (select first option)
          proc.write('1');
          await proc.waitForStable(200);

          // Should ask about checking for missing sections
          await proc.waitFor('Check for missing sections', 10000);

          // Answer yes
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should detect missing Notes section and ask to add it
          await proc.waitFor('Missing section: Notes', 10000);
          await proc.waitFor('Add it?', 5000);

          // Answer yes to add it
          proc.write('y');
          proc.write(Keys.ENTER);

          // Wait for update completion
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify the section was added
          const content = await readVaultFile(vaultPath, 'Ideas/Test Idea.md');
          expect(content).toContain('## Notes');
        },
        [existingFile],
        EDIT_TEST_SCHEMA
      );
    }, 30000);

    it('should accept "n" as rejection', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Test Idea.md',
        content: `---
type: idea
status: raw
---

Content without Notes section.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Test Idea.md'],
        async (proc, vaultPath) => {
          // Wait for edit to start
          await proc.waitFor('Editing:', 10000);

          // Wait for status prompt and keep current
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          // Should ask about checking for missing sections
          await proc.waitFor('Check for missing sections', 10000);

          // Answer no - don't check
          proc.write('n');
          proc.write(Keys.ENTER);

          // Should complete without adding section
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify the section was NOT added
          const content = await readVaultFile(vaultPath, 'Ideas/Test Idea.md');
          expect(content).not.toContain('## Notes');
        },
        [existingFile],
        EDIT_TEST_SCHEMA
      );
    }, 30000);

    it('should use default (false) when Enter is pressed without input', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Test Idea.md',
        content: `---
type: idea
status: raw
---

Content.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Test Idea.md'],
        async (proc, vaultPath) => {
          // Wait for edit to start
          await proc.waitFor('Editing:', 10000);

          // Keep current status
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          // Should ask about checking for missing sections
          await proc.waitFor('Check for missing sections', 10000);

          // Just press Enter (should default to no)
          proc.write(Keys.ENTER);

          // Should complete without checking sections
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify no section was added (default was false)
          const content = await readVaultFile(vaultPath, 'Ideas/Test Idea.md');
          expect(content).not.toContain('## Notes');
        },
        [existingFile],
        EDIT_TEST_SCHEMA
      );
    }, 30000);

    it('should cancel on Ctrl+C during confirmation', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Test Idea.md',
        content: `---
type: idea
status: raw
---

Content.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Test Idea.md'],
        async (proc) => {
          // Wait for edit to start
          await proc.waitFor('Editing:', 10000);

          // Wait for status prompt and keep current
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          // Wait for confirm prompt
          await proc.waitFor('Check for missing sections', 10000);

          // Press Ctrl+C to cancel
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') ||
            output.includes('cancelled')
          ).toBe(true);
        },
        [existingFile],
        EDIT_TEST_SCHEMA
      );
    }, 30000);
  });

  describe('overwrite confirmation', () => {
    it('should prompt for overwrite when file exists and handle "y"', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Existing Idea.md',
        content: `---
type: idea
status: raw
---

Original content.
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);

          // Enter name that matches existing file
          await proc.typeAndEnter('Existing Idea');

          // Complete the other prompts
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitFor('priority', 10000);
          proc.write('1');

          // Should prompt for overwrite
          await proc.waitFor('already exists', 10000);
          await proc.waitFor('Overwrite', 5000);

          // Confirm overwrite
          proc.write('y');
          proc.write(Keys.ENTER);

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was overwritten (new content)
          const content = await readVaultFile(vaultPath, 'Ideas/Existing Idea.md');
          // Should NOT contain original content
          expect(content).not.toContain('Original content');
        },
        [existingFile]
      );
    }, 30000);

    it('should abort when overwrite is declined with "n"', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Keep This.md',
        content: `---
type: idea
status: raw
---

Keep this content.
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);

          // Enter name that matches existing file
          await proc.typeAndEnter('Keep This');

          // Complete prompts
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitFor('priority', 10000);
          proc.write('1');

          // Should prompt for overwrite
          await proc.waitFor('already exists', 10000);
          await proc.waitFor('Overwrite', 5000);

          // Decline overwrite
          proc.write('n');
          proc.write(Keys.ENTER);

          // Should abort
          await proc.waitFor('Aborted', 5000);

          // Verify original content is preserved
          const content = await readVaultFile(vaultPath, 'Ideas/Keep This.md');
          expect(content).toContain('Keep this content');
        },
        [existingFile]
      );
    }, 30000);
  });
});
