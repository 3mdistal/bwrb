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
const NODE_DEP0205_SUPPRESSION = '--disable-warning=DEP0205';

export function withTestCliNodeOptions(
  env: NodeJS.ProcessEnv,
  { useDist = USE_DIST }: { useDist?: boolean } = {}
): Record<string, string> {
  const normalizedEnv: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );

  if (useDist) return normalizedEnv;

  const existingNodeOptions = normalizedEnv.NODE_OPTIONS?.trim();
  if (existingNodeOptions?.split(/\s+/).includes(NODE_DEP0205_SUPPRESSION)) {
    return normalizedEnv;
  }

  return {
    ...normalizedEnv,
    NODE_OPTIONS: existingNodeOptions
      ? `${existingNodeOptions} ${NODE_DEP0205_SUPPRESSION}`
      : NODE_DEP0205_SUPPRESSION,
  };
}

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
## Tasks
`
  );

  await writeFile(
    join(vaultDir, 'Objectives/Milestones', 'Settled Milestone.md'),
    `---
type: milestone
status: settled
---
## Tasks
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
  /**
   * Hard wall-clock budget for a single spawn before it is killed and the
   * attempt is treated as a transient failure. Defaults to RUN_CLI_TIMEOUT_MS.
   *
   * The real CLI is launched via `tsx`, which pays a non-trivial cold-start
   * cost per process. Under heavy parallel load (many concurrent vitest forks
   * each spawning their own `tsx`), that cold start can balloon well past a
   * second. This budget is deliberately generous so that contention shows up
   * as a slow-but-successful run rather than a flaky failure.
   */
  timeoutMs?: number;
  /**
   * Number of times to re-attempt a spawn that fails transiently (spawn
   * error such as EAGAIN/ENOMEM, or our own per-spawn timeout). Defaults to
   * RUN_CLI_RETRIES. A non-zero exit code from the CLI itself is NOT retried
   * here — that is the CLI's own behavior and is what tests assert on.
   */
  retries?: number;
}

/**
 * Per-spawn wall-clock budget. Generous on purpose: `tsx` cold start under
 * heavy parallel load (15+ concurrent forks) can take several seconds, and a
 * too-tight budget is the root cause of the historical seed-step flake
 * (vitest aborting the test, SIGTERM-ing the in-flight spawn, surfacing as
 * "exitCode 1, expected 0"). Override per call via RunCLIOptions.timeoutMs.
 */
const RUN_CLI_TIMEOUT_MS = Number(process.env.BWRB_TEST_CLI_TIMEOUT_MS) || 30_000;

/**
 * Default number of retries for transient spawn failures (spawn errors or the
 * per-spawn timeout). CLI non-zero exits are never retried.
 */
const RUN_CLI_RETRIES = 2;

class TransientSpawnError extends Error {}

function spawnOnce(
  cliCommand: string,
  cliArgs: string[],
  cwd: string,
  mergedEnv: Record<string, string>,
  stdin: string | undefined,
  timeoutMs: number
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cliCommand, cliArgs, {
      cwd,
      env: mergedEnv,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(
        new TransientSpawnError(
          `runCLI spawn exceeded ${timeoutMs}ms: ${cliCommand} ${cliArgs.join(' ')}`
        )
      );
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Without this handler a failed spawn (e.g. EAGAIN/ENOMEM under load)
    // would leave the promise pending forever, surfacing as an opaque vitest
    // worker timeout rather than a diagnosable, retryable failure.
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TransientSpawnError(`runCLI spawn failed: ${err.message}`));
    });

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });
  });
}

/**
 * Run the bwrb CLI with arguments and capture output.
 *
 * The CLI is spawned as a real subprocess (`tsx src/index.ts`, or `node
 * dist/index.js` when BWRB_TEST_DIST=1). To stay reliable under heavy parallel
 * load this helper applies a generous per-spawn timeout and retries only
 * *transient* spawn failures (spawn errors or timeouts). A non-zero CLI exit
 * code is returned as-is so tests can assert on it.
 *
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
  const {
    cwd = PROJECT_ROOT,
    env = {},
    timeoutMs = RUN_CLI_TIMEOUT_MS,
    retries = RUN_CLI_RETRIES,
  } = options;

  const cliCommand = USE_DIST ? 'node' : TSX_BIN;
  const cliArgs = USE_DIST ? [CLI_PATH, ...fullArgs] : [CLI_SRC_PATH, ...fullArgs];

  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'FORCE_COLOR' && typeof value === 'string'
    )
  );

  let mergedEnv: Record<string, string> = {
    ...childEnv,
    ...env,
  };

  if (mergedEnv.NO_COLOR === undefined) {
    mergedEnv.NO_COLOR = '1';
  }

  mergedEnv = withTestCliNodeOptions(mergedEnv);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await spawnOnce(cliCommand, cliArgs, cwd, mergedEnv, stdin, timeoutMs);
    } catch (err) {
      if (!(err instanceof TransientSpawnError)) throw err;
      lastError = err;
      // Small backoff lets transient contention (CPU/fork pressure) ease.
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  // Surface the transient failure clearly so future flakes are diagnosable
  // instead of masquerading as a bare "exitCode 1".
  throw new Error(
    `runCLI failed after ${retries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
