import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  withTempVault,
  shouldSkipPtyTests,
  vaultFileExists,
  TempVaultFile,
} from '../lib/pty-helpers.js';
import { TEST_SCHEMA } from '../fixtures/setup.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

// Template files for the test vault
const DEFAULT_IDEA_TEMPLATE: TempVaultFile = {
  path: '.bwrb/templates/idea/default.md',
  content: `---
type: template
template-for: idea
description: Default idea template
defaults:
  status: raw
  priority: medium
---

# {title}

## Description

[Describe your idea here]
`,
};

describePty('template command PTY tests', () => {
  describe('template new (interactive)', () => {
    it('should create a template interactively', async () => {
      await withTempVault(
        ['template', 'new', 'idea'],
        async (proc, vaultPath) => {
          // Template name prompt
          await proc.waitFor('Template name', 10000);
          await proc.typeAndEnter('quick-idea');

          // Description prompt
          await proc.waitFor('Description', 5000);
          await proc.typeAndEnter('Quick idea capture');

          // Set defaults prompt
          await proc.waitFor('Set default values', 5000);
          proc.write('n');

          // Prompt fields question (should be skipped since no defaults)
          // Custom filename pattern
          await proc.waitFor('Custom filename', 5000);
          proc.write('n');

          // Wait for creation
          await proc.waitFor('Created:', 5000);

          // Verify file was created
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'quick-idea.md');
          expect(existsSync(templatePath)).toBe(true);

          const content = await readFile(templatePath, 'utf-8');
          expect(content).toContain('type: template');
          expect(content).toContain('template-for: idea');
          expect(content).toContain('Quick idea capture');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should create template with defaults', async () => {
      await withTempVault(
        ['template', 'new', 'idea'],
        async (proc, vaultPath) => {
          // Template name
          await proc.waitFor('Template name', 10000);
          await proc.typeAndEnter('with-defaults');

          // Description
          await proc.waitFor('Description', 5000);
          await proc.typeAndEnter('Template with defaults');

          // Set defaults - yes
          await proc.waitFor('Set default values', 5000);
          proc.write('y');

          // Wait for status prompt and select an option
          await proc.waitFor('status', 5000);
          proc.write('2'); // Select second option

          // Wait for priority prompt and skip
          await proc.waitFor('priority', 5000);
          proc.write('1'); // Select (skip)

          // Force prompt for fields
          await proc.waitFor('Force prompting', 5000);
          proc.write('n');

          // Custom filename pattern
          await proc.waitFor('Custom filename', 5000);
          proc.write('n');

          // Wait for creation
          await proc.waitFor('Created:', 10000);

          // Verify
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'with-defaults.md');
          expect(existsSync(templatePath)).toBe(true);

          const content = await readFile(templatePath, 'utf-8');
          expect(content).toContain('defaults:');
          expect(content).toContain('status:');
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['template', 'new', 'idea'],
        async (proc, vaultPath) => {
          await proc.waitFor('Template name', 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');

          await proc.waitFor('Cancelled', 5000);

          // Verify no file was created
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'cancelled.md');
          expect(existsSync(templatePath)).toBe(false);
        },
        { schema: TEST_SCHEMA }
      );
    }, 15000);

    it('should error on duplicate template name', async () => {
      await withTempVault(
        ['template', 'new', 'idea'],
        async (proc, vaultPath) => {
          await proc.waitFor('Template name', 10000);
          // Try to create a template that already exists
          await proc.typeAndEnter('default');

          await proc.waitFor('already exists', 5000);
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 15000);
  });

  describe('template edit (interactive)', () => {
    it('should edit template interactively', async () => {
      await withTempVault(
        ['template', 'edit', 'idea', 'default'],
        async (proc, vaultPath) => {
          // Current description shown
          await proc.waitFor('Current description:', 10000);
          await proc.waitFor('description', 5000);

          // Update description
          await proc.typeAndEnter('Updated via interactive edit');

          // Edit defaults?
          await proc.waitFor('Edit default values', 5000);
          proc.write('n');

          // Edit prompt-fields?
          await proc.waitFor('Edit prompt-fields', 5000);
          proc.write('n');

          // Edit filename pattern?
          await proc.waitFor('Edit filename pattern', 5000);
          proc.write('n');

          // Edit body?
          await proc.waitFor('Edit body', 5000);
          proc.write('n');

          await proc.waitFor('Updated:', 5000);

          // Verify update
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'default.md');
          const content = await readFile(templatePath, 'utf-8');
          expect(content).toContain('Updated via interactive edit');
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should cancel edit cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['template', 'edit', 'idea', 'default'],
        async (proc, vaultPath) => {
          // Get original content
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'default.md');
          const originalContent = await readFile(templatePath, 'utf-8');

          await proc.waitFor('Current description:', 10000);
          
          // Cancel
          proc.write('\x03');

          await proc.waitFor('Cancelled', 5000);

          // Verify file wasn't changed
          const content = await readFile(templatePath, 'utf-8');
          expect(content).toBe(originalContent);
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 15000);
  });

  describe('template delete (interactive)', () => {
    it('should delete template when confirmed with y', async () => {
      await withTempVault(
        ['template', 'delete', 'idea', 'default'],
        async (proc, vaultPath) => {
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'default.md');
          
          // Verify file exists before delete
          expect(existsSync(templatePath)).toBe(true);

          // Wait for confirmation prompt
          await proc.waitFor("Delete template 'default'", 10000);
          proc.write('y');

          // Wait for success message
          await proc.waitFor('Deleted:', 5000);

          // Verify file was deleted
          expect(existsSync(templatePath)).toBe(false);
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 15000);

    it('should not delete template when declined with n', async () => {
      await withTempVault(
        ['template', 'delete', 'idea', 'default'],
        async (proc, vaultPath) => {
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'default.md');
          
          // Verify file exists before
          expect(existsSync(templatePath)).toBe(true);

          // Wait for confirmation prompt
          await proc.waitFor("Delete template 'default'", 10000);
          proc.write('n');

          // Wait for cancellation message
          await proc.waitFor('Cancelled', 5000);

          // Verify file still exists
          expect(existsSync(templatePath)).toBe(true);
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 15000);

    it('should cancel delete on Ctrl+C', async () => {
      await withTempVault(
        ['template', 'delete', 'idea', 'default'],
        async (proc, vaultPath) => {
          const templatePath = join(vaultPath, '.bwrb/templates/idea', 'default.md');
          
          // Verify file exists before
          expect(existsSync(templatePath)).toBe(true);

          // Wait for confirmation prompt
          await proc.waitFor("Delete template 'default'", 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');

          await proc.waitFor('Cancelled', 5000);

          // Verify file still exists
          expect(existsSync(templatePath)).toBe(true);
        },
        { files: [DEFAULT_IDEA_TEMPLATE], schema: TEST_SCHEMA }
      );
    }, 15000);
  });
});
