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
  version: 2,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  types: {
    objective: {
      output_dir: 'Objectives',
      fields: {
        type: { value: 'objective' },
      },
      field_order: ['type'],
    },
    task: {
      extends: 'objective',
      output_dir: 'Objectives/Tasks',
      fields: {
        type: { value: 'task' },
        status: {
          prompt: 'select',
          enum: 'status',
          default: 'backlog',
          required: true,
        },
        milestone: {
          prompt: 'dynamic',
          source: 'milestone',
          filter: { status: { not_in: ['settled'] } },
          format: 'quoted-wikilink',
        },
        'creation-date': { value: '$NOW' },
        deadline: { prompt: 'input', label: 'Deadline (YYYY-MM-DD)' },
        tags: {
          prompt: 'multi-input',
          list_format: 'yaml-array',
          default: [],
        },
      },
      field_order: ['type', 'status', 'milestone', 'creation-date', 'deadline', 'tags'],
      body_sections: [
        { title: 'Steps', level: 2, content_type: 'checkboxes', prompt: 'multi-input', prompt_label: 'Steps' },
        { title: 'Notes', level: 2, content_type: 'paragraphs' },
      ],
    },
    milestone: {
      extends: 'objective',
      output_dir: 'Objectives/Milestones',
      fields: {
        type: { value: 'milestone' },
        status: {
          prompt: 'select',
          enum: 'status',
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
    },
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: {
          prompt: 'select',
          enum: 'status',
          default: 'raw',
          required: true,
        },
        priority: { prompt: 'select', enum: 'priority' },
      },
      field_order: ['type', 'status', 'priority'],
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
type: task
status: in-flight
deadline: "2024-01-15"
---
## Steps
- [ ] Step 1

## Notes
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Milestones', 'Active Milestone.md'),
    `---
type: milestone
status: in-flight
---
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Milestones', 'Settled Milestone.md'),
    `---
type: milestone
status: settled
---
`
  );

  // Create template directories and sample templates in .pika/templates/
  await mkdir(join(vaultDir, '.pika/templates/idea'), { recursive: true });
  await mkdir(join(vaultDir, '.pika/templates/task'), { recursive: true });

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
    join(vaultDir, '.pika/templates/task', 'default.md'),
    `---
type: template
template-for: task
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
    join(vaultDir, '.pika/templates/task', 'bug-report.md'),
    `---
type: template
template-for: task
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
    join(vaultDir, '.pika/templates/task', 'weekly-review.md'),
    `---
type: template
template-for: task
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
