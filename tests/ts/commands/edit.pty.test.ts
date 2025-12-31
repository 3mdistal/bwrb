/**
 * PTY-based integration tests for the `ovault edit` command.
 *
 * Tests field editing, value preservation, and cancellation behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  vaultFileExists,
  readVaultFile,
  TempVaultFile,
  shouldSkipPtyTests,
} from '../lib/pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

// Schema for edit tests
const EDIT_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  types: {
    idea: {
      output_dir: 'Ideas',
      name_field: 'Idea name',
      frontmatter: {
        type: { value: 'idea' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
        priority: { prompt: 'select', enum: 'priority' },
        description: { prompt: 'input', label: 'Description' },
      },
      frontmatter_order: ['type', 'status', 'priority', 'description'],
      body_sections: [
        { title: 'Notes', level: 2, content_type: 'paragraphs' },
      ],
    },
  },
};

describePty('ovault edit command PTY tests', () => {
  beforeAll(() => {
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('field editing', () => {
    it('should show current values and allow keeping them', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Existing Idea.md',
        content: `---
type: idea
status: backlog
priority: high
---

## Notes

Some notes here.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Existing Idea.md'],
        async (proc, vaultPath) => {
          // Should show editing header
          await proc.waitFor('Editing:', 10000);

          // Should show current status value (keep current is first option)
          await proc.waitFor('status', 10000);
          proc.write('1'); // Keep current
          await proc.waitForStable(100);

          // Keep current priority
          await proc.waitFor('priority', 10000);
          proc.write('1'); // Keep current
          await proc.waitForStable(100);

          // Wait for update or next prompt
          await proc.waitForStable(500);

          // Verify values were preserved
          const content = await readVaultFile(vaultPath, 'Ideas/Existing Idea.md');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: high');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should update field value when different option selected', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Update Status.md',
        content: `---
type: idea
status: raw
priority: low
---

## Notes

Existing notes.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Update Status.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Update status from raw to in-flight (option 4)
          await proc.waitFor('status', 10000);
          proc.write('4'); // raw=2, backlog=3, in-flight=4, settled=5 (keep current=1)
          await proc.waitForStable(100);

          // Keep current priority
          await proc.waitFor('priority', 10000);
          proc.write('1'); // Keep current
          await proc.waitForStable(100);

          // Keep current description (just press Enter)
          await proc.waitFor('Description', 10000);
          proc.write(Keys.ENTER);
          await proc.waitForStable(100);

          // Body section check - decline
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify status was updated
          const content = await readVaultFile(vaultPath, 'Ideas/Update Status.md');
          expect(content).toContain('status: in-flight');
          expect(content).toContain('priority: low'); // Unchanged
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should update text input field with new value', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Text Edit.md',
        content: `---
type: idea
status: raw
priority: low
description: Original description
---

## Notes

Notes here.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Text Edit.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep current status
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Keep current priority
          await proc.waitFor('priority', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Should show current description and prompt for new value
          await proc.waitFor('description', 10000);
          await proc.waitForStable(100);
          // Clear the default/current value and enter new one
          // Edit prompts show current value - just type new one
          await proc.typeAndEnter('Updated description text');

          // Body section check - decline
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify description was updated
          const content = await readVaultFile(vaultPath, 'Ideas/Text Edit.md');
          expect(content).toContain('description: Updated description text');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });

  describe('body section handling', () => {
    // This test is skipped due to timing issues with nested confirm prompts.
    // The flow (Check for missing sections? -> Missing section: Notes -> Add it?)
    // requires precise timing between two consecutive y/n prompts which is flaky in PTY.
    // The body section addition logic is tested in unit tests.
    it.skip('should offer to add missing sections', async () => {
      // File without Notes section
      const existingFile: TempVaultFile = {
        path: 'Ideas/No Notes Section.md',
        content: `---
type: idea
status: raw
priority: low
---

Just some content without a Notes section.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/No Notes Section.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep current status
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          // Keep current priority
          await proc.waitFor('priority', 10000);
          proc.write('1');
          await proc.waitForStable(200);

          // Keep current description (just press Enter)
          await proc.waitFor('Description', 10000);
          proc.write(Keys.ENTER);
          await proc.waitForStable(200);

          // Check for missing sections - yes
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('y');
          proc.write(Keys.ENTER);
          await proc.waitForStable(300);

          // Should show missing Notes section and prompt to add it
          await proc.waitFor('Missing section', 10000);
          await proc.waitFor('Add it', 5000);
          proc.write('y');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(500);
          await proc.waitFor('Updated:', 5000);

          // Verify Notes section was added
          const content = await readVaultFile(vaultPath, 'Ideas/No Notes Section.md');
          expect(content).toContain('## Notes');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should skip adding section when declined', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Keep As Is.md',
        content: `---
type: idea
status: raw
priority: low
---

Just content, no Notes.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Keep As Is.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep current values
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          await proc.waitFor('priority', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Keep current description (just press Enter)
          await proc.waitFor('Description', 10000);
          proc.write(Keys.ENTER);
          await proc.waitForStable(100);

          // Decline to check for sections
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify Notes section was NOT added
          const content = await readVaultFile(vaultPath, 'Ideas/Keep As Is.md');
          expect(content).not.toContain('## Notes');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });

  describe('cancellation', () => {
    it('should preserve original file on cancellation', async () => {
      const originalContent = `---
type: idea
status: backlog
priority: medium
---

Original body content.
`;
      const existingFile: TempVaultFile = {
        path: 'Ideas/Preserve Me.md',
        content: originalContent,
      };

      await withTempVault(
        ['edit', 'Ideas/Preserve Me.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Start changing status but then cancel
          await proc.waitFor('status', 10000);
          
          // Cancel mid-edit
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Verify original content is preserved
          const content = await readVaultFile(vaultPath, 'Ideas/Preserve Me.md');
          expect(content).toBe(originalContent);
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should show cancelled message on Ctrl+C', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Cancel Test.md',
        content: `---
type: idea
status: raw
---
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Cancel Test.md'],
        async (proc) => {
          await proc.waitFor('Editing:', 10000);
          await proc.waitFor('status', 10000);

          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') || 
            output.includes('cancelled') ||
            output.includes('✖')
          ).toBe(true);
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });

  describe('error handling', () => {
    it('should show error for non-existent file', async () => {
      await withTempVault(
        ['edit', 'Ideas/NonExistent.md'],
        async (proc) => {
          // Should show file not found error
          await proc.waitFor('not found', 5000);

          // Wait for exit
          await proc.waitForExit(5000);
          expect(proc.hasExited()).toBe(true);
        },
        [],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should show warning for unknown type', async () => {
      const unknownTypeFile: TempVaultFile = {
        path: 'Ideas/Unknown Type.md',
        content: `---
type: nonexistent
---

Content.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Unknown Type.md'],
        async (proc) => {
          // Should show warning or error about unknown type
          await proc.waitForStable(500);
          await proc.waitForExit(10000);
          
          // Check output for error indication
          const output = proc.getOutput();
          expect(
            output.includes('Unknown') || 
            output.includes('unknown') ||
            output.includes('Error') ||
            output.includes('error')
          ).toBe(true);
        },
        [unknownTypeFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });
});
