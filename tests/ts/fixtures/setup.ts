import { mkdtemp, rm, mkdir, writeFile, cp, stat } from 'fs/promises';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

// Import canonical schema from shared module
import { BASELINE_SCHEMA } from './schemas.js';

export const PROJECT_ROOT = process.cwd();
export const CLI_PATH = join(PROJECT_ROOT, 'dist/index.js');
const CLI_SRC_PATH = join(PROJECT_ROOT, 'src/index.ts');
const TSX_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

const USE_DIST = process.env.BWRB_TEST_DIST === '1';

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

export interface WaitForFileOptions {
  timeoutMs?: number;
  intervalMs?: number;
  minSize?: number;
}

export async function waitForFile(
  filePath: string,
  { timeoutMs = 1000, intervalMs = 20, minSize = 1 }: WaitForFileOptions = {}
): Promise<void> {
  const start = Date.now();

  while (true) {
    try {
      const info = await stat(filePath);
      if (info.isFile() && info.size >= minSize) return;
    } catch {
      // File not ready yet.
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

  await waitForFile(join(vaultDir, '.bwrb/templates/project', 'with-research.md'));

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

export interface RunCLIOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
  stdin?: string,
  options: RunCLIOptions = {}
): Promise<CLIResult> {
  const fullArgs = vaultDir ? ['--vault', vaultDir, ...args] : args;
  const { cwd = PROJECT_ROOT, env = {} } = options;

  const cliCommand = USE_DIST ? 'node' : TSX_BIN;
  const cliArgs = USE_DIST ? [CLI_PATH, ...fullArgs] : [CLI_SRC_PATH, ...fullArgs];

  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'FORCE_COLOR' && typeof value === 'string'
    )
  );

  const mergedEnv: Record<string, string> = {
    ...childEnv,
    ...env,
  };

  if (mergedEnv.NO_COLOR === undefined) {
    mergedEnv.NO_COLOR = '1';
  }

  return new Promise((resolve) => {
    const proc = spawn(cliCommand, cliArgs, {
      cwd,
      env: mergedEnv,
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
