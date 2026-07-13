import { afterEach, describe, expect, it } from 'vitest';
import {
  killAllPtyProcesses,
  shouldSkipPtyTests,
  withTempVault,
} from '../lib/pty-helpers.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

const TEST_SCHEMA = {
  version: 2,
  types: {
    note: {
      output_dir: 'Notes',
      fields: {
        type: { value: 'note' },
        name: { prompt: 'text' },
      },
    },
  },
};

const UNIQUE_NOTE = {
  path: 'Notes/note-00000.md',
  content: '---\ntype: note\nname: "note 00000"\n---\n',
};

describePty('list --name non-interactive output', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  it('prints a unique frontmatter-name path and exits with stdin held open', async () => {
    await withTempVault(
      ['list', '--name', 'note 00000', '--output', 'paths'],
      async (proc) => {
        expect(await proc.waitForExit(5000)).toBe(0);
        expect(proc.getOutput().trim()).toBe('Notes/note-00000.md');
        expect(proc.getRawOutput()).not.toContain('fzf');
      },
      { schema: TEST_SCHEMA, files: [UNIQUE_NOTE] }
    );
  }, 10000);

  it('opens a unique frontmatter name through the print app and exits', async () => {
    await withTempVault(
      ['list', '--name', 'note 00000', '--open', '--app', 'print'],
      async (proc, vaultPath) => {
        expect(await proc.waitForExit(5000)).toBe(0);
        expect(proc.getOutput().trim()).toBe(`${vaultPath}/Notes/note-00000.md`);
      },
      { schema: TEST_SCHEMA, files: [UNIQUE_NOTE] }
    );
  }, 10000);
});
