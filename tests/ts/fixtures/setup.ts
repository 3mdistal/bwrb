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
const DIST_CLI_PATH = join(PROJECT_ROOT, 'dist/index.js');
const SRC_CLI_PATH = join(PROJECT_ROOT, 'src/index.ts');

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

export type CLIMode = 'source' | 'dist';

export interface RunCLIOptions {
  vaultDir?: string;
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mode?: CLIMode;
}

function resolveRunCLIOptions(
  vaultDirOrOptions?: string | RunCLIOptions,
  stdin?: string
): RunCLIOptions {
  if (typeof vaultDirOrOptions === 'string') {
    return { vaultDir: vaultDirOrOptions, stdin };
  }

  return vaultDirOrOptions ?? {};
}

function resolveCLIMode(mode?: CLIMode): CLIMode {
  if (mode) {
    return mode;
  }

  return process.env.BWRB_TEST_DIST === '1' ? 'dist' : 'source';
}

function buildNodeArgs(mode: CLIMode, args: string[]): string[] {
  if (mode === 'dist') {
    return [DIST_CLI_PATH, ...args];
  }

  return ['--import', 'tsx', SRC_CLI_PATH, ...args];
}

/**
 * Run the bwrb CLI with arguments and capture output.
 * @param args CLI arguments (e.g., ['list', 'idea', '--status=raw'])
 * @param vaultDirOrOptions Optional vault directory or options object
 * @param stdin Optional stdin input for interactive commands (legacy signature)
 */
export async function runCLI(
  args: string[],
  vaultDirOrOptions?: string | RunCLIOptions,
  stdin?: string
): Promise<CLIResult> {
  const options = resolveRunCLIOptions(vaultDirOrOptions, stdin);
  const mode = resolveCLIMode(options.mode);
  const shouldInjectVaultArg = Boolean(options.vaultDir) && !args.includes('--completions');
  const fullArgs = shouldInjectVaultArg ? ['--vault', options.vaultDir!, ...args] : args;
  const cliArgs = buildNodeArgs(mode, fullArgs);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    ...options.env,
  };

  if (options.vaultDir && !shouldInjectVaultArg && !env.BWRB_VAULT) {
    env.BWRB_VAULT = options.vaultDir;
  }

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, cliArgs, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
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
