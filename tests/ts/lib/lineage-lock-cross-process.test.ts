import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, readdir, rm, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  getLineageMutationLockPath,
  type OwnershipFileLockOptions,
} from '../../../src/lib/lineage-lock.js';
import { cleanupTestVault, createTestVault } from '../fixtures/setup.js';

interface WorkerEvent {
  event: string;
  pid: number;
  iteration?: number;
  message?: string;
}

interface WorkerConfig {
  mode: 'hold' | 'stress';
  lockPath: string;
  options: OwnershipFileLockOptions;
  sentinelPath?: string;
  journalPath?: string;
  iterations?: number;
}

const PROJECT_ROOT = process.cwd();
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORKER = join(PROJECT_ROOT, 'tests', 'ts', 'fixtures', 'lineage-lock-worker.ts');
const EVENT_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 8_000;

class LockWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: WorkerEvent[] = [];
  readonly exit: Promise<number | null>;
  private readonly waiters = new Set<() => void>();
  private stdoutBuffer = '';
  private stderr = '';

  constructor(config: WorkerConfig) {
    this.process = spawn(process.execPath, [TSX_CLI, WORKER, JSON.stringify(config)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.consumeStdout(chunk));
    this.process.stderr.on('data', chunk => { this.stderr += chunk; });
    this.exit = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('close', code => {
        for (const wake of this.waiters) wake();
        resolve(code);
      });
    });
  }

  send(command: 'start' | 'release' | 'crash'): void {
    this.process.stdin.write(`${JSON.stringify({ command })}\n`);
  }

  async waitFor(event: string): Promise<WorkerEvent> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (true) {
      const index = this.events.findIndex(candidate => candidate.event === event);
      if (index >= 0) return this.events.splice(index, 1)[0]!;

      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.process.exitCode !== null) {
        throw new Error(
          `Worker ${this.process.pid ?? 'unknown'} did not emit ${event}; ` +
          `exit=${this.process.exitCode}, stderr=${this.stderr}, events=${JSON.stringify(this.events)}`
        );
      }
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`Timed out waiting for worker event ${event}; stderr=${this.stderr}`));
        }, remaining);
        this.waiters.add(wake);
      });
    }
  }

  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGKILL');
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.events.push(JSON.parse(line) as WorkerEvent);
      for (const wake of this.waiters) wake();
    }
  }
}

class BuiltCli {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exit: Promise<number | null>;
  stdout = '';
  stderr = '';
  private readonly waiters = new Set<() => void>();

  constructor(vaultDir: string, args: string[]) {
    this.process = spawn(process.execPath, [join(PROJECT_ROOT, 'dist', 'index.js'), '--vault', vaultDir, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', chunk => {
      this.stdout += chunk;
      for (const wake of this.waiters) wake();
    });
    this.process.stderr.on('data', chunk => {
      this.stderr += chunk;
      for (const wake of this.waiters) wake();
    });
    this.exit = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('close', code => {
        for (const wake of this.waiters) wake();
        resolve(code);
      });
    });
  }

  async waitForOutput(text: string): Promise<void> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (!`${this.stdout}\n${this.stderr}`.includes(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.process.exitCode !== null) {
        throw new Error(
          `CLI did not print ${JSON.stringify(text)}; exit=${this.process.exitCode}, ` +
          `stdout=${this.stdout}, stderr=${this.stderr}`
        );
      }
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`Timed out waiting for CLI output ${JSON.stringify(text)}`));
        }, remaining);
        this.waiters.add(wake);
      });
    }
  }

  async expectStillRunningFor(ms: number): Promise<void> {
    const exited = await Promise.race([
      this.exit.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), ms)),
    ]);
    if (exited) {
      throw new Error(`CLI exited before reaching the held lock; stdout=${this.stdout}, stderr=${this.stderr}`);
    }
  }

  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGKILL');
    }
  }
}

