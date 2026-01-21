import { mkdtemp, rm, mkdir, writeFile, cp } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Import canonical schema from shared module
import { BASELINE_SCHEMA } from './schemas.js';

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

/**
 * Test schema - re-exported from schemas.ts for backward compatibility.
 * Use BASELINE_SCHEMA from './schemas.js' for new tests.
 */
export const TEST_SCHEMA = BASELINE_SCHEMA;

export async function createTestVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-test-'));

  // Create .bwrb directory and schema
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(
    join(vaultDir, '.bwrb', 'schema.json'),
    JSON.stringify(TEST_SCHEMA, null, 2)
  );

  // Create directories
  await mkdir(join(vaultDir, 'Ideas'), { recursive: true });
  await mkdir(join(vaultDir, 'Objectives/Tasks'), { recursive: true });
  await mkdir(join(vaultDir, 'Objectives/Milestones'), { recursive: true });
  await mkdir(join(vaultDir, 'Projects'), { recursive: true });
  await mkdir(join(vaultDir, 'Research'), { recursive: true });

  // Create sample files
  await writeFile(
    join(vaultDir, 'Ideas', 'Sample Idea.md'),
    `---
type: idea
status: raw
priority: medium
effort: 2
archived: false
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

  // Create template directories and sample templates in .bwrb/templates/
  await mkdir(join(vaultDir, '.bwrb/templates/idea'), { recursive: true });
  await mkdir(join(vaultDir, '.bwrb/templates/task'), { recursive: true });

  await writeFile(
    join(vaultDir, '.bwrb/templates/idea', 'default.md'),
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
    join(vaultDir, '.bwrb/templates/task', 'default.md'),
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
    join(vaultDir, '.bwrb/templates/task', 'bug-report.md'),
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
    join(vaultDir, '.bwrb/templates/task', 'weekly-review.md'),
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

  // Template with instances for parent scaffolding tests
  await mkdir(join(vaultDir, '.bwrb/templates/project'), { recursive: true });
  await writeFile(
    join(vaultDir, '.bwrb/templates/project', 'with-research.md'),
    `---
type: template
template-for: project
description: Project with pre-scaffolded research notes
defaults:
  status: in-flight
instances:
  - type: research
    filename: "Background Research.md"
    defaults:
      status: raw
  - type: research
    filename: "Competitor Analysis.md"
    defaults:
      status: raw
---

# Project Overview

## Goals

## Timeline
`
  );

  // Delay to ensure file system sync completes (fixes flaky tests on macOS)
  await new Promise((resolve) => setTimeout(resolve, 50));

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
 * Run the bwrb CLI with arguments and capture output.
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
