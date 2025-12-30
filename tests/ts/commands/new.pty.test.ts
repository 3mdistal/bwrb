/**
 * PTY-based integration tests for the `ovault new` command.
 *
 * Tests full command flows including type navigation, template selection,
 * and cancellation behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  spawnOvault,
  withTempVault,
  Keys,
  TEST_VAULT_PATH,
  vaultFileExists,
  readVaultFile,
  listVaultFiles,
  TempVaultFile,
  shouldSkipPtyTests,
} from '../lib/pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support or node-pty is incompatible
const describePty = shouldSkipPtyTests()
  ? describe.skip
  : describe;

// Full schema for testing new command flows
const FULL_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  dynamic_sources: {
    active_milestones: {
      dir: 'Milestones',
      filter: { status: { not_in: ['settled'] } },
    },
  },
  types: {
    objective: {
      output_dir: 'Objectives',
      subtypes: {
        task: {
          output_dir: 'Tasks',
          name_field: 'Task name',
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'task' },
            status: { prompt: 'select', enum: 'status', default: 'raw' },
            milestone: { prompt: 'dynamic', source: 'active_milestones', format: 'quoted-wikilink' },
          },
          frontmatter_order: ['type', 'objective-type', 'status', 'milestone'],
          body_sections: [
            { title: 'Steps', level: 2, content_type: 'checkboxes', prompt: 'multi-input', prompt_label: 'Steps' },
            { title: 'Notes', level: 2, content_type: 'paragraphs' },
          ],
        },
        milestone: {
          output_dir: 'Milestones',
          name_field: 'Milestone name',
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'milestone' },
            status: { prompt: 'select', enum: 'status', default: 'raw' },
          },
          frontmatter_order: ['type', 'objective-type', 'status'],
        },
      },
    },
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

describePty('ovault new command PTY tests', () => {
  beforeAll(() => {
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('complete creation flow', () => {
    it('should create a simple note with all prompts', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Complete Flow Test');

          // Status selection
          await proc.waitFor('status', 10000);
          proc.write('2'); // Select 'backlog'

          // Priority selection
          await proc.waitFor('priority', 10000);
          proc.write('3'); // Select 'high'

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file exists
          const exists = await vaultFileExists(vaultPath, 'Ideas/Complete Flow Test.md');
          expect(exists).toBe(true);

          // Verify content
          const content = await readVaultFile(vaultPath, 'Ideas/Complete Flow Test.md');
          expect(content).toContain('type: idea');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: high');
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should create a task with all prompts including body sections', async () => {
      // Add a milestone for the dynamic source
      const milestone: TempVaultFile = {
        path: 'Milestones/Active Milestone.md',
        content: `---
type: objective
objective-type: milestone
status: in-flight
---
`,
      };

      await withTempVault(
        ['new', 'objective/task'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Task name', 10000);
          await proc.typeAndEnter('Full Task Flow');

          // Status selection
          await proc.waitFor('status', 10000);
          proc.write('1'); // Select 'raw' (or skip with default)

          // Milestone selection (dynamic source)
          await proc.waitFor('milestone', 10000);
          proc.write('2'); // Select the milestone (1 is skip)

          // Steps (body section multi-input)
          await proc.waitFor('Steps', 10000);
          await proc.typeAndEnter('Step one, Step two');

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file
          const exists = await vaultFileExists(vaultPath, 'Tasks/Full Task Flow.md');
          expect(exists).toBe(true);

          const content = await readVaultFile(vaultPath, 'Tasks/Full Task Flow.md');
          expect(content).toContain('type: objective');
          expect(content).toContain('objective-type: task');
          expect(content).toContain('milestone: "[[Active Milestone]]"');
          expect(content).toContain('## Steps');
          expect(content).toContain('- [ ] Step one');
          expect(content).toContain('- [ ] Step two');
        },
        [milestone],
        FULL_SCHEMA
      );
    }, 30000);
  });

  describe('type navigation', () => {
    it('should prompt for type when none specified', async () => {
      await withTempVault(
        ['new'],
        async (proc) => {
          // Should prompt for top-level type selection
          await proc.waitFor('What would you like to create', 10000);

          // Should show available types
          const output = proc.getOutput();
          expect(output).toContain('objective');
          expect(output).toContain('idea');

          proc.write(Keys.CTRL_C);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should navigate through subtypes', async () => {
      await withTempVault(
        ['new', 'objective'],
        async (proc) => {
          // Should prompt for subtype
          await proc.waitFor('subtype', 10000);

          // Should show subtypes
          const output = proc.getOutput();
          expect(output).toContain('task');
          expect(output).toContain('milestone');

          // Select task
          proc.write('1');
          await proc.waitForStable(100);

          // Should now be at task name prompt
          await proc.waitFor('Task name', 10000);

          proc.write(Keys.CTRL_C);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should select type with number key and proceed', async () => {
      await withTempVault(
        ['new'],
        async (proc, vaultPath) => {
          // Wait for type selection
          await proc.waitFor('What would you like to create', 10000);

          // Select idea (probably option 2)
          proc.write('2');
          await proc.waitForStable(100);

          // Should now ask for idea name
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Type Nav Test');

          // Complete remaining prompts
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitFor('priority', 10000);
          proc.write('1');

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          const exists = await vaultFileExists(vaultPath, 'Ideas/Type Nav Test.md');
          expect(exists).toBe(true);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);
  });

  describe('cancellation at various steps', () => {
    it('should cancel cleanly at name prompt - no file created', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);

          // Type partial name then cancel
          await proc.typeText('Partial');
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') || output.includes('cancelled')
          ).toBe(true);

          // No file should be created
          const files = await listVaultFiles(vaultPath, 'Ideas');
          expect(files.length).toBe(0);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should cancel cleanly at selection prompt - no file created', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Complete name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Selection Cancel');

          // Wait for status selection
          await proc.waitFor('status', 10000);

          // Cancel at selection
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // No file should be created
          const files = await listVaultFiles(vaultPath, 'Ideas');
          expect(files.length).toBe(0);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should cancel cleanly at body section prompt - no file created', async () => {
      await withTempVault(
        ['new', 'objective/task'],
        async (proc, vaultPath) => {
          // Complete frontmatter prompts
          await proc.waitFor('Task name', 10000);
          await proc.typeAndEnter('Body Cancel Test');

          await proc.waitFor('status', 10000);
          proc.write('1');

          await proc.waitFor('milestone', 10000);
          proc.write('1'); // Skip

          // Wait for Steps body section prompt
          await proc.waitFor('Steps', 10000);

          // Cancel at body section
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // No file should be created
          const files = await listVaultFiles(vaultPath, 'Tasks');
          expect(files.length).toBe(0);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should cancel at type selection - no side effects', async () => {
      await withTempVault(
        ['new'],
        async (proc, vaultPath) => {
          // Wait for type selection
          await proc.waitFor('What would you like to create', 10000);

          // Cancel immediately
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') || output.includes('cancelled')
          ).toBe(true);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);
  });

  describe('template handling', () => {
    it('should use default template when available', async () => {
      // Schema with templates directory structure
      const templateContent = `---
type: idea
status: backlog
priority: medium
---

## Summary

Template content here.
`;
      const defaultTemplate: TempVaultFile = {
        path: 'Templates/idea/default.md',
        content: templateContent,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should show that it's using a template
          await proc.waitFor('Using template', 10000);

          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Template Test');

          // Template has defaults for status and priority, 
          // so it should skip those prompts and create the file
          await proc.waitForStable(300);
          await proc.waitFor('Created:', 5000);

          // Verify template content was used
          const content = await readVaultFile(vaultPath, 'Ideas/Template Test.md');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: medium');
          expect(content).toContain('## Summary');
        },
        [defaultTemplate],
        FULL_SCHEMA
      );
    }, 30000);

    it('should prompt for template when multiple available and no default', async () => {
      const template1: TempVaultFile = {
        path: 'Templates/idea/quick.md',
        content: `---
type: idea
status: raw
---
Quick idea template.
`,
      };
      const template2: TempVaultFile = {
        path: 'Templates/idea/detailed.md',
        content: `---
type: idea
status: backlog
priority: high
---
Detailed idea template.
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should prompt for template selection
          await proc.waitFor('Select template', 10000);

          // Should show both templates
          const output = proc.getOutput();
          expect(output).toContain('quick');
          expect(output).toContain('detailed');

          // Select first template
          proc.write('1');
          await proc.waitForStable(100);

          // Should proceed to name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Multi Template Test');

          // Complete remaining prompts as needed
          await proc.waitForStable(300);
          await proc.waitFor('Created:', 5000);

          const exists = await vaultFileExists(vaultPath, 'Ideas/Multi Template Test.md');
          expect(exists).toBe(true);
        },
        [template1, template2],
        FULL_SCHEMA
      );
    }, 30000);

    it('should allow skipping template with [No template] option', async () => {
      const template1: TempVaultFile = {
        path: 'Templates/idea/optional.md',
        content: `---
type: idea
---
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should prompt for template selection
          await proc.waitFor('Select template', 10000);

          // Should show no template option
          const output = proc.getOutput();
          expect(output).toContain('No template');

          // Find and select [No template] option (usually last)
          // Navigate down to find it
          proc.write(Keys.DOWN);
          await proc.waitForStable(50);
          proc.write(Keys.DOWN);
          await proc.waitForStable(50);
          proc.write(Keys.ENTER);
          await proc.waitForStable(100);

          // Should proceed to name prompt
          await proc.waitFor('Idea name', 10000);

          proc.write(Keys.CTRL_C);
        },
        [template1],
        FULL_SCHEMA
      );
    }, 30000);
  });

  describe('skip option for optional fields', () => {
    it('should show (skip) option for optional fields', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Skip Option Test');

          // Status is not required, should show skip option
          await proc.waitFor('status', 10000);
          await proc.waitForStable(100);

          const output = proc.getOutput();
          expect(output).toContain('skip');

          proc.write(Keys.CTRL_C);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);

    it('should use default value when skip is selected', async () => {
      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Wait for name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Default Via Skip');

          // Select skip for status (should use default 'raw')
          await proc.waitFor('status', 10000);
          proc.write('1'); // Skip is first option

          // Select skip for priority (no default)
          await proc.waitFor('priority', 10000);
          proc.write('1'); // Skip

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify default was used
          const content = await readVaultFile(vaultPath, 'Ideas/Default Via Skip.md');
          expect(content).toContain('status: raw');
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);
  });

  describe('error handling', () => {
    it('should show error for unknown type', async () => {
      await withTempVault(
        ['new', 'nonexistent-type'],
        async (proc) => {
          // Should show error message
          await proc.waitFor('Unknown type', 5000);

          // Wait for exit
          await proc.waitForExit(5000);
          expect(proc.hasExited()).toBe(true);
        },
        [],
        FULL_SCHEMA
      );
    }, 30000);
  });
});
