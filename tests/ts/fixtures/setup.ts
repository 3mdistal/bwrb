import { mkdtemp, rm, mkdir, writeFile, cp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export const TEST_SCHEMA = {
  version: 1,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  dynamic_sources: {
    active_milestones: {
      dir: 'Objectives/Milestones',
      filter: {
        status: { not_in: ['settled'] },
      },
    },
  },
  types: {
    objective: {
      output_dir: 'Objectives',
      subtypes: {
        task: {
          output_dir: 'Objectives/Tasks',
          name_field: 'Task name',
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'task' },
            status: { prompt: 'select', enum: 'status', default: 'raw' },
            milestone: { prompt: 'dynamic', source: 'active_milestones', format: 'quoted-wikilink' },
            'creation-date': { value: '$NOW' },
            deadline: { prompt: 'input', label: 'Deadline (YYYY-MM-DD)' },
          },
          frontmatter_order: ['type', 'objective-type', 'status', 'milestone', 'creation-date', 'deadline'],
          body_sections: [
            { title: 'Steps', level: 2, content_type: 'checkboxes', prompt: 'multi-input', prompt_label: 'Steps' },
            { title: 'Notes', level: 2, content_type: 'paragraphs' },
          ],
        },
        milestone: {
          output_dir: 'Objectives/Milestones',
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

export async function createTestVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'ovault-test-'));

  // Create .ovault directory and schema
  await mkdir(join(vaultDir, '.ovault'), { recursive: true });
  await writeFile(
    join(vaultDir, '.ovault', 'schema.json'),
    JSON.stringify(TEST_SCHEMA, null, 2)
  );

  // Create directories
  await mkdir(join(vaultDir, 'Ideas'), { recursive: true });
  await mkdir(join(vaultDir, 'Objectives/Tasks'), { recursive: true });
  await mkdir(join(vaultDir, 'Objectives/Milestones'), { recursive: true });

  // Create sample files
  await writeFile(
    join(vaultDir, 'Ideas', 'Sample Idea.md'),
    `---
type: idea
status: raw
priority: medium
---
`
  );

  await writeFile(
    join(vaultDir, 'Ideas', 'Another Idea.md'),
    `---
type: idea
status: backlog
priority: high
---
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Tasks', 'Sample Task.md'),
    `---
type: objective
objective-type: task
status: in-flight
deadline: 2024-01-15
---
## Steps
- [ ] Step 1

## Notes
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Milestones', 'Active Milestone.md'),
    `---
type: objective
objective-type: milestone
status: in-flight
---
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Milestones', 'Settled Milestone.md'),
    `---
type: objective
objective-type: milestone
status: settled
---
`
  );

  return vaultDir;
}

export async function cleanupTestVault(vaultDir: string): Promise<void> {
  await rm(vaultDir, { recursive: true, force: true });
}
