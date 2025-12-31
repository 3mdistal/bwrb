/**
 * PTY-based tests for relative vault path handling.
 *
 * These tests verify that interactive commands work correctly when
 * the vault is specified via a relative path.
 */

import { describe, it, expect } from 'vitest';
import {
  withTempVaultRelative,
  vaultFileExists,
  readVaultFile,
  shouldSkipPtyTests,
} from '../lib/pty-helpers.js';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests() ? describe.skip : describe;

// Schema for testing
const TEST_SCHEMA = {
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
      },
      frontmatter_order: ['type', 'status', 'priority'],
    },
  },
};

describePty('relative vault path PTY tests', () => {
  describe('new command with relative vault path', () => {
    it('should create note interactively with relative vault path', async () => {
      await withTempVaultRelative(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Relative Path Interactive Test');

          // Status selection - (skip) is first option, which uses default
          await proc.waitFor('status', 10000);
          proc.write('1'); // Skip - uses default 'raw'

          // Priority selection - (skip)
          await proc.waitFor('priority', 10000);
          proc.write('1'); // Skip

          // Wait for creation message
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created
          const exists = await vaultFileExists(vaultPath, 'Ideas/Relative Path Interactive Test.md');
          expect(exists).toBe(true);

          // Verify content
          const content = await readVaultFile(vaultPath, 'Ideas/Relative Path Interactive Test.md');
          expect(content).toContain('type: idea');
          expect(content).toContain('status: raw');
        },
        [],
        TEST_SCHEMA
      );
    }, 30000);

    it('should complete full prompts with relative vault path', async () => {
      await withTempVaultRelative(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Full Prompts Relative');

          // Status selection - select 'backlog' (option 3)
          await proc.waitFor('status', 10000);
          proc.write('3'); // Select 'backlog'

          // Priority selection - select 'high' (option 4)
          await proc.waitFor('priority', 10000);
          proc.write('4'); // Select 'high'

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file exists with correct content
          const exists = await vaultFileExists(vaultPath, 'Ideas/Full Prompts Relative.md');
          expect(exists).toBe(true);

          const content = await readVaultFile(vaultPath, 'Ideas/Full Prompts Relative.md');
          expect(content).toContain('type: idea');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: high');
        },
        [],
        TEST_SCHEMA
      );
    }, 30000);

    it('should show correct output paths with relative vault', async () => {
      await withTempVaultRelative(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Complete the flow
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Path Display Test');

          await proc.waitFor('status', 10000);
          proc.write('1');

          await proc.waitFor('priority', 10000);
          proc.write('1');

          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // The output should contain the file path
          const output = proc.getOutput();
          expect(output).toContain('Path Display Test');
          expect(output).toContain('Created:');

          // File should actually exist
          const exists = await vaultFileExists(vaultPath, 'Ideas/Path Display Test.md');
          expect(exists).toBe(true);
        },
        [],
        TEST_SCHEMA
      );
    }, 30000);
  });

  describe('type navigation with relative vault path', () => {
    it('should prompt for type with relative vault path', async () => {
      await withTempVaultRelative(
        ['new'],
        async (proc) => {
          // Should prompt for top-level type selection
          await proc.waitFor('What would you like to create', 10000);

          // Should show available types
          const output = proc.getOutput();
          expect(output).toContain('idea');

          // Cancel
          proc.write('\x03'); // Ctrl+C
          await proc.waitForExit(5000);
        },
        [],
        TEST_SCHEMA
      );
    }, 30000);
  });

  describe('cancellation with relative vault path', () => {
    it('should cancel cleanly - no file created', async () => {
      await withTempVaultRelative(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);

          // Type partial name then cancel
          await proc.typeText('Partial');
          proc.write('\x03'); // Ctrl+C

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(output.includes('Cancelled') || output.includes('cancelled')).toBe(true);

          // Verify no files created
          const exists = await vaultFileExists(vaultPath, 'Ideas/Partial.md');
          expect(exists).toBe(false);
        },
        [],
        TEST_SCHEMA
      );
    }, 30000);
  });
});
