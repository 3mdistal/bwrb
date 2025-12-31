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

          // Status selection - options: (skip), raw, backlog, in-flight, settled
          // So '3' = backlog
          await proc.waitFor('status', 10000);
          proc.write('3'); // Select 'backlog'

          // Priority selection - options: (skip), low, medium, high
          // So '4' = high
          await proc.waitFor('priority', 10000);
          proc.write('4'); // Select 'high'

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
        { schema: FULL_SCHEMA }
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

          // Status selection - (skip) uses default 'raw'
          await proc.waitFor('status', 10000);
          proc.write('1'); // Skip - uses default 'raw'

          // Milestone selection (dynamic source) - (skip), Active Milestone
          await proc.waitFor('milestone', 10000);
          proc.write('2'); // Select the milestone

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
          // YAML quotes the wikilink value
          expect(content).toContain('[[Active Milestone]]');
          expect(content).toContain('## Steps');
          expect(content).toContain('- [ ] Step one');
          expect(content).toContain('- [ ] Step two');
        },
        { files: [milestone], schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
      );
    }, 30000);

    it('should cancel at type selection - no side effects', async () => {
      await withTempVault(
        ['new'],
        async (proc) => {
          // Wait for type selection prompt
          await proc.waitFor('What would you like to create', 10000);

          // Cancel immediately
          proc.write(Keys.CTRL_C);

          // Wait for exit
          await proc.waitForExit(5000);

          // Should show cancellation
          const output = proc.getOutput();
          expect(
            output.includes('Cancelled') || 
            output.includes('cancelled') ||
            output.includes('✖')
          ).toBe(true);
        },
        { schema: FULL_SCHEMA }
      );
    }, 30000);
  });

  describe('template handling', () => {
    it('should use default template when available', async () => {
      // Default template for ideas - should auto-apply without prompting for template
      // Note: Template has defaults for all fields, so no prompts after name!
      const defaultTemplate: TempVaultFile = {
        path: '.ovault/templates/idea/default.md',
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

[Your idea description here]
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should go directly to name prompt (no template selection)
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Template Default Test');

          // Template provides defaults for all fields, so creation happens immediately
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created with template body
          const content = await readVaultFile(vaultPath, 'Ideas/Template Default Test.md');
          expect(content).toContain('type: idea');
          expect(content).toContain('status: raw');
          expect(content).toContain('priority: medium');
          expect(content).toContain('## Description');
          expect(content).toContain('[Your idea description here]');
        },
        { files: [defaultTemplate], schema: FULL_SCHEMA }
      );
    }, 30000);

    it('should prompt for template when multiple available and no default', async () => {
      // Two templates, neither is default.md
      // quick has status default, detailed has priority default
      const template1: TempVaultFile = {
        path: '.ovault/templates/idea/quick.md',
        content: `---
type: template
template-for: idea
description: Quick idea capture
defaults:
  status: raw
  priority: low
---

Quick idea notes:
`,
      };
      const template2: TempVaultFile = {
        path: '.ovault/templates/idea/detailed.md',
        content: `---
type: template
template-for: idea
description: Detailed idea template
defaults:
  status: backlog
  priority: high
---

## Problem Statement

## Proposed Solution
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should prompt for template selection first
          await proc.waitFor('Select template', 10000);
          
          // Should show both template options
          const output = proc.getOutput();
          expect(output).toContain('quick');
          expect(output).toContain('detailed');

          // Select detailed (usually sorted, so detailed comes first)
          proc.write('1');
          await proc.waitForStable(100);

          // Now name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('Multi Template Test');

          // Template provides defaults for all fields, creation happens immediately
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created with detailed template content
          const content = await readVaultFile(vaultPath, 'Ideas/Multi Template Test.md');
          expect(content).toContain('## Problem Statement');
          expect(content).toContain('status: backlog');
          expect(content).toContain('priority: high');
        },
        { files: [template1, template2], schema: FULL_SCHEMA }
      );
    }, 30000);

    it('should allow skipping template with [No template] option', async () => {
      // Single template (non-default), user chooses [No template]
      const template1: TempVaultFile = {
        path: '.ovault/templates/idea/quick.md',
        content: `---
type: template
template-for: idea
description: Quick idea
---

Template body content
`,
      };

      await withTempVault(
        ['new', 'idea'],
        async (proc, vaultPath) => {
          // Should prompt for template selection
          await proc.waitFor('Select template', 10000);

          // Select [No template] option (last option)
          proc.write('2'); // quick=1, [No template]=2
          await proc.waitForStable(100);

          // Name prompt
          await proc.waitFor('Idea name', 10000);
          await proc.typeAndEnter('No Template Test');

          // Complete prompts - no defaults from template
          await proc.waitFor('status', 10000);
          proc.write('1');
          await proc.waitFor('priority', 10000);
          proc.write('1');

          // Wait for creation
          await proc.waitForStable(200);
          await proc.waitFor('Created:', 5000);

          // Verify file was created WITHOUT template body
          const content = await readVaultFile(vaultPath, 'Ideas/No Template Test.md');
          expect(content).not.toContain('Template body content');
        },
        { files: [template1], schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
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
        { schema: FULL_SCHEMA }
      );
    }, 30000);
  });
});
