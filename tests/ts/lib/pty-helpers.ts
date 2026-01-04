/**
 * PTY test helpers for interactive CLI testing.
 *
 * Uses node-pty to spawn real pseudoterminal processes, enabling tests
 * for interactive prompts that can't be tested with mocked stdin/stdout.
 */

import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// ============================================================================
// Global Process Tracking (for cleanup on test timeout)
// ============================================================================

/**
 * Track all active PTY processes for cleanup.
 * When vitest times out a test, the finally block may not run,
 * so we need global tracking to clean up orphaned processes.
 */
const activePtyProcesses = new Set<PtyProcess>();

/**
 * Kill all active PTY processes.
 * Call this in afterEach hooks to clean up after timeouts.
 */
export function killAllPtyProcesses(): void {
  for (const proc of activePtyProcesses) {
    if (!proc.hasExited()) {
      try {
        proc.kill();
      } catch {
        // Ignore errors when killing (process may have already exited)
      }
    }
  }
  activePtyProcesses.clear();
}

/**
 * Register a PTY process for tracking.
 * Called automatically when creating a PtyProcess.
 */
function registerPtyProcess(proc: PtyProcess): void {
  activePtyProcesses.add(proc);
}

/**
 * Unregister a PTY process from tracking.
 * Called automatically when the process exits.
 */
function unregisterPtyProcess(proc: PtyProcess): void {
  activePtyProcesses.delete(proc);
}

// Path to the test vault fixture
export const TEST_VAULT_PATH = path.resolve(
  import.meta.dirname,
  '../../fixtures/vault'
);

// Path to the project root (for running bwrb via tsx)
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
  BACKSPACE: '\x7f',
  TAB: '\t',
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

    // Register for global tracking (cleanup on test timeout)
    registerPtyProcess(this);

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
        // Unregister from global tracking
        unregisterPtyProcess(this);
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

  /**
   * Type text character by character with optional delay.
   * More realistic than writing all at once.
   * @param text The text to type
   * @param delayMs Delay between characters (default: 5ms)
   */
  async typeText(text: string, delayMs: number = 5): Promise<void> {
    for (const char of text) {
      this.write(char);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Type text and press Enter.
   * @param text The text to type
   * @param delayMs Delay between characters (default: 5ms)
   */
  async typeAndEnter(text: string, delayMs: number = 5): Promise<void> {
    await this.typeText(text, delayMs);
    this.write(Keys.ENTER);
  }

  /**
   * Clear the current output buffer.
   * Useful for focusing assertions on output after a certain point.
   */
  clearOutput(): void {
    this.output = '';
    this.outputLines = [];
  }

  /**
   * Wait for output to stabilize (no new output for a period).
   * Useful after an action to ensure all output has been received.
   * @param stableMs Time with no new output to consider stable (default: 100ms)
   * @param timeoutMs Maximum time to wait (default: 5000ms)
   */
  async waitForStable(stableMs: number = 100, timeoutMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    let lastLength = this.output.length;
    let lastChangeTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      
      if (this.output.length !== lastLength) {
        lastLength = this.output.length;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= stableMs) {
        return;
      }
    }

    throw new Error(`Output did not stabilize within ${timeoutMs}ms`);
  }
}

/**
 * Spawn bwrb in a PTY with the given arguments.
 *
 * @param args Command-line arguments to pass to bwrb
 * @param options Spawn options
 * @returns A PtyProcess wrapper
 *
 * @example
 * ```ts
 * const proc = await spawnBowerbird(['new', 'task'], { cwd: testVaultPath });
 * await proc.waitFor('Name');
 * proc.write('My Task\r');
 * ```
 */
export function spawnBowerbird(
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
      BWRB_VAULT: cwd,
      ...env,
    },
  });

  return new PtyProcess(ptyProcess);
}

// Alias for backward compatibility in tests
export const spawnOvault = spawnBowerbird;

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
 * @param args bwrb arguments
 * @param fn Test function receiving the PtyProcess
 * @param options Spawn options
 */
export async function withBowerbird(
  args: string[],
  fn: (proc: PtyProcess) => Promise<void>,
  options: SpawnOptions = {}
): Promise<void> {
  const proc = spawnBowerbird(args, options);
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

// Alias for backward compatibility in tests
export const withOvault = withBowerbird;

// ============================================================================
// Temporary Vault Management
// ============================================================================

/**
 * Schema for a minimal test vault.
 */
export const MINIMAL_SCHEMA = {
  $schema: '../../../schema.schema.json',
  version: 2,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
    priority: ['low', 'medium', 'high'],
  },
  types: {
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
        priority: { prompt: 'select', enum: 'priority' },
      },
      field_order: ['type', 'status', 'priority'],
    },
  },
};

