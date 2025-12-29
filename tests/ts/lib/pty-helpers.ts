/**
 * PTY test helpers for interactive CLI testing.
 *
 * Uses node-pty to spawn real pseudoterminal processes, enabling tests
 * for interactive prompts that can't be tested with mocked stdin/stdout.
 */

import * as pty from 'node-pty';
import * as path from 'path';

// Path to the test vault fixture
export const TEST_VAULT_PATH = path.resolve(
  import.meta.dirname,
  '../../fixtures/vault'
);

// Path to the project root (for running ovault via tsx)
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

// Path to tsx binary in node_modules
export const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * Special key sequences for PTY input.
 */
export const Keys = {
  ENTER: '\r',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  ESCAPE: '\x1b',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
} as const;

/**
 * Strip ANSI escape codes from a string.
 * This makes output easier to assert against.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Options for spawning a PTY process.
 */
export interface SpawnOptions {
  /** Working directory (defaults to TEST_VAULT_PATH) */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Terminal columns (default: 80) */
  cols?: number;
  /** Terminal rows (default: 24) */
  rows?: number;
}

/**
 * A wrapper around a node-pty process with helper methods for testing.
 */
export class PtyProcess {
  private ptyProcess: pty.IPty;
  private output: string = '';
  private outputLines: string[] = [];
  private exitCode: number | null = null;
  private exitPromise: Promise<number>;

  constructor(ptyProcess: pty.IPty) {
    this.ptyProcess = ptyProcess;

    // Collect all output
    ptyProcess.onData((data) => {
      this.output += data;
      // Split by newlines, keeping track of partial lines
      const lines = this.output.split(/\r?\n/);
      this.outputLines = lines;
    });

    // Track exit
    this.exitPromise = new Promise((resolve) => {
      ptyProcess.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        resolve(exitCode);
      });
    });
  }

  /**
   * Get the raw output (includes ANSI codes).
   */
  getRawOutput(): string {
    return this.output;
  }

  /**
   * Get the output with ANSI codes stripped.
   */
  getOutput(): string {
    return stripAnsi(this.output);
  }

  /**
   * Get output split into lines (ANSI stripped).
   */
  getLines(): string[] {
    return this.outputLines.map(stripAnsi);
  }

  /**
   * Count occurrences of a pattern in the output.
   * Useful for detecting re-renders (same content appearing multiple times).
   */
  countOccurrences(pattern: string | RegExp): number {
    const output = this.getOutput();
    if (typeof pattern === 'string') {
      return output.split(pattern).length - 1;
    }
    return (output.match(pattern) || []).length;
  }

  /**
   * Write data to the PTY (send keypress/input).
   */
  write(data: string): void {
    this.ptyProcess.write(data);
  }

  /**
   * Send a key (convenience method).
   */
  sendKey(key: keyof typeof Keys): void {
    this.write(Keys[key]);
  }

  /**
   * Wait for the output to contain a specific pattern.
   * @param pattern String or regex to match
   * @param timeoutMs Maximum time to wait (default: 5000ms)
   */
  async waitFor(
    pattern: string | RegExp,
    timeoutMs: number = 5000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const output = this.getOutput();
      const matches =
        typeof pattern === 'string'
          ? output.includes(pattern)
          : pattern.test(output);

      if (matches) {
        return;
      }

      // Small delay before checking again
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Timeout waiting for pattern: ${pattern}\nCurrent output:\n${this.getOutput()}`
    );
  }

  /**
   * Wait for the process to exit.
   * @param timeoutMs Maximum time to wait (default: 10000ms)
   */
  async waitForExit(timeoutMs: number = 10000): Promise<number> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Process did not exit within ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    return Promise.race([this.exitPromise, timeoutPromise]);
  }

  /**
   * Kill the process.
   */
  kill(signal?: string): void {
    this.ptyProcess.kill(signal);
  }

  /**
   * Check if the process has exited.
   */
  hasExited(): boolean {
    return this.exitCode !== null;
  }

  /**
   * Get the exit code (null if not exited).
   */
  getExitCode(): number | null {
    return this.exitCode;
  }

  /**
   * Get the PID of the process.
   */
  getPid(): number {
    return this.ptyProcess.pid;
  }
}

/**
 * Spawn ovault in a PTY with the given arguments.
 *
 * @param args Command-line arguments to pass to ovault
 * @param options Spawn options
 * @returns A PtyProcess wrapper
 *
 * @example
 * ```ts
 * const proc = await spawnOvault(['new', 'objective/task'], { cwd: testVaultPath });
 * await proc.waitFor('Task name');
 * proc.write('My Task\r');
 * ```
 */
export function spawnOvault(
  args: string[],
  options: SpawnOptions = {}
): PtyProcess {
  const {
    cwd = TEST_VAULT_PATH,
    env = {},
    cols = 80,
    rows = 24,
  } = options;

  // Use tsx to run the TypeScript source directly
  const ptyProcess = pty.spawn(TSX_BIN, ['src/index.ts', ...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      // Force color output even in non-TTY-like environments
      FORCE_COLOR: '1',
      // Set the vault path
      OVAULT_VAULT: cwd,
      ...env,
    },
  });

  return new PtyProcess(ptyProcess);
}

/**
 * Spawn a generic command in a PTY.
 *
 * @param command The command to run
 * @param args Command arguments
 * @param options Spawn options
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): PtyProcess {
  const {
    cwd = PROJECT_ROOT,
    env = {},
    cols = 80,
    rows = 24,
  } = options;

  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      ...env,
    },
  });

  return new PtyProcess(ptyProcess);
}

/**
 * Helper to run a quick PTY test with automatic cleanup.
 *
 * @param args ovault arguments
 * @param fn Test function receiving the PtyProcess
 * @param options Spawn options
 */
export async function withOvault(
  args: string[],
  fn: (proc: PtyProcess) => Promise<void>,
  options: SpawnOptions = {}
): Promise<void> {
  const proc = spawnOvault(args, options);
  try {
    await fn(proc);
  } finally {
    if (!proc.hasExited()) {
      proc.kill();
      // Give it a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
