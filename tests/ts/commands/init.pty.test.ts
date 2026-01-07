import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  shouldSkipPtyTests,
  readVaultFile,
  killAllPtyProcesses,
  spawnBowerbird,
  Keys,
  PROJECT_ROOT,
} from '../lib/pty-helpers.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

describePty('init command PTY tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a fresh temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bwrb-init-pty-'));
  });

  afterEach(async () => {
    killAllPtyProcesses();
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('interactive initialization', () => {
    it('should prompt for link format', async () => {
      const proc = spawnBowerbird(['init', tempDir], { cwd: tempDir });

      try {
        // Should prompt for link format
        await proc.waitFor('Link format', 10000);

        // Should show options
        const output = proc.getOutput();
        expect(output).toContain('wikilink');
        expect(output).toContain('markdown');

        // Select wikilink (default, first option) and continue
        proc.write(Keys.ENTER);

        // Should prompt for editor
        await proc.waitFor('Editor', 5000);

        // Skip editor (just press enter)
        proc.write(Keys.ENTER);

        // Should complete
        await proc.waitFor('Initialized bwrb vault', 5000);
        await proc.waitForExit(5000);

        // Verify schema was created with wikilink
        const schemaContent = await readVaultFile(tempDir, '.bwrb/schema.json');
        const schema = JSON.parse(schemaContent);
        expect(schema.config.link_format).toBe('wikilink');
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 25000);

    it('should allow selecting markdown link format', async () => {
      const proc = spawnBowerbird(['init', tempDir], { cwd: tempDir });

      try {
        // Wait for link format prompt
        await proc.waitFor('Link format', 10000);

        // Navigate to markdown option (second option)
        proc.write(Keys.DOWN);
        await proc.waitFor('markdown', 2000);

        // Select it
        proc.write(Keys.ENTER);

        // Skip editor prompt
        await proc.waitFor('Editor', 5000);
        proc.write(Keys.ENTER);

        // Should complete
        await proc.waitFor('Initialized bwrb vault', 5000);
        await proc.waitForExit(5000);

        // Verify schema was created with markdown
        const schemaContent = await readVaultFile(tempDir, '.bwrb/schema.json');
        const schema = JSON.parse(schemaContent);
        expect(schema.config.link_format).toBe('markdown');
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 25000);

    it('should allow entering custom editor', async () => {
      const proc = spawnBowerbird(['init', tempDir], { cwd: tempDir });

      try {
        // Wait for link format prompt and accept default
        await proc.waitFor('Link format', 10000);
        proc.write(Keys.ENTER);

        // Wait for editor prompt
        await proc.waitFor('Editor', 5000);

        // Type a custom editor
        await proc.typeText('nvim');
        proc.write(Keys.ENTER);

        // Should complete
        await proc.waitFor('Initialized bwrb vault', 5000);
        await proc.waitForExit(5000);

        // Verify schema was created with custom editor
        const schemaContent = await readVaultFile(tempDir, '.bwrb/schema.json');
        const schema = JSON.parse(schemaContent);
        expect(schema.config.editor).toBe('nvim');
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 25000);

    it('should cancel on Ctrl+C during link format selection', async () => {
      const proc = spawnBowerbird(['init', tempDir], { cwd: tempDir });

      try {
        // Wait for link format prompt
        await proc.waitFor('Link format', 10000);

        // Cancel with Ctrl+C
        proc.write(Keys.CTRL_C);

        // Should exit
        await proc.waitForExit(5000);

        // Verify no .bwrb directory was created
        const exists = await fs.access(path.join(tempDir, '.bwrb'))
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 20000);

    it('should cancel on Ctrl+C during editor prompt', async () => {
      const proc = spawnBowerbird(['init', tempDir], { cwd: tempDir });

      try {
        // Complete link format prompt
        await proc.waitFor('Link format', 10000);
        proc.write(Keys.ENTER);

        // Wait for editor prompt
        await proc.waitFor('Editor', 5000);

        // Cancel with Ctrl+C
        proc.write(Keys.CTRL_C);

        // Should exit
        await proc.waitForExit(5000);

        // Verify no .bwrb directory was created
        const exists = await fs.access(path.join(tempDir, '.bwrb'))
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 25000);
  });

  describe('force mode with existing vault', () => {
    beforeEach(async () => {
      // Create existing .bwrb/ with content
      await fs.mkdir(path.join(tempDir, '.bwrb', 'templates', 'task'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.bwrb', 'schema.json'),
        JSON.stringify({ version: 2, types: { old: {} } })
      );
      await fs.writeFile(
        path.join(tempDir, '.bwrb', 'templates', 'task', 'default.md'),
        'template content'
      );
    });

    it('should show warning and confirm before deleting', async () => {
      const proc = spawnBowerbird(['init', '--force', tempDir], { cwd: tempDir });

      try {
        // Should show warning about existing content
        await proc.waitFor('Warning', 10000);
        expect(proc.getOutput()).toContain('schema.json');
        expect(proc.getOutput()).toContain('templates');

        // Should ask for confirmation
        await proc.waitFor('Continue?', 5000);

        // Confirm with 'y'
        proc.write('y');
        proc.write(Keys.ENTER);

        // Should proceed with prompts
        await proc.waitFor('Link format', 5000);
        proc.write(Keys.ENTER);

        await proc.waitFor('Editor', 5000);
        proc.write(Keys.ENTER);

        // Should complete
        await proc.waitFor('Initialized bwrb vault', 5000);
        await proc.waitForExit(5000);

        // Verify old content was deleted
        const files = await fs.readdir(path.join(tempDir, '.bwrb'));
        expect(files).toEqual(['schema.json']);
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);

    it('should abort when user declines confirmation', async () => {
      const proc = spawnBowerbird(['init', '--force', tempDir], { cwd: tempDir });

      try {
        // Should show warning
        await proc.waitFor('Warning', 10000);

        // Should ask for confirmation
        await proc.waitFor('Continue?', 5000);

        // Decline with 'n' (or just Enter since default is no)
        proc.write('n');
        proc.write(Keys.ENTER);

        // Should abort
        await proc.waitFor('Aborted', 5000);
        await proc.waitForExit(5000);

        // Verify old content was preserved
        const schemaContent = await readVaultFile(tempDir, '.bwrb/schema.json');
        const schema = JSON.parse(schemaContent);
        expect(schema.types.old).toBeDefined();
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 25000);

    it('should skip confirmation with --force --yes', async () => {
      const proc = spawnBowerbird(['init', '--force', '--yes', tempDir], { cwd: tempDir });

      try {
        // Should NOT show warning or ask for confirmation
        // Should complete directly
        await proc.waitFor('Initialized bwrb vault', 10000);
        await proc.waitForExit(5000);

        // Verify schema was replaced
        const schemaContent = await readVaultFile(tempDir, '.bwrb/schema.json');
        const schema = JSON.parse(schemaContent);
        expect(schema.types).toEqual({});
        expect(schema.types.old).toBeUndefined();
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 20000);
  });

  describe('output messages', () => {
    it('should show next steps after successful init', async () => {
      const proc = spawnBowerbird(['init', '--yes', tempDir], { cwd: tempDir });

      try {
        await proc.waitFor('Initialized bwrb vault', 10000);
        await proc.waitForExit(5000);

        const output = proc.getOutput();
        expect(output).toContain('Next steps');
        expect(output).toContain('bwrb schema new type');
        expect(output).toContain('bwrb new');
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 15000);

    it('should show detected Obsidian vault name', async () => {
      // Create .obsidian folder to trigger detection
      await fs.mkdir(path.join(tempDir, '.obsidian'));

      const proc = spawnBowerbird(['init', '--yes', tempDir], { cwd: tempDir });

      try {
        await proc.waitFor('Initialized bwrb vault', 10000);
        await proc.waitForExit(5000);

        const output = proc.getOutput();
        expect(output).toContain('Obsidian vault');
        expect(output).toContain('auto-detected');
      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 15000);
  });
});
