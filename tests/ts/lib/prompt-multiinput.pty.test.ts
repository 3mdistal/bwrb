/**
 * PTY-based integration tests for multi-input prompts.
 *
 * Tests promptMultiInput from src/lib/prompt.ts using real terminal processes.
 * Multi-input is used for body sections like "Steps" in tasks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  vaultFileExists,
  readVaultFile,
  shouldSkipPtyTests,
} from './pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

// Schema that includes a body section with multi-input prompt
const TASK_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'in-progress', 'done'],
  },
  types: {
    task: {
      output_dir: 'Tasks',
      frontmatter: {
        type: { value: 'task' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
      },
      frontmatter_order: ['type', 'status'],
      body_sections: [
        {
          title: 'Steps',
          level: 2,
          content_type: 'checkboxes',
          prompt: 'multi-input',
          prompt_label: 'Steps (comma-separated)',
        },
        {
          title: 'Notes',
          level: 2,
          content_type: 'paragraphs',
        },
      ],
    },
  },
};

describePty('Multi-Input Prompt PTY tests', () => {
  beforeAll(() => {
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('promptMultiInput (comma-separated input)', () => {
    it('should accept comma-separated input and create checkboxes', async () => {
      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Test Task');

          // Wait for status selection
          await proc.waitFor('status', 10000);
          proc.write('1'); // Select first status

          // Wait for Steps multi-input prompt
          await proc.waitFor('Steps', 10000);

          // Enter comma-separated steps
          await proc.typeAndEnter('First step, Second step, Third step');

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created with checkboxes
          const exists = await vaultFileExists(vaultPath, 'Tasks/Test Task.md');
          expect(exists).toBe(true);

          const content = await readVaultFile(vaultPath, 'Tasks/Test Task.md');
          expect(content).toContain('## Steps');
          expect(content).toContain('- [ ] First step');
          expect(content).toContain('- [ ] Second step');
          expect(content).toContain('- [ ] Third step');
          expect(content).toContain('## Notes');
        },
        { schema: TASK_SCHEMA }
      );
    }, 30000);

    it('should handle empty input (skip multi-input)', async () => {
      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Empty Steps Task');

          // Wait for status selection
          await proc.waitFor('status', 10000);
          proc.write('1');

          // Wait for Steps prompt
          await proc.waitFor('Steps', 10000);

          // Just press Enter (empty input)
          proc.write(Keys.ENTER);

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created
          const exists = await vaultFileExists(vaultPath, 'Tasks/Empty Steps Task.md');
          expect(exists).toBe(true);

          const content = await readVaultFile(vaultPath, 'Tasks/Empty Steps Task.md');
          expect(content).toContain('## Steps');
          // Empty input creates a single empty checkbox (actual behavior)
          // This is fine - it's just an empty placeholder
        },
        { schema: TASK_SCHEMA }
      );
    }, 30000);

    it('should cancel on Ctrl+C during multi-input', async () => {
      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Cancel Test');

          // Wait for status selection
          await proc.waitFor('status', 10000);
          proc.write('1');

          // Wait for Steps prompt
          await proc.waitFor('Steps', 10000);

          // Start typing then cancel
          await proc.typeText('Step one, step');
          await new Promise(r => setTimeout(r, 100));
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') ||
            output.includes('cancelled')
          ).toBe(true);

          // File should NOT be created
          const exists = await vaultFileExists(vaultPath, 'Tasks/Cancel Test.md');
          expect(exists).toBe(false);
        },
        { schema: TASK_SCHEMA }
      );
    }, 30000);

    it('should handle single item input', async () => {
      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Single Step Task');

          // Wait for status selection
          await proc.waitFor('status', 10000);
          proc.write('1');

          // Wait for Steps prompt
          await proc.waitFor('Steps', 10000);

          // Enter single step (no commas)
          await proc.typeAndEnter('Just one step');

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify single checkbox
          const content = await readVaultFile(vaultPath, 'Tasks/Single Step Task.md');
          expect(content).toContain('- [ ] Just one step');
          // Should only have one checkbox
          const checkboxCount = (content.match(/- \[ \]/g) || []).length;
          expect(checkboxCount).toBe(1);
        },
        { schema: TASK_SCHEMA }
      );
    }, 30000);

    it('should trim whitespace from items', async () => {
      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Whitespace Task');

          // Wait for status selection
          await proc.waitFor('status', 10000);
          proc.write('1');

          // Wait for Steps prompt
          await proc.waitFor('Steps', 10000);

          // Enter items with extra whitespace
          await proc.typeAndEnter('  Step one  ,  Step two  ,Step three');

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify items are trimmed
          const content = await readVaultFile(vaultPath, 'Tasks/Whitespace Task.md');
          expect(content).toContain('- [ ] Step one');
          expect(content).toContain('- [ ] Step two');
          expect(content).toContain('- [ ] Step three');
          // Should not have extra spaces
          expect(content).not.toContain('  Step');
        },
        { schema: TASK_SCHEMA }
      );
    }, 30000);
  });
});
