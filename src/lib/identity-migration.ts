import { buildVaultNoteSnapshot, type VaultNoteSnapshot } from './discovery.js';
import {
  isValidNoteId,
  normalizeNoteId,
  rebuildIssuedNoteRegistry,
  type NoteIdentityStore,
  type NoteIdRegistration,
} from './note-id.js';
import { withSchemaMutation } from './schema-writer.js';
import type { LoadedSchema } from '../types/schema.js';
import { loadSchema } from './schema.js';
import { withIdentityMigrationFence } from './identity-transaction.js';

export interface IdentityMigrationBlocker {
  code: 'unreadable-note' | 'missing-note-id' | 'invalid-note-id' | 'duplicate-note-id';
  path: string;
  id?: unknown;
  paths?: string[];
}

export interface IdentityMigrationResult {
  mode: 'dry-run' | 'execute';
  from: NoteIdentityStore;
  to: NoteIdentityStore;
  notes: {
    total: number;
    valid: number;
    missing: number;
    invalid: number;
    duplicate: number;
  };
  blockers: IdentityMigrationBlocker[];
  changes: Array<{
    path: string;
    action: 'set-identity-store' | 'rebuild-registry';
    status: 'planned' | 'applied';
  }>;
}

interface IdentityPreflight {
  blockers: IdentityMigrationBlocker[];
  registrations: NoteIdRegistration[];
  counts: IdentityMigrationResult['notes'];
}

export async function migrateIdentityStore(
  schema: LoadedSchema,
  vaultDir: string,
  target: NoteIdentityStore,
  execute: boolean
): Promise<IdentityMigrationResult> {
  if (!execute) {
    return planIdentityMigration(schema, vaultDir, target, false);
  }

  return withIdentityMigrationFence(vaultDir, () =>
    withSchemaMutation(vaultDir, async raw => {
      const liveSchema = await loadSchema(vaultDir);
      if (liveSchema.config.identityStore !== schema.config.identityStore) {
        throw new Error(
          `Identity storage changed during migration (${schema.config.identityStore} -> ` +
          `${liveSchema.config.identityStore}); retry the command.`
        );
      }
      const result = await planIdentityMigration(liveSchema, vaultDir, target, true);
      const write = liveSchema.config.identityStore !== target;
      if (write) {
        raw.config ??= {};
        raw.config.identity_store = target;
      }
      return { result, write };
    })
  );
}

async function planIdentityMigration(
  schema: LoadedSchema,
  vaultDir: string,
  target: NoteIdentityStore,
  execute: boolean
): Promise<IdentityMigrationResult> {
  const current = schema.config.identityStore;
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  const preflight = preflightIdentity(snapshot);
  const status = execute ? 'applied' : 'planned';
  const changes: IdentityMigrationResult['changes'] = [];

  if (current !== target) {
    if (target === 'registry-v1') {
      changes.push({ path: '.bwrb/ids.jsonl', action: 'rebuild-registry', status });
    }
    changes.push({ path: '.bwrb/schema.json', action: 'set-identity-store', status });
  }

  if (execute && current !== target && preflight.blockers.length > 0) {
    throw new IdentityMigrationBlockedError(preflight.blockers);
  }

  if (execute && current !== target) {
    if (target === 'registry-v1') {
      // Build the legacy completion record before switching modes. If the
      // schema write fails, frontmatter remains authoritative and this file is
      // inert, so retry is safe.
      await rebuildIssuedNoteRegistry(vaultDir, preflight.registrations);
    }
  }

  return {
    mode: execute ? 'execute' : 'dry-run',
    from: current,
    to: target,
    notes: preflight.counts,
    blockers: preflight.blockers,
    changes,
  };
}

export class IdentityMigrationBlockedError extends Error {
  constructor(readonly blockers: IdentityMigrationBlocker[]) {
    super(
      `Identity migration blocked by ${blockers.length} note identity issue(s); ` +
      'run the dry-run with --output json for exact paths.'
    );
    this.name = 'IdentityMigrationBlockedError';
  }
}

function preflightIdentity(snapshot: VaultNoteSnapshot): IdentityPreflight {
  const blockers: IdentityMigrationBlocker[] = [];
  const registrations: NoteIdRegistration[] = [];
  const notesById = new Map<string, Array<{ path: string; absolutePath: string; id: string }>>();
  let valid = 0;
  let missing = 0;
  let invalid = 0;

  for (const note of snapshot.notes) {
    if (!note.frontmatter) {
      blockers.push({ code: 'unreadable-note', path: note.relativePath });
      invalid++;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(note.frontmatter, 'id')) {
      blockers.push({ code: 'missing-note-id', path: note.relativePath });
      missing++;
      continue;
    }
    const id = note.frontmatter.id;
    if (!isValidNoteId(id)) {
      blockers.push({ code: 'invalid-note-id', path: note.relativePath, id });
      invalid++;
      continue;
    }
    valid++;
    const key = normalizeNoteId(id);
    const matches = notesById.get(key) ?? [];
    matches.push({ path: note.relativePath, absolutePath: note.path, id });
    notesById.set(key, matches);
  }

  let duplicate = 0;
  for (const matches of notesById.values()) {
    if (matches.length > 1) {
      const paths = matches.map(match => match.path).sort((a, b) => a.localeCompare(b, 'en'));
      duplicate += matches.length;
      for (const match of matches) {
        blockers.push({
          code: 'duplicate-note-id',
          path: match.path,
          id: match.id,
          paths,
        });
      }
      continue;
    }
    const match = matches[0]!;
    registrations.push({ id: match.id, notePath: match.absolutePath });
  }

  blockers.sort((a, b) =>
    a.path.localeCompare(b.path, 'en') || a.code.localeCompare(b.code, 'en')
  );

  return {
    blockers,
    registrations,
    counts: {
      total: snapshot.notes.length,
      valid,
      missing,
      invalid,
      duplicate,
    },
  };
}