/**
 * File definition for creating temp vault files.
 */
export interface TempVaultFile {
  /** Relative path within the vault */
  path: string;
  /** File content */
  content: string;
}

/**
 * Options for withTempVault and withTempVaultRelative helpers.
 */
export interface WithTempVaultOptions {
  /** Files to create in the temp vault */
  files?: TempVaultFile[];
  /** Schema to use (defaults to MINIMAL_SCHEMA) */
  schema?: object;
  /**
   * Include templates from the fixture vault.
   * - true: Copy all templates
   * - string[]: Copy only templates for specified types (e.g., ['idea', 'objective'])
   */
  includeTemplates?: boolean | string[];
}

// Path to the fixture vault templates
const FIXTURE_TEMPLATES_PATH = path.join(TEST_VAULT_PATH, '.bwrb', 'templates');

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Copy templates from the fixture vault to a target vault.
 * @param targetVaultPath Destination vault path
 * @param types Types to copy templates for (undefined = all)
 */
export async function copyFixtureTemplates(
  targetVaultPath: string,
  types?: string[]
): Promise<void> {
  const targetTemplatesPath = path.join(targetVaultPath, '.bwrb', 'templates');
  
  // Ensure target templates directory exists
  await fs.mkdir(targetTemplatesPath, { recursive: true });
  
  if (!types) {
    // Copy all templates
    await copyDir(FIXTURE_TEMPLATES_PATH, targetTemplatesPath);
  } else {
    // Copy only specified types
    for (const type of types) {
      const srcTypePath = path.join(FIXTURE_TEMPLATES_PATH, type);
      const destTypePath = path.join(targetTemplatesPath, type);
      
      try {
        await fs.access(srcTypePath);
        await copyDir(srcTypePath, destTypePath);
      } catch {
        // Type directory doesn't exist in fixtures, skip silently
      }
    }
  }
}

/**
 * Create a temporary vault directory with the given files.
 * @param files Array of files to create
 * @param schema Schema object to use (defaults to MINIMAL_SCHEMA)
 * @param includeTemplates Whether to copy templates from fixture vault
 * @returns Path to the temporary vault
 */
export async function createTempVault(
  files: TempVaultFile[] = [],
  schema: object = MINIMAL_SCHEMA,
  includeTemplates?: boolean | string[]
): Promise<string> {
  // Create temp directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bwrb-test-'));

  // Create .bwrb directory with schema
  const bwrbDir = path.join(tempDir, '.bwrb');
  await fs.mkdir(bwrbDir, { recursive: true });
  await fs.writeFile(
    path.join(bwrbDir, 'schema.json'),
    JSON.stringify(schema, null, 2)
  );

  // Create any directories needed by the schema
  if ('types' in schema && typeof schema.types === 'object' && schema.types !== null) {
    for (const typeDef of Object.values(schema.types)) {
      if (typeDef && typeof typeDef === 'object' && 'output_dir' in typeDef) {
        const outputDir = typeDef.output_dir as string;
        await fs.mkdir(path.join(tempDir, outputDir), { recursive: true });
      }
    }
  }

  // Copy templates from fixture vault if requested
  if (includeTemplates) {
    const types = Array.isArray(includeTemplates) ? includeTemplates : undefined;
    await copyFixtureTemplates(tempDir, types);
  }

  // Create the files
  for (const file of files) {
    const filePath = path.join(tempDir, file.path);
    const fileDir = path.dirname(filePath);
    await fs.mkdir(fileDir, { recursive: true });
    await fs.writeFile(filePath, file.content);
  }

  return tempDir;
}

/**
 * Clean up a temporary vault directory.
 * @param vaultPath Path to the temporary vault
 */
export async function cleanupTempVault(vaultPath: string): Promise<void> {
  // Safety check: only delete paths in temp directory
  const tempRoot = os.tmpdir();
  if (!vaultPath.startsWith(tempRoot)) {
    throw new Error(`Refusing to delete path outside temp directory: ${vaultPath}`);
  }
  
  await fs.rm(vaultPath, { recursive: true, force: true });
}

/**
 * Read a file from the vault.
 * @param vaultPath Path to the vault
 * @param filePath Relative path within the vault
 */
