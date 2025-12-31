/**
 * PTY-based integration tests for text input prompts.
 *
 * Tests promptInput and promptRequired from src/lib/prompt.ts
 * using real terminal processes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  spawnOvault,
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  vaultFileExists,
  readVaultFile,
  MINIMAL_SCHEMA,
  shouldSkipPtyTests,
} from './pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

describePty('Text Input Prompt PTY tests', () => {
  beforeAll(() => {
    // Verify test vault exists
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('promptRequired (required text input)', () => {
    it('should accept text input and submit on Enter', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for the name prompt (idea name is required)
          await proc.waitFor('Name', 10000);

          // Type a name and press Enter
          await proc.typeAndEnter('My Test Idea');

          // Wait for the status selection prompt (next step)
          await proc.waitFor('status', 10000);

          // Select status to continue
          proc.write('1');
          await proc.waitFor('priority', 10000);

          // Select priority
          proc.write('1');

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify the file was created
          const exists = await vaultFileExists(vaultPath, 'Ideas/My Test Idea.md');
          expect(exists).toBe(true);
        }
      );
    }, 30000);

    it('should show validation error on empty required input', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc) => {
          // Wait for the name prompt
          await proc.waitFor('Name', 10000);

          // Press Enter without typing anything
          proc.write(Keys.ENTER);

          // The prompt should show "required" indicator and stay on same prompt
          await proc.waitForStable(200);

          // Should still be asking for the name
          // The prompts library shows validation messages
          const output = proc.getOutput();
          expect(output).toContain('required');

          // Clean up
          proc.write(Keys.CTRL_C);
          await proc.waitForExit(5000);
        }
      );
    }, 30000);

    it('should cancel on Ctrl+C during required input', async () => {
      const proc = spawnOvault(['new', 'idea'], { cwd: TEST_VAULT_PATH });

      try {
        // Wait for the name prompt
        await proc.waitFor('Name', 10000);

        // Press Ctrl+C to cancel
        proc.write(Keys.CTRL_C);

        // Wait for process to exit
        await proc.waitForExit(5000);

        // Should show cancellation message
        const output = proc.getOutput();
        expect(
          output.includes('Cancelled') ||
          output.includes('cancelled')
        ).toBe(true);

        expect(proc.hasExited()).toBe(true);
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);
  });

  describe('promptInput (optional text input)', () => {
    it('should accept empty input for optional fields', async () => {
      // Schema with deadline as optional input field
      const schema = {
        ...MINIMAL_SCHEMA,
        types: {
          task: {
            output_dir: 'Tasks',
            frontmatter: {
              type: { value: 'task' },
              deadline: { prompt: 'input', label: 'Deadline' },
            },
            frontmatter_order: ['type', 'deadline'],
          },
        },
      };

      await withTempVault(
        ['new', 'task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Test Task');

          // Wait for deadline prompt (optional)
          await proc.waitFor('Deadline', 10000);

          // Just press Enter to skip (empty is valid for optional)
          proc.write(Keys.ENTER);

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file exists
          const exists = await vaultFileExists(vaultPath, 'Tasks/Test Task.md');
          expect(exists).toBe(true);
        },
        { schema: schema }
      );
    }, 30000);

    it('should use default value when Enter is pressed', async () => {
      // Schema with a default value for an optional field
      const schema = {
        ...MINIMAL_SCHEMA,
        types: {
          note: {
            output_dir: 'Notes',
            frontmatter: {
              type: { value: 'note' },
              category: { prompt: 'input', label: 'Category', default: 'general' },
            },
            frontmatter_order: ['type', 'category'],
          },
        },
      };

      await withTempVault(
        ['new', 'note'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);
          await proc.typeAndEnter('Test Note');

          // Wait for category prompt
          await proc.waitFor('Category', 10000);

          // Just press Enter to accept default
          proc.write(Keys.ENTER);

          // Wait for file creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file exists and has default value
          const exists = await vaultFileExists(vaultPath, 'Notes/Test Note.md');
          expect(exists).toBe(true);

          const content = await readVaultFile(vaultPath, 'Notes/Test Note.md');
          expect(content).toContain('category: general');
        },
        { schema: schema }
      );
    }, 30000);
  });

  describe('text editing during input', () => {
    it('should handle backspace correctly', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Name', 10000);

          // Type some text, then backspace and correct
          await proc.typeText('Test Ideaa');
          await new Promise(r => setTimeout(r, 50));
          proc.write(Keys.BACKSPACE);
          await new Promise(r => setTimeout(r, 50));
          proc.write(Keys.ENTER);

          // Wait for next prompt
          await proc.waitFor('status', 10000);

          // Complete the rest of the prompts
          proc.write('1'); // status
          await proc.waitFor('priority', 10000);
          proc.write('1'); // priority

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Should have created file with corrected name
          const exists = await vaultFileExists(vaultPath, 'Ideas/Test Idea.md');
          expect(exists).toBe(true);
        }
      );
    }, 30000);
  });
});