describe.sequential('cross-process ownership file lock', () => {
  let tempDir: string;
  let lockPath: string;
  const workers: LockWorker[] = [];
  const clis: BuiltCli[] = [];
  const vaults: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bwrb-lock-cross-process-'));
    lockPath = join(tempDir, '.bwrb', 'locks', 'shared.lock');
  });

  afterEach(async () => {
    for (const worker of workers) worker.kill();
    for (const cli of clis) cli.kill();
    await Promise.allSettled(workers.map(worker => worker.exit));
    await Promise.allSettled(clis.map(cli => cli.exit));
    workers.length = 0;
    clis.length = 0;
    await Promise.all(vaults.map(vault => cleanupTestVault(vault)));
    vaults.length = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('protects a live open-handle holder and closes before artifact cleanup', async () => {
    const holder = startWorker({
      mode: 'hold',
      lockPath,
      options: { retryMs: 5, attempts: 200, staleMs: 60, heartbeatMs: 10 },
    });
    await holder.waitFor('ready');
    holder.send('start');
    const acquired = await holder.waitFor('acquired');

    const contender = startWorker({
      mode: 'hold',
      lockPath,
      options: { retryMs: 5, attempts: 15, staleMs: 60, heartbeatMs: 10 },
    });
    await contender.waitFor('ready');
    contender.send('start');
    const fatal = await contender.waitFor('fatal');
    expect(fatal.message).toBe('worker lock timeout');
    expect(await contender.exit).toBe(1);

    const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(metadata.pid).toBe(acquired.pid);

    holder.send('release');
    await holder.waitFor('released');
    expect(await holder.exit).toBe(0);
    await expectNoArtifacts(lockPath);
  });

  it('recovers a dead holder, protects its successor, and cleans recovery artifacts', async () => {
    const crashed = startWorker({
      mode: 'hold',
      lockPath,
      options: { retryMs: 5, attempts: 200, staleMs: 60, heartbeatMs: 10 },
    });
    await crashed.waitFor('ready');
    crashed.send('start');
    await crashed.waitFor('acquired');
    crashed.send('crash');
    expect(await crashed.exit).toBe(70);

    const successor = startWorker({
      mode: 'hold',
      lockPath,
      options: { retryMs: 5, attempts: 400, staleMs: 60, heartbeatMs: 10 },
    });
    await successor.waitFor('ready');
    successor.send('start');
    const acquired = await successor.waitFor('acquired');
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }).pid).toBe(acquired.pid);

    const contender = startWorker({
      mode: 'hold',
      lockPath,
      options: { retryMs: 5, attempts: 15, staleMs: 60, heartbeatMs: 10 },
    });
    await contender.waitFor('ready');
    contender.send('start');
    expect((await contender.waitFor('fatal')).message).toBe('worker lock timeout');
    expect(await contender.exit).toBe(1);
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }).pid).toBe(acquired.pid);

    successor.send('release');
    await successor.waitFor('released');
    expect(await successor.exit).toBe(0);
    await expectNoArtifacts(lockPath);
  });

  it('serializes a deterministic multi-process critical-section stress run', async () => {
    const journalPath = join(tempDir, 'journal.ndjson');
    const sentinelPath = join(tempDir, 'critical-section.active');
    const options = { retryMs: 2, attempts: 2_000, staleMs: 1_000, heartbeatMs: 50 };
    const contenders = Array.from({ length: 4 }, () => startWorker({
      mode: 'stress',
      lockPath,
      options,
      sentinelPath,
      journalPath,
      iterations: 12,
    }));

    await Promise.all(contenders.map(worker => worker.waitFor('ready')));
    for (const worker of contenders) worker.send('start');
    await Promise.all(contenders.map(worker => worker.waitFor('done')));
    expect(await Promise.all(contenders.map(worker => worker.exit))).toEqual([0, 0, 0, 0]);
    expect(contenders.flatMap(worker => worker.events).find(event => event.event === 'overlap')).toBeUndefined();

    const journal = (await readFile(journalPath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { event: 'enter' | 'exit'; pid: number; iteration: number });
    expect(journal).toHaveLength(4 * 12 * 2);
    for (let index = 0; index < journal.length; index += 2) {
      const enter = journal[index]!;
      const exit = journal[index + 1]!;
      expect(enter.event).toBe('enter');
      expect(exit).toEqual({ event: 'exit', pid: enter.pid, iteration: enter.iteration });
    }
    expect(existsSync(sentinelPath)).toBe(false);
    await expectNoArtifacts(lockPath);
  });

  it('classifies under-lock delete disappearance in the actual built CLI text and JSON contracts', async () => {
    const vaultDir = await createTestVault();
    vaults.push(vaultDir);

    const textTarget = join(vaultDir, 'Ideas', 'Sample Idea.md');
    const textLock = startWorker({
      mode: 'hold',
      lockPath: getLineageMutationLockPath(vaultDir, textTarget),
      options: { retryMs: 5, attempts: 400, staleMs: 1_000, heartbeatMs: 50 },
    });
    await textLock.waitFor('ready');
    textLock.send('start');
    await textLock.waitFor('acquired');

    const textCli = startCli(vaultDir, ['delete', 'Sample Idea']);
    textCli.process.stdin.end('y\n');
    await textCli.waitForOutput('File to delete: Ideas/Sample Idea.md');
    await unlink(textTarget);
    textLock.send('release');
    await textLock.waitFor('released');

    expect(await textCli.exit).toBe(2);
    expect(textCli.stderr).toContain(
      'Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Sample Idea.md'
    );
    expect(textCli.stderr).not.toContain('File not found or already deleted');
    await expectNoArtifacts(getLineageMutationLockPath(vaultDir, textTarget));

    const jsonTarget = join(vaultDir, 'Ideas', 'Another Idea.md');
    const jsonLock = startWorker({
      mode: 'hold',
      lockPath: getLineageMutationLockPath(vaultDir, jsonTarget),
      options: { retryMs: 5, attempts: 400, staleMs: 1_000, heartbeatMs: 50 },
    });
    await jsonLock.waitFor('ready');
    jsonLock.send('start');
    await jsonLock.waitFor('acquired');

    const jsonCli = startCli(vaultDir, [
      'delete', '--path', 'Ideas/Another Idea.md', '--execute', '--output', 'json',
    ]);
    jsonCli.process.stdin.end();
    // The held lock has no observer hook. A bounded alive check is the one
    // timing allowance in this test: built dist startup/selection is complete
    // well before this on both local and focused Windows CI, and an early exit
    // fails with its captured output instead of being silently retried.
    await jsonCli.expectStillRunningFor(process.platform === 'win32' ? 2_000 : 750);
    await unlink(jsonTarget);
    jsonLock.send('release');
    await jsonLock.waitFor('released');

    expect(await jsonCli.exit).toBe(2);
    expect(JSON.parse(jsonCli.stdout)).toEqual({
      success: false,
      error: 'Delete target disappeared while waiting for the lineage lock; retry the command: Ideas/Another Idea.md',
      data: {
        reason: 'target-disappeared',
        retryable: true,
        paths: ['Ideas/Another Idea.md'],
      },
      code: 2,
    });
    await expectNoArtifacts(getLineageMutationLockPath(vaultDir, jsonTarget));
  });

  function startWorker(config: WorkerConfig): LockWorker {
    const worker = new LockWorker(config);
    workers.push(worker);
    return worker;
  }

  function startCli(vaultDir: string, args: string[]): BuiltCli {
    const cli = new BuiltCli(vaultDir, args);
    clis.push(cli);
    return cli;
  }
});

async function expectNoArtifacts(lockPath: string): Promise<void> {
  const entries = await readdir(join(lockPath, '..')).catch(() => []);
  expect(entries.filter(entry => entry.startsWith(basename(lockPath)))).toEqual([]);
}
