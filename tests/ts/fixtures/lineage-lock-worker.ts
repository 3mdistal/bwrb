import { appendFile, mkdir, open, unlink } from 'fs/promises';
import { dirname } from 'path';
import { createInterface } from 'readline';
import {
  withOwnershipFileLock,
  type OwnershipFileLockOptions,
} from '../../../src/lib/lineage-lock.js';

type WorkerMode = 'hold' | 'stress';

interface WorkerConfig {
  mode: WorkerMode;
  lockPath: string;
  options: OwnershipFileLockOptions;
  sentinelPath?: string;
  journalPath?: string;
  iterations?: number;
}

interface WorkerCommand {
  command: 'start' | 'release' | 'crash';
}

const config = JSON.parse(process.argv[2] ?? '') as WorkerConfig;
const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();

function send(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...data })}\n`);
}

async function nextCommand(expected: WorkerCommand['command'][]): Promise<WorkerCommand> {
  const result = await commands.next();
  if (result.done) throw new Error(`stdin closed while waiting for ${expected.join(' or ')}`);
  const command = JSON.parse(result.value) as WorkerCommand;
  if (!expected.includes(command.command)) {
    throw new Error(`Expected ${expected.join(' or ')}, received ${command.command}`);
  }
  return command;
}

async function hold(): Promise<void> {
  await withOwnershipFileLock(config.lockPath, async () => {
    send('acquired');
    const command = await nextCommand(['release', 'crash']);
    if (command.command === 'crash') {
      // Deliberately bypass finally/release to leave a real dead-owner lock.
      process.exit(70);
    }
  }, config.options, 'worker lock timeout');
  send('released');
}

async function stress(): Promise<void> {
  if (!config.sentinelPath || !config.journalPath || !config.iterations) {
    throw new Error('Stress mode requires sentinelPath, journalPath, and iterations');
  }

  await mkdir(dirname(config.journalPath), { recursive: true });
  for (let iteration = 0; iteration < config.iterations; iteration++) {
    await withOwnershipFileLock(config.lockPath, async () => {
      let sentinel: Awaited<ReturnType<typeof open>> | undefined;
      try {
        sentinel = await open(config.sentinelPath!, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          send('overlap', { iteration });
        }
        throw error;
      }

      try {
        await appendFile(config.journalPath!, `${JSON.stringify({ event: 'enter', pid: process.pid, iteration })}\n`);
        // Widen the critical section across two event-loop turns. The sentinel
        // makes overlap detection deterministic even if journal appends race.
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        await appendFile(config.journalPath!, `${JSON.stringify({ event: 'exit', pid: process.pid, iteration })}\n`);
      } finally {
        await sentinel.close();
        await unlink(config.sentinelPath!).catch(() => undefined);
      }
    }, config.options, 'worker lock timeout');
  }
  send('done');
}

async function main(): Promise<void> {
  send('ready');
  await nextCommand(['start']);
  if (config.mode === 'hold') await hold();
  else await stress();
  process.stdin.destroy();
}

main().catch(error => {
  send('fatal', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  process.stdin.destroy();
});
