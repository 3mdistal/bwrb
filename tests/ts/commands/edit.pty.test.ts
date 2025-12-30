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
description: Original description
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

          // Should show type path
          await proc.waitFor('Type path:', 10000);

          // Should show current status value
          await proc.waitFor('Current status:', 10000);
          const statusOutput = proc.getOutput();
          expect(statusOutput).toContain('backlog');

          // Keep current value (select first option - keep current)
          proc.write('1');
          await proc.waitForStable(100);

          // Should show current priority
          await proc.waitFor('Current priority:', 10000);
          // Keep current
          proc.write('1');
          await proc.waitForStable(100);

          // Description (text input)
          await proc.waitFor('Current description:', 10000);
          // Press Enter to keep current
          proc.write(Keys.ENTER);
          await proc.waitForStable(100);

          // Body sections check
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify values were preserved
          const content = await readVaultFile(vaultPath, 'Ideas/Existing Idea.md');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: high');
          expect(content).toContain('description: Original description');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);

    it('should update field value when different option selected', async () => {
      const existingFile: TempVaultFile = {
        path: 'Ideas/Change Me.md',
        content: `---
type: idea
status: raw
priority: low
---
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Change Me.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Change status from 'raw' to 'in-flight' (option 4)
          await proc.waitFor('Current status:', 10000);
          proc.write('4'); // Select 'in-flight'
          await proc.waitForStable(100);

          // Change priority from 'low' to 'high' (option 4)
          await proc.waitFor('Current priority:', 10000);
          proc.write('4'); // Select 'high'
          await proc.waitForStable(100);

          // Skip body sections check
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify values were changed
          const content = await readVaultFile(vaultPath, 'Ideas/Change Me.md');
          expect(content).toContain('status: in-flight');
          expect(content).toContain('priority: high');
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
description: Old description
---
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Text Edit.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep status
          await proc.waitFor('Current status:', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Keep priority
          await proc.waitFor('Current priority:', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Change description - current value is shown as default
          await proc.waitFor('Current description:', 10000);
          
          // Type new description (should replace the default)
          await proc.typeAndEnter('New and improved description');

          // Skip body sections
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify new description
          const content = await readVaultFile(vaultPath, 'Ideas/Text Edit.md');
          expect(content).toContain('description: New and improved description');
        },
        [existingFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });

  describe('body section handling', () => {
    it('should offer to add missing sections', async () => {
      // File without Notes section
      const existingFile: TempVaultFile = {
        path: 'Ideas/Missing Section.md',
        content: `---
type: idea
status: raw
---

Just some content without proper sections.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Missing Section.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep all field values
          await proc.waitFor('Current status:', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          await proc.waitFor('Current priority:', 10000);
          proc.write('1');
          await proc.waitForStable(100);

          // Say yes to check for missing sections
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should detect missing Notes section
          await proc.waitFor('Missing section: Notes', 5000);
          await proc.waitFor('Add it?', 5000);

          // Say yes to add it
          proc.write('y');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify section was added
          const content = await readVaultFile(vaultPath, 'Ideas/Missing Section.md');
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
---

My content.
`,
      };

      await withTempVault(
        ['edit', 'Ideas/Keep As Is.md'],
        async (proc, vaultPath) => {
          await proc.waitFor('Editing:', 10000);

          // Keep fields
          await proc.waitFor('Current status:', 10000);
          proc.write('1');
          await proc.waitFor('Current priority:', 10000);
          proc.write('1');

          // Say yes to check for missing sections
          await proc.waitFor('Check for missing sections', 10000);
          proc.write('y');
          proc.write(Keys.ENTER);

          // Should detect missing Notes section
          await proc.waitFor('Missing section: Notes', 5000);
          await proc.waitFor('Add it?', 5000);

          // Say no
          proc.write('n');
          proc.write(Keys.ENTER);

          // Wait for update
          await proc.waitForStable(200);
          await proc.waitFor('Updated:', 5000);

          // Verify section was NOT added
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
          await proc.waitFor('Current status:', 10000);
          
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
          await proc.waitFor('Current status:', 10000);

          proc.write(Keys.CTRL_C);

          await proc.waitForExit(5000);

          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') || output.includes('cancelled')
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
          // Should show warning about unknown type
          await proc.waitFor('Unknown type', 10000);

          // Should show raw frontmatter
          const output = proc.getOutput();
          expect(output).toContain('frontmatter');

          // Process should handle gracefully
          await proc.waitForExit(10000);
        },
        [unknownTypeFile],
        EDIT_SCHEMA
      );
    }, 30000);
  });
});
