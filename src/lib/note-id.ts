import { randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import {
  type OwnershipFileLockOptions,
  withOwnershipFileLock,
} from './lineage-lock.js';

const ID_REGISTRY_RELATIVE_PATH = '.bwrb/ids.jsonl';
const ID_ASSIGNMENT_LOCK = '.bwrb/locks/fork-source-id.lock';
const ID_REGISTRY_LOCK = '.bwrb/locks/id-registry.lock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_GENERATION_ATTEMPTS = 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;
const HEARTBEAT_MS = 10_000;

const NOTE_ID_LOCK_OPTIONS: OwnershipFileLockOptions = {
  retryMs: LOCK_RETRY_MS,
  attempts: LOCK_ATTEMPTS,
  staleMs: STALE_LOCK_MS,
  heartbeatMs: HEARTBEAT_MS,
};

/** Return whether a value is a UUID-shaped stable note ID. */
export function isValidNoteId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Return the canonical comparison key for a stable note ID.
 *
 * UUID hex digits are case-insensitive. Keep the authored value in frontmatter
 * and diagnostics, but use this normalized identity at map/set boundaries.
 */
export function normalizeNoteId(id: string): string {
  return id.toLowerCase();
}

function getIdRegistryPath(vaultDir: string): string {
  return join(vaultDir, ID_REGISTRY_RELATIVE_PATH);
}

export interface IdRegistryEntry {
  id: string;
  createdAt: string;
  path?: string;
}

export interface NoteIdRegistration {
  id: string;
  notePath: string;
}

async function readIssuedIds(vaultDir: string): Promise<Set<string>> {
  const registryPath = getIdRegistryPath(vaultDir);
  if (!existsSync(registryPath)) return new Set();

  const content = await readFile(registryPath, 'utf-8');
  const ids = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Current format is JSONL, but tolerate legacy/plain lines if they exist.
    try {
      const parsed = JSON.parse(trimmed) as Partial<IdRegistryEntry>;
      if (typeof parsed.id === 'string' && parsed.id.length > 0) {
        ids.add(parsed.id);
      }
      continue;
    } catch {
      // fall through
    }

    if (isValidNoteId(trimmed)) {
      ids.add(trimmed);
    }
  }

  return ids;
}

export async function generateUniqueNoteId(vaultDir: string): Promise<string> {
  const issued = await readIssuedIds(vaultDir);

  for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt++) {
    const id = randomUUID();
    if (!issued.has(id)) return id;
  }

  throw new Error(
    `Failed to generate a unique note ID after ${MAX_ID_GENERATION_ATTEMPTS} attempts`
  );
}

export async function registerIssuedNoteId(
  vaultDir: string,
  id: string,
  notePath: string
): Promise<void> {
  await registerIssuedNoteIds(vaultDir, [{ id, notePath }]);
}

/** Register several newly assigned IDs as one atomic registry mutation. */
export async function registerIssuedNoteIds(
  vaultDir: string,
  registrations: NoteIdRegistration[]
): Promise<void> {
  if (registrations.length === 0) return;
  await withNoteIdRegistryLock(vaultDir, async () => {
    const registryPath = getIdRegistryPath(vaultDir);
    const current = await readFile(registryPath, 'utf-8').catch(error => {
      if (isFileMissingError(error)) return '';
      throw error;
    });
    const createdAt = new Date().toISOString();
    const rows = registrations.map(({ id, notePath }) => JSON.stringify({
      id,
      createdAt,
      path: relative(vaultDir, notePath),
    } satisfies IdRegistryEntry));
    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await writeRegistryAtomic(registryPath, `${current}${separator}${rows.join('\n')}\n`);
  });
}

export async function unregisterIssuedNotePath(
  vaultDir: string,
  relativePath: string
): Promise<void> {
  await withNoteIdRegistryLock(vaultDir, async () => {
    const registryPath = getIdRegistryPath(vaultDir);
    if (!existsSync(registryPath)) return;

    const content = await readFile(registryPath, 'utf-8');
    const retained: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as Partial<IdRegistryEntry>;
        if (parsed.path === relativePath) continue;
      } catch {
        // Keep legacy/plain lines because they cannot be matched to a path.
      }

      retained.push(line);
    }

    const nextContent = retained.length > 0 ? `${retained.join('\n')}\n` : '';
    await writeRegistryAtomic(registryPath, nextContent);
  });
}

/** Serialize legacy ID backfills across fork and lineage-adoption flows. */
export async function withNoteIdAssignmentLock<T>(
  vaultDir: string,
  task: () => Promise<T>,
  optionOverrides: Partial<OwnershipFileLockOptions> = {}
): Promise<T> {
  return withOwnershipFileLock(
    resolve(vaultDir, ID_ASSIGNMENT_LOCK),
    task,
    { ...NOTE_ID_LOCK_OPTIONS, ...optionOverrides },
    'Timed out waiting to assign a note ID; retry the command.'
  );
}

export function ensureIdInFieldOrder(order: string[]): string[] {
  if (order.includes('id')) return order;
  return ['id', ...order];
}

export async function withNoteIdRegistryLock<T>(
  vaultDir: string,
  task: () => Promise<T>,
  optionOverrides: Partial<OwnershipFileLockOptions> = {}
): Promise<T> {
  return withOwnershipFileLock(
    resolve(vaultDir, ID_REGISTRY_LOCK),
    task,
    { ...NOTE_ID_LOCK_OPTIONS, ...optionOverrides },
    'Timed out waiting to update the note ID registry; retry the command.'
  );
}

async function writeRegistryAtomic(registryPath: string, content: string): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  const tempPath = join(
    dirname(registryPath),
    `.${basename(registryPath)}.bwrb-${process.pid}-${randomUUID()}.tmp`
  );
  const mode = await stat(registryPath).then(info => info.mode).catch(() => undefined);
  const handle = await open(tempPath, 'wx', mode);
  let renamed = false;
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    await rename(tempPath, registryPath);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
