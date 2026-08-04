import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import {
  ownershipFileLockIsLive,
  withOwnershipFileLock,
} from './lineage-lock.js';
import type { NoteIdentityStore } from './note-id.js';

const MIGRATION_LOCK = '.bwrb/locks/identity-migration.lock';
const TRANSACTION_DIR = '.bwrb/locks/identity-transactions';
const RETRY_MS = 20;
const ATTEMPTS = 250;
const STALE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const LOCK_OPTIONS = {
  retryMs: RETRY_MS,
  attempts: ATTEMPTS,
  staleMs: STALE_MS,
  heartbeatMs: HEARTBEAT_MS,
};

/**
 * Register one identity-relevant vault mutation without serializing it with
 * unrelated mutations. A migration raises an exclusive fence, then waits for
 * these independent leases to drain before changing identity authority.
 */
export async function withNoteIdentityTransaction<T>(
  vaultDir: string,
  expectedStore: NoteIdentityStore,
  task: () => Promise<T>
): Promise<T> {
  const transactionDir = resolve(vaultDir, TRANSACTION_DIR);
  const migrationLock = resolve(vaultDir, MIGRATION_LOCK);
  await mkdir(transactionDir, { recursive: true });
  const leasePath = join(transactionDir, `${process.pid}-${randomUUID()}.lease`);

  return withOwnershipFileLock(
    leasePath,
    async () => {
      if (await ownershipFileLockIsLive(migrationLock, LOCK_OPTIONS)) {
        throw new Error('Note identity migration is in progress; retry the command.');
      }
      const liveStore = await readLiveIdentityStore(vaultDir);
      if (liveStore !== expectedStore) {
        throw new Error(
          `Note identity storage changed (${expectedStore} -> ${liveStore}); retry the command.`
        );
      }
      return task();
    },
    LOCK_OPTIONS,
    'Timed out starting a note identity transaction; retry the command.'
  );
}

/** Exclusively fence identity-relevant Bowerbird mutations for a mode switch. */
export async function withIdentityMigrationFence<T>(
  vaultDir: string,
  task: () => Promise<T>
): Promise<T> {
  const migrationLock = resolve(vaultDir, MIGRATION_LOCK);
  await mkdir(dirname(migrationLock), { recursive: true });
  return withOwnershipFileLock(
    migrationLock,
    async () => {
      await waitForTransactionsToDrain(resolve(vaultDir, TRANSACTION_DIR));
      return task();
    },
    LOCK_OPTIONS,
    'Timed out waiting to migrate note identity; retry the command.'
  );
}

async function readLiveIdentityStore(vaultDir: string): Promise<NoteIdentityStore> {
  const raw = JSON.parse(await readFile(resolve(vaultDir, '.bwrb/schema.json'), 'utf-8')) as {
    config?: { identity_store?: unknown };
  };
  const store = raw.config?.identity_store ?? 'registry-v1';
  if (store !== 'registry-v1' && store !== 'frontmatter-v1') {
    throw new Error(`Unsupported note identity store '${String(store)}'.`);
  }
  return store;
}

async function waitForTransactionsToDrain(transactionDir: string): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const entries = await readdir(transactionDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    });
    let live = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.lease')) continue;
      if (await ownershipFileLockIsLive(join(transactionDir, entry), LOCK_OPTIONS)) {
        live++;
      }
    }
    if (live === 0) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, RETRY_MS));
  }
  throw new Error('Timed out waiting for active note transactions; retry identity migration.');
}
