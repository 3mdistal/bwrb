import { mkdtemp, rm, mkdir, writeFile, cp } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = join(__dirname, '../../..');
const CLI_PATH = join(PROJECT_ROOT, 'dist/index.js');

/**
 * Get a relative path from the project root to the vault.
 * Useful for testing CLI with relative --vault paths.
 * @param vaultDir Absolute path to vault
 * @returns Relative path from PROJECT_ROOT
 */
export function getRelativeVaultPath(vaultDir: string): string {
  return relative(PROJECT_ROOT, vaultDir);
}

export const TEST_SCHEMA = {
  version: 1,
  shared_fields: {
    status: {
      prompt: 'select',
      enum: 'status',
      default: 'raw',
      required: true,
    },
    tags: {
      prompt: 'multi-input',
      list_format: 'yaml-array',
      default: [],
    },
  },
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
          shared_fields: ['status', 'tags'],
          field_overrides: {
            status: { default: 'backlog' },
          },
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'task' },
            milestone: { prompt: 'dynamic', source: 'active_milestones', format: 'quoted-wikilink' },
            'creation-date': { value: '$NOW' },
            deadline: { prompt: 'input', label: 'Deadline (YYYY-MM-DD)' },
          },
          frontmatter_order: ['type', 'objective-type', 'status', 'milestone', 'creation-date', 'deadline', 'tags'],
          body_sections: [
            { title: 'Steps', level: 2, content_type: 'checkboxes', prompt: 'multi-input', prompt_label: 'Steps' },
            { title: 'Notes', level: 2, content_type: 'paragraphs' },
          ],
        },
        milestone: {
          output_dir: 'Objectives/Milestones',
          shared_fields: ['status'],
          frontmatter: {
            type: { value: 'objective' },
            'objective-type': { value: 'milestone' },
          },
          frontmatter_order: ['type', 'objective-type', 'status'],
        },
      },
    },
    idea: {
      output_dir: 'Ideas',
      shared_fields: ['status'],
      frontmatter: {
        type: { value: 'idea' },
        priority: { prompt: 'select', enum: 'priority' },
      },
      frontmatter_order: ['type', 'status', 'priority'],
    },
  },
  audit: {
    ignored_directories: ['Templates'],
  },
};

export async function createTestVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'pika-test-'));

  // Create .pika directory and schema
  await mkdir(join(vaultDir, '.pika'), { recursive: true });
  await writeFile(
    join(vaultDir, '.pika', 'schema.json'),
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

  // Create template directories and sample templates in .pika/templates/
  await mkdir(join(vaultDir, '.pika/templates/idea'), { recursive: true });
  await mkdir(join(vaultDir, '.pika/templates/objective/task'), { recursive: true });

  await writeFile(
    join(vaultDir, '.pika/templates/idea', 'default.md'),
    `---
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

## Why This Matters

## Next Steps

- [ ] 
`
  );

  await writeFile(
    join(vaultDir, '.pika/templates/objective/task', 'default.md'),
    `---
type: template
template-for: objective/task
description: Default task template
defaults:
  status: backlog
---

## Steps

- [ ] 

## Notes

`
  );

  await writeFile(
    join(vaultDir, '.pika/templates/objective/task', 'bug-report.md'),
    `---
type: template
template-for: objective/task
description: Bug report with reproduction steps
defaults:
  status: backlog
prompt-fields:
  - deadline
---

## Description

[Describe the bug]

## Steps to Reproduce

1. 
2. 
3. 

## Expected Behavior

## Actual Behavior

`
  );

  // Template with date expression defaults for testing
  await writeFile(
    join(vaultDir, '.pika/templates/objective/task', 'weekly-review.md'),
    `---
type: template
template-for: objective/task
description: Weekly review task with auto-deadline
defaults:
  status: backlog
  deadline: "today() + '7d'"
---

## Review Items

- [ ] Check completed tasks
- [ ] Review priorities
- [ ] Plan next week

## Notes

`
  );

  return vaultDir;
}

export async function cleanupTestVault(vaultDir: string): Promise<void> {
  await rm(vaultDir, { recursive: true, force: true });
}

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the pika CLI with arguments and capture output.
 * @param args CLI arguments (e.g., ['list', 'idea', '--status=raw'])
 * @param vaultDir Optional vault directory (passed via --vault)
 * @param stdin Optional stdin input for interactive commands
 */
export async function runCLI(
  args: string[],
  vaultDir?: string,
  stdin?: string
): Promise<CLIResult> {
  const fullArgs = vaultDir ? ['--vault', vaultDir, ...args] : args;

  return new Promise((resolve) => {
    const proc = spawn('node', [CLI_PATH, ...fullArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' }, // Disable colors for easier parsing
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });
  });
}
