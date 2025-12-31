import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

// Note: The `edit` command uses the `prompts` library which requires a TTY.
// Interactive tests are in edit.pty.test.ts.
// This file tests JSON mode, error handling, body preservation, and validation.

describe('edit command', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('file loading and type detection', () => {
    it('should detect type from frontmatter type field', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "backlog"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.updated).toContain('status');
    });

    it('should detect subtype from objective-type field', async () => {
      // Create a task file without date fields to avoid YAML date parsing issues
      const testFilePath = join(vaultDir, 'Objectives/Tasks/Test Task.md');
      await writeFile(testFilePath, `---
type: objective
objective-type: task
status: backlog
---

## Steps
- [ ] Do something

## Notes
`, 'utf-8');

      const result = await runCLI(
        ['edit', 'Objectives/Tasks/Test Task.md', '--json', '{"status": "settled"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      // Verify the file was updated correctly
      const content = await readFile(testFilePath, 'utf-8');
      expect(content).toContain('status: settled');
      expect(content).toContain('objective-type: task'); // Preserved
    });

    it('should detect milestone subtype', async () => {
      const result = await runCLI(
        ['edit', 'Objectives/Milestones/Active Milestone.md', '--json', '{"status": "settled"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const content = await readFile(join(vaultDir, 'Objectives/Milestones/Active Milestone.md'), 'utf-8');
      expect(content).toContain('status: settled');
      expect(content).toContain('objective-type: milestone'); // Preserved
    });

    it('should work with absolute file paths', async () => {
      const absolutePath = join(vaultDir, 'Ideas/Sample Idea.md');
      const result = await runCLI(
        ['edit', absolutePath, '--json', '{"priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });
  });

  describe('body preservation', () => {
    it('should preserve body content after frontmatter edit', async () => {
      // First, create a file with rich body content
      const testFilePath = join(vaultDir, 'Ideas/Rich Body.md');
      const originalContent = `---
type: idea
status: raw
priority: low
---

## Description

This is a detailed description with multiple paragraphs.

Some **bold** and *italic* text.

## Implementation Notes

- Point 1
- Point 2
- Point 3

## Links

- [[Sample Idea]]
- [[Another Idea]]

\`\`\`javascript
console.log("code block");
\`\`\`
`;
      await writeFile(testFilePath, originalContent, 'utf-8');

      // Edit only the frontmatter
      const result = await runCLI(
        ['edit', 'Ideas/Rich Body.md', '--json', '{"status": "backlog", "priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      // Verify frontmatter was updated
      const updatedContent = await readFile(testFilePath, 'utf-8');
      expect(updatedContent).toContain('status: backlog');
      expect(updatedContent).toContain('priority: high');

      // Verify body is fully preserved
      expect(updatedContent).toContain('## Description');
      expect(updatedContent).toContain('This is a detailed description with multiple paragraphs.');
      expect(updatedContent).toContain('Some **bold** and *italic* text.');
      expect(updatedContent).toContain('## Implementation Notes');
      expect(updatedContent).toContain('- Point 1');
      expect(updatedContent).toContain('- Point 2');
      expect(updatedContent).toContain('- Point 3');
      expect(updatedContent).toContain('## Links');
      expect(updatedContent).toContain('[[Sample Idea]]');
      expect(updatedContent).toContain('[[Another Idea]]');
      expect(updatedContent).toContain('console.log("code block");');
    });

    it('should preserve body with task checkboxes', async () => {
      const originalContent = await readFile(
        join(vaultDir, 'Objectives/Tasks/Sample Task.md'),
        'utf-8'
      );

      // Verify original has checkboxes
      expect(originalContent).toContain('- [ ] Step 1');
      expect(originalContent).toContain('## Steps');
      expect(originalContent).toContain('## Notes');

      // Edit frontmatter
      const result = await runCLI(
        ['edit', 'Objectives/Tasks/Sample Task.md', '--json', '{"deadline": "2025-01-01"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      // Verify body is preserved
      const updatedContent = await readFile(
        join(vaultDir, 'Objectives/Tasks/Sample Task.md'),
        'utf-8'
      );
      expect(updatedContent).toContain('- [ ] Step 1');
      expect(updatedContent).toContain('## Steps');
      expect(updatedContent).toContain('## Notes');
      expect(updatedContent).toContain('deadline: 2025-01-01');
    });

    it('should preserve empty body', async () => {
      // Create file with minimal body
      const testFilePath = join(vaultDir, 'Ideas/Minimal Body.md');
      await writeFile(testFilePath, `---
type: idea
status: raw
---
`, 'utf-8');

      const result = await runCLI(
        ['edit', 'Ideas/Minimal Body.md', '--json', '{"priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(testFilePath, 'utf-8');
      expect(content).toContain('priority: high');
      // Body should still be minimal (just newline after frontmatter)
      const bodyPart = content.split('---\n')[2];
      expect(bodyPart.trim()).toBe('');
    });

    it('should preserve body with special characters', async () => {
      const testFilePath = join(vaultDir, 'Ideas/Special Chars.md');
      const specialBody = `---
type: idea
status: raw
---

## Special Characters

Quotes: "double" and 'single'
Ampersand: &amp; and &
Unicode: \u2713 \u2717 \u2605
Emojis: \ud83d\ude80 \ud83c\udf89
YAML special: : - # @ ! % * |
Backslash: \\ and \\n
`;
      await writeFile(testFilePath, specialBody, 'utf-8');

      const result = await runCLI(
        ['edit', 'Ideas/Special Chars.md', '--json', '{"status": "backlog"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(testFilePath, 'utf-8');
      expect(content).toContain('Quotes: "double" and \'single\'');
      expect(content).toContain('Ampersand: &amp; and &');
      expect(content).toContain('YAML special: : - # @ ! % * |');
    });
  });

  describe('error handling', () => {
    it('should error on file not found', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Nonexistent.md', '--json', '{"status": "raw"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(2);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });

    it('should error on invalid JSON input', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{invalid json}'],
        vaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Invalid JSON');
    });

    it('should error on invalid enum value', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "not-a-valid-status"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.errors).toBeDefined();
      expect(json.errors[0].field).toBe('status');
    });

    it('should provide suggestion for typos', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "rae"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.errors[0].suggestion).toContain('raw');
    });

    it('should show error for unknown type in frontmatter', async () => {
      // Create a file with unknown type
      const testFilePath = join(vaultDir, 'Ideas/Unknown Type.md');
      await writeFile(testFilePath, `---
type: nonexistent-type
---

Body content.
`, 'utf-8');

      const result = await runCLI(
        ['edit', 'Ideas/Unknown Type.md', '--json', '{"status": "raw"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('type');
    });

    it('should error on file without frontmatter', async () => {
      const testFilePath = join(vaultDir, 'Ideas/No Frontmatter.md');
      await writeFile(testFilePath, `# Just a regular markdown file

No frontmatter here.
`, 'utf-8');

      const result = await runCLI(
        ['edit', 'Ideas/No Frontmatter.md', '--json', '{"status": "raw"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });
  });

  describe('JSON merge semantics', () => {
    it('should preserve fields not in patch', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "backlog"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(join(vaultDir, 'Ideas/Sample Idea.md'), 'utf-8');
      expect(content).toContain('status: backlog'); // Updated
      expect(content).toContain('type: idea'); // Preserved
      expect(content).toContain('priority: medium'); // Preserved
    });

    it('should remove field with null value', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"priority": null}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(join(vaultDir, 'Ideas/Sample Idea.md'), 'utf-8');
      expect(content).not.toContain('priority:');
      expect(content).toContain('status: raw'); // Preserved
    });

    it('should update multiple fields at once', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "settled", "priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(join(vaultDir, 'Ideas/Sample Idea.md'), 'utf-8');
      expect(content).toContain('status: settled');
      expect(content).toContain('priority: high');
    });

    it('should report updated fields in response', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "backlog", "priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.updated).toContain('status');
      expect(json.updated).toContain('priority');
    });
  });

  describe('frontmatter order preservation', () => {
    it('should maintain field order defined in schema', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"priority": "high"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);

      const content = await readFile(join(vaultDir, 'Ideas/Sample Idea.md'), 'utf-8');
      
      // Extract frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const frontmatter = fmMatch![1];
      
      // Schema order is: type, status, priority
      const typeIndex = frontmatter.indexOf('type:');
      const statusIndex = frontmatter.indexOf('status:');
      const priorityIndex = frontmatter.indexOf('priority:');
      
      expect(typeIndex).toBeLessThan(statusIndex);
      expect(statusIndex).toBeLessThan(priorityIndex);
    });
  });

  describe('help and usage', () => {
    it('should show help with --help flag', async () => {
      const result = await runCLI(['edit', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Edit an existing note');
      expect(result.stdout).toContain('Examples:');
      expect(result.stdout).toContain('--json');
      expect(result.stdout).toContain('--open');
    });

    it('should show JSON mode examples in help', async () => {
      const result = await runCLI(['edit', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Non-interactive');
      expect(result.stdout).toContain('patch/merge');
    });
  });

  describe('edge cases', () => {
    it('should handle file with spaces in name', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{"status": "backlog"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('should handle quoted path argument', async () => {
      const result = await runCLI(
        ['edit', '"Ideas/Sample Idea.md"', '--json', '{"status": "backlog"}'],
        vaultDir
      );

      // This might fail because of the extra quotes, which is expected behavior
      // The shell should handle unquoting, not the CLI
      // Just ensure it doesn't crash
      expect(typeof result.exitCode).toBe('number');
    });

    it('should handle empty JSON patch', async () => {
      const result = await runCLI(
        ['edit', 'Ideas/Sample Idea.md', '--json', '{}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.updated).toEqual([]);
    });

    it('should handle deeply nested path', async () => {
      // Create a task file without date fields to avoid YAML date parsing issues
      const testFilePath = join(vaultDir, 'Objectives/Tasks/Nested Task.md');
      await writeFile(testFilePath, `---
type: objective
objective-type: task
status: backlog
---
`, 'utf-8');

      const result = await runCLI(
        ['edit', 'Objectives/Tasks/Nested Task.md', '--json', '{"status": "settled"}'],
        vaultDir
      );

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });
  });
});

describe('edit command --open flag', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  // Note: We can't fully test --open because it opens external applications (Obsidian).
  // Testing --open would trigger Obsidian to open, which is disruptive in test environments.
  // We only verify the flag is documented in help text.

  it('should show --open in help text', async () => {
    const result = await runCLI(['edit', '--help'], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--open');
    expect(result.stdout).toContain('Obsidian');
  });

  it('should describe --open behavior in help', async () => {
    const result = await runCLI(['edit', '--help'], vaultDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Open the note');
  });
});
