import { randomUUID } from 'crypto';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, relative } from 'path';

const ID_REGISTRY_RELATIVE_PATH = '.bwrb/ids.jsonl';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_GENERATION_ATTEMPTS = 1000;

function getIdRegistryPath(vaultDir: string): string {
  return join(vaultDir, ID_REGISTRY_RELATIVE_PATH);
}

export interface IdRegistryEntry {
  id: string;
  createdAt: string;
  path?: string;
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

    if (UUID_RE.test(trimmed)) {
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
  const registryPath = getIdRegistryPath(vaultDir);
  await mkdir(dirname(registryPath), { recursive: true });

  const entry: IdRegistryEntry = {
    id,
    createdAt: new Date().toISOString(),
    path: relative(vaultDir, notePath),
  };

  await appendFile(registryPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export function ensureIdInFieldOrder(order: string[]): string[] {
  if (order.includes('id')) return order;
  return ['id', ...order];
}