export async function readVaultFile(
  vaultPath: string,
  filePath: string
): Promise<string> {
  return fs.readFile(path.join(vaultPath, filePath), 'utf-8');
}

/**
 * Check if a file exists in the vault.
 * @param vaultPath Path to the vault
 * @param filePath Relative path within the vault
 */
export async function vaultFileExists(
  vaultPath: string,
  filePath: string
): Promise<boolean> {
  try {
    await fs.access(path.join(vaultPath, filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a vault directory.
 * @param vaultPath Path to the vault
 * @param dirPath Relative directory path within the vault
 */
export async function listVaultFiles(
  vaultPath: string,
  dirPath: string
): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(vaultPath, dirPath));
    return entries.filter(e => e.endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * Helper to run a PTY test with a temporary vault that gets cleaned up.
 * 
 * @param args bwrb arguments
 * @param fn Test function receiving the PtyProcess and vault path
 * @param options Options for vault creation (files, schema, includeTemplates)
 * 
 * @example
 * ```ts
 * await withTempVault(['new', 'idea'], async (proc, vaultPath) => {
 *   // test code
 * }, { includeTemplates: true, schema: MY_SCHEMA });
 * ```
 */
export async function withTempVault(
  args: string[],
  fn: (proc: PtyProcess, vaultPath: string) => Promise<void>,
  options: WithTempVaultOptions = {}
): Promise<void> {
  const { files = [], schema = MINIMAL_SCHEMA, includeTemplates } = options;

  const vaultPath = await createTempVault(files, schema, includeTemplates);
  try {
    const proc = spawnBowerbird(args, { cwd: vaultPath });
    try {
      await fn(proc, vaultPath);
    } finally {
      if (!proc.hasExited()) {
        proc.kill();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    await cleanupTempVault(vaultPath);
  }
}

/**
 * Get a relative path from the project root to the vault.
 * Useful for testing CLI with relative vault paths.
 * @param vaultDir Absolute path to vault
 * @returns Relative path from PROJECT_ROOT
 */
export function getRelativePath(vaultDir: string): string {
  return path.relative(PROJECT_ROOT, vaultDir);
}

/**
 * Helper to run a PTY test with a relative vault path.
 * This tests the CLI's ability to handle relative paths correctly.
 * 
 * @param args bwrb arguments
 * @param fn Test function receiving the PtyProcess and absolute vault path
 * @param options Options for vault creation (files, schema, includeTemplates)
 * 
 * @example
 * ```ts
 * await withTempVaultRelative(['new', 'idea'], async (proc, vaultPath) => {
 *   // test code
 * }, { includeTemplates: ['idea'] });
 * ```
 */
export async function withTempVaultRelative(
  args: string[],
  fn: (proc: PtyProcess, vaultPath: string) => Promise<void>,
  options: WithTempVaultOptions = {}
): Promise<void> {
  const { files = [], schema = MINIMAL_SCHEMA, includeTemplates } = options;

  const vaultPath = await createTempVault(files, schema, includeTemplates);
  const relativePath = getRelativePath(vaultPath);
  try {
    // Use relative path via BWRB_VAULT env var
    const proc = spawnBowerbird(args, { 
      cwd: vaultPath,  // Still pass absolute path for internal use
      env: { BWRB_VAULT: relativePath }  // But set env var to relative
    });
    try {
      await fn(proc, vaultPath);
    } finally {
      if (!proc.hasExited()) {
        proc.kill();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    await cleanupTempVault(vaultPath);
  }
}

// ============================================================================
// Test Environment Detection
// ============================================================================

/**
 * Test if node-pty can spawn processes in this environment.
 * Caches the result after first call.
 */
let _ptyWorks: boolean | null = null;
export function canUsePty(): boolean {
  if (_ptyWorks !== null) return _ptyWorks;
  
  try {
    // Try to spawn a simple echo command
    const testProc = pty.spawn('/bin/echo', ['test'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    testProc.kill();
    _ptyWorks = true;
  } catch {
    _ptyWorks = false;
  }
  
  return _ptyWorks;
}

/**
 * Check if PTY tests should be skipped (e.g., in CI without TTY, or node-pty incompatible).
 */
export function shouldSkipPtyTests(): boolean {
  // Skip in CI without TTY
  if (process.env.CI && !process.stdout.isTTY) {
    return true;
  }
  
  // Skip if node-pty doesn't work (e.g., Node.js version incompatibility)
  if (!canUsePty()) {
    return true;
  }
  
  return false;
}
