import { readFile } from 'fs/promises';
import { join } from 'path';
import { buildVaultNoteSnapshot } from './discovery.js';
import {
  generateUniqueNoteId,
  isValidNoteId,
  normalizeNoteId,
  registerIssuedNoteIds,
  withNoteIdAssignmentLock,
  type NoteIdRegistration,
} from './note-id.js';
import { loadSchema } from './schema.js';

export interface IdentityBackfillResult {
  mode: 'dry-run' | 'execute';
  type: string;
  missing: number;
  changes: Array<{ path: string; id?: string; status: 'planned' | 'applied' }>;
}

async function registryState(vaultDir: string): Promise<{ paths: Set<string>; ids: Set<string> }> {
  const paths = new Set<string>();
  const ids = new Set<string>();
  const raw = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf8').catch(() => '');
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let row: { id?: unknown; path?: unknown };
    try { row = JSON.parse(line) as { id?: unknown; path?: unknown }; }
    catch { throw new Error(`Malformed identity registry row ${index + 1}`); }
    if (!isValidNoteId(row.id) || typeof row.path !== 'string') throw new Error(`Invalid identity registry row ${index + 1}`);
    const id = normalizeNoteId(row.id);
    if (ids.has(id)) throw new Error(`Duplicate identity registry ID ${row.id}`);
    if (paths.has(row.path)) throw new Error(`Duplicate identity registry path ${row.path}`);
    ids.add(id);
    paths.add(row.path);
  }
  return { paths, ids };
}

async function missingPaths(vaultDir: string, type: string, exactPath?: string): Promise<string[]> {
  const schema = await loadSchema(vaultDir);
  if (schema.config.identityStore !== 'registry-v1') throw new Error('identity backfill requires registry-v1');
  const registry = await registryState(vaultDir);
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  if (exactPath) {
    const note = snapshot.notes.find((candidate) => candidate.relativePath === exactPath);
    if (!note || note.resolvedType !== type || !note.frontmatter) throw new Error(`No readable ${type} note at ${exactPath}`);
    return registry.paths.has(exactPath) ? [] : [exactPath];
  }
  return snapshot.notes
    .filter((note) => note.resolvedType === type && note.frontmatter && !registry.paths.has(note.relativePath))
    .map((note) => note.relativePath)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export async function backfillRegistryIdentities(
  vaultDir: string,
  type: string,
  execute: boolean,
  exactPath?: string
): Promise<IdentityBackfillResult> {
  const planned = await missingPaths(vaultDir, type, exactPath);
  if (!execute) return { mode: 'dry-run', type, missing: planned.length, changes: planned.map((path) => ({ path, status: 'planned' })) };

  return withNoteIdAssignmentLock(vaultDir, async () => {
    const live = await missingPaths(vaultDir, type, exactPath);
    if (live.join('\n') !== planned.join('\n')) throw new Error('Identity closure changed during backfill; retry the dry-run.');
    const schema = await loadSchema(vaultDir);
    const registrations: NoteIdRegistration[] = [];
    const allocated = (await registryState(vaultDir)).ids;
    for (const path of live) {
      let id = await generateUniqueNoteId(vaultDir, schema);
      while (allocated.has(normalizeNoteId(id))) id = await generateUniqueNoteId(vaultDir, schema);
      allocated.add(normalizeNoteId(id));
      registrations.push({ id, notePath: join(vaultDir, path) });
    }
    await registerIssuedNoteIds(vaultDir, registrations, schema.config.identityStore);
    return {
      mode: 'execute' as const,
      type,
      missing: registrations.length,
      changes: registrations.map(({ id, notePath }, index) => ({ path: live[index] ?? notePath, id, status: 'applied' as const })),
    };
  });
}
