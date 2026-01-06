import { describe, it, expect, afterEach } from 'vitest';
import {
  withTempVault,
  shouldSkipPtyTests,
  readVaultFile,
  killAllPtyProcesses,
  Keys,
} from '../lib/pty-helpers.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

// Minimal schema for config tests
const CONFIG_TEST_SCHEMA = {
  version: 2,
  types: {
    meta: {},
    note: {
      extends: 'meta',
      output_dir: 'Notes',
      fields: {
        type: { value: 'note' },
      },
    },
  },
};

describePty('config command PTY tests', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  describe('config edit (interactive option picker)', () => {
    it('should show option picker when no option specified', async () => {
      await withTempVault(
        ['config', 'edit'],
        async (proc, _vaultPath) => {
          // Should prompt for which option to edit
          await proc.waitFor('Select option to edit', 10000);

          // Should show available options
          expect(proc.getOutput()).toContain('link_format');
          expect(proc.getOutput()).toContain('editor');
          expect(proc.getOutput()).toContain('open_with');

          // Cancel with Ctrl+C
          proc.write(Keys.CTRL_C);
          await proc.waitForExit(5000);
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 20000);

    it('should edit enum option (link_format) interactively', async () => {
      await withTempVault(
        ['config', 'edit', 'link_format'],
        async (proc, vaultPath) => {
          // Should show current value and options
          await proc.waitFor('Link Format', 10000);

          // Navigate to 'markdown' option
          // Options are: wikilink, markdown
          // Press down to select markdown
          proc.write(Keys.DOWN);
          await proc.waitFor('markdown', 2000);

          // Select it
          proc.write(Keys.ENTER);

          // Wait for completion
          await proc.waitFor('Set link_format', 5000);
          await proc.waitForExit(5000);

          // Verify the change was persisted
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.config.link_format).toBe('markdown');
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 20000);

    it('should edit enum option (open_with) interactively', async () => {
      await withTempVault(
        ['config', 'edit', 'open_with'],
        async (proc, vaultPath) => {
          // Should show current value and options
          await proc.waitFor('Open With', 10000);

          // Options are: system, editor, visual, obsidian
          // Navigate to 'obsidian'
          proc.write(Keys.DOWN); // editor
          proc.write(Keys.DOWN); // visual
          proc.write(Keys.DOWN); // obsidian
          await proc.waitFor('obsidian', 2000);

          // Select it
          proc.write(Keys.ENTER);

          // Wait for completion
          await proc.waitFor('Set open_with', 5000);
          await proc.waitForExit(5000);

          // Verify the change was persisted
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.config.open_with).toBe('obsidian');
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 20000);

    it('should cancel on Ctrl+C during option selection', async () => {
      await withTempVault(
        ['config', 'edit', 'link_format'],
        async (proc, vaultPath) => {
          // Wait for the option picker
          await proc.waitFor('Link Format', 10000);

          // Cancel
          proc.write(Keys.CTRL_C);
          await proc.waitForExit(5000);

          // Verify no config was created
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.config).toBeUndefined();
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 20000);
  });

  describe('config edit (string option smoke test)', () => {
    it('should show menu for string options', async () => {
      await withTempVault(
        ['config', 'edit', 'editor'],
        async (proc, _vaultPath) => {
          // Should show menu with options
          await proc.waitFor('Editor', 10000);

          // Should show the limited menu options
          const output = proc.getOutput();
          expect(output).toContain('keep current');
          expect(output).toContain('clear');

          // Cancel
          proc.write(Keys.CTRL_C);
          await proc.waitForExit(5000);
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 20000);

    it('should clear string option when "(clear)" is selected', async () => {
      // Start with a vault that has editor set
      const schemaWithEditor = {
        ...CONFIG_TEST_SCHEMA,
        config: {
          editor: 'existing-editor',
        },
      };

      await withTempVault(
        ['config', 'edit', 'editor'],
        async (proc, vaultPath) => {
          // Wait for the menu
          await proc.waitFor('Editor', 10000);

          // Navigate to "(clear)" option
          proc.write(Keys.DOWN); // from "(keep current)" to "(clear)"
          await proc.waitFor('clear', 2000);

          // Select it
          proc.write(Keys.ENTER);

          // Wait for completion
          await proc.waitFor('Cleared editor', 5000);
          await proc.waitForExit(5000);

          // Verify the value was cleared
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.config.editor).toBeUndefined();
        },
        { schema: schemaWithEditor }
      );
    }, 20000);
  });

  describe('config edit (full flow from picker)', () => {
    it('should pick option from menu and edit value', async () => {
      await withTempVault(
        ['config', 'edit'],
        async (proc, vaultPath) => {
          // Wait for option picker
          await proc.waitFor('Select option to edit', 10000);

          // Type 'l' to filter/jump to link_format
          proc.write('l');
          await proc.waitFor('link_format', 2000);

          // Select it
          proc.write(Keys.ENTER);

          // Now we should see the link_format value picker
          await proc.waitFor('Link Format', 5000);

          // Navigate to 'markdown' and select
          proc.write(Keys.DOWN);
          await proc.waitFor('markdown', 2000);
          proc.write(Keys.ENTER);

          // Wait for completion
          await proc.waitFor('Set link_format', 5000);
          await proc.waitForExit(5000);

          // Verify the change was persisted
          const schemaContent = await readVaultFile(vaultPath, '.bwrb/schema.json');
          const schema = JSON.parse(schemaContent);
          expect(schema.config.link_format).toBe('markdown');
        },
        { schema: CONFIG_TEST_SCHEMA }
      );
    }, 25000);
  });
});
