/**
 * Patch batches: apply a different JSON patch to each of many exactly named
 * notes in one invocation (`bwrb edit --patches`).
 *
 * Every patch goes through the same steps as `edit --json`, against one shared
 * read of the vault instead of a fresh one per note. Previewing writes
 * nothing. Executing is all or nothing: every note's new bytes are built
 * before the first write, every note is rechecked under its mutation lock, and
 * a write that fails midway restores the notes this run already wrote.
 */

import { open, readFile } from 'fs/promises';
import { isAbsolute, posix } from 'path';
import { isDeepStrictEqual } from 'util';
import type { LoadedSchema } from '../types/schema.js';
import {
  buildVaultNoteSnapshotFromFiles,
  deriveNoteTargetIndex,
  discoverManagedFiles,
  type ManagedFile,
  type NoteTargetIndex,
  type VaultNoteSnapshot,
} from './discovery.js';
import { buildNoteContent, parseNote, writeFileAtomic } from './frontmatter.js';
import {
  rejectReservedPatchFields,
  resolveJsonEdit,
  validateJsonEditAgainstVault,
  type JsonEditRejection,
  type JsonEditVaultContext,
  type ResolvedJsonEdit,
} from './edit.js';
import { parentEdge } from './hierarchy.js';
import { withLineageMutationLocks } from './lineage-lock.js';
import { isValidNoteId, normalizeNoteId } from './note-id.js';
import { noteRevision } from './note-revision.js';
import { rollbackNoteIfUnchanged } from './note-write-concurrency.js';
import { ExitCodes, type ExitCode } from './output.js';
import { prepareRecurrenceFastPath } from './recurrence-fast-path.js';
import { entersTransitionEffects } from './transition-effects.js';
import { assertTransitionGuards, transitionGuardTargetPaths } from './transition-guards.js';
import { createNoteTargetIndexSource } from './validation.js';

// ============================================================================
// Types
// ============================================================================

export type PatchNoteStatus =
  | 'planned'
  | 'unchanged'
  | 'blocked'
  | 'applied'
  | 'restored'
  | 'failed'
  | 'not-attempted';

export type PatchErrorCode =
  | 'INVALID_ENTRY'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_MISMATCH'
  | 'DUPLICATE_TARGET'
  | 'READ_FAILED'
  | 'REVISION_MISMATCH'
  | 'NOTE_CHANGED'
  | 'BODY_NOT_SUPPORTED'
  | 'VALIDATION_FAILED'
  | 'TRANSITION_GUARD_FAILED'
  | 'RELATED_WRITES_NOT_SUPPORTED'
  | 'WRITE_FAILED'
  | 'RESTORE_SKIPPED'
  | 'RESTORE_FAILED';

export interface PatchNoteError {
  code: PatchErrorCode;
  message: string;
  /** Field-level detail, exactly as `edit --json` reports it. */
  errors?: unknown[];
  expectedRevision?: string;
  currentRevision?: string;
  data?: unknown;
}

export interface PatchNoteResult {
  /** Position of the entry in the manifest's `notes` array. */
  index: number;
  id: string | null;
  /** Vault-relative path with forward slashes. */
  path: string | null;
  status: PatchNoteStatus;
  updated: string[];
  /** Revision the batch read the note at. */
  beforeRevision: string | null;
  /** Revision the note is at now; null when it was not read or not yet written. */
  revision: string | null;
  /** Fields the patch changes, after defaults and date normalization. */
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  errors?: PatchNoteError[];
}

export type PatchBatchCounts = { notes: number } & Record<PatchNoteStatus, number>;

export interface PatchBatchResult {
  mode: 'preview' | 'execute';
  counts: PatchBatchCounts;
  notes: PatchNoteResult[];
}

export interface PatchBatchOutcome {
  success: boolean;
  exitCode: ExitCode;
  /** Why the batch did not succeed. */
  error?: string;
  result: PatchBatchResult;
}

export interface PatchBatchOptions {
  execute?: boolean;
  /**
   * Internal hook called before each note write, used by fault fixtures to
   * fail a batch midway. The CLI never sets it.
   */
  beforeWrite?: (path: string) => Promise<void> | void;
}

/** The manifest as a whole is unusable; no note could be considered. */
export class PatchManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchManifestError';
  }
}

interface ManifestEntry {
  index: number;
  id?: string;
  path?: string;
  expectedRevision?: string;
  patch?: Record<string, unknown>;
  problems: string[];
}

interface PlannedNote {
  entry: ManifestEntry;
  result: PatchNoteResult;
  file?: ManagedFile;
  edit?: ResolvedJsonEdit;
  unchanged?: boolean;
  /** The bytes to write, built while planning. */
  content?: string;
  /** Notes the entered transition guards read, locked during the write. */
  guardPaths?: string[];
}

const ENTRY_KEYS = new Set(['id', 'path', 'expectedRevision', 'patch']);

// ============================================================================
// Manifest
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Parse a patch manifest: `{ "notes": [{ id?, path?, expectedRevision?, patch }] }`.
 *
 * A malformed manifest throws. A malformed entry is kept with its problems so
 * the batch can name it alongside every other blocker.
 */
function parsePatchManifest(text: string): ManifestEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PatchManifestError(`Invalid JSON in patch manifest: ${(error as Error).message}`);
  }
  if (!isPlainObject(value) || !Array.isArray(value['notes'])) {
    throw new PatchManifestError('A patch manifest must be an object with a "notes" array.');
  }
  const extraKeys = Object.keys(value).filter((key) => key !== 'notes');
  if (extraKeys.length > 0) {
    throw new PatchManifestError(`Unknown patch manifest key: ${extraKeys.join(', ')}. A manifest has only "notes".`);
  }
  const notes = value['notes'] as unknown[];
  if (notes.length === 0) {
    throw new PatchManifestError('The patch manifest has no notes.');
  }
  return notes.map((raw, index) => parseManifestEntry(raw, index));
}

function parseManifestEntry(raw: unknown, index: number): ManifestEntry {
  const entry: ManifestEntry = { index, problems: [] };
  if (!isPlainObject(raw)) {
    entry.problems.push('Each entry must be an object.');
    return entry;
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) {
      entry.problems.push(`Unknown key '${key}'. Entries take id, path, expectedRevision and patch.`);
    }
  }

  const { id, path, expectedRevision, patch } = raw;
  if (id !== undefined) {
    if (isValidNoteId(id)) entry.id = id;
    else entry.problems.push('id must be a note UUID.');
  }
  if (path !== undefined) {
    const slashed = typeof path === 'string' ? toSlashes(path) : '';
    if (!slashed) {
      entry.problems.push('path must be a non-empty string.');
    } else if (isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed) || slashed.split('/').includes('..')) {
      entry.problems.push('path must be relative to the vault root.');
    } else {
      entry.path = posix.normalize(slashed);
    }
  }
  if (id === undefined && path === undefined) {
    entry.problems.push('Each entry needs an id or a path.');
  }
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision === 'string' && expectedRevision.length > 0) entry.expectedRevision = expectedRevision;
    else entry.problems.push('expectedRevision must be a non-empty string.');
  }
  if (isPlainObject(patch)) entry.patch = patch;
  else entry.problems.push('patch must be an object of field values.');
  return entry;
}

// ============================================================================
// Planning
// ============================================================================

function block(note: PlannedNote, error: PatchNoteError): void {
  (note.result.errors ??= []).push(error);
}

function rejectionError(rejection: JsonEditRejection): PatchNoteError {
  return {
    code: 'VALIDATION_FAILED',
    message: rejection.message,
    ...(rejection.result.errors ? { errors: rejection.result.errors } : {}),
  };
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    changes[key] = {
      ...(key in before ? { from: before[key] } : {}),
      ...(key in after ? { to: after[key] } : {}),
    };
  }
  return changes;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

/** Resolve every entry to one note, or name why it can't be. */
async function resolveTargets(
  notes: PlannedNote[],
  files: ManagedFile[],
  fullSnapshot: () => Promise<VaultNoteSnapshot>
): Promise<void> {
  const byPath = new Map(files.map((file) => [toSlashes(file.relativePath), file]));
  let byId: Map<string, ManagedFile[]> | undefined;

  for (const note of notes) {
    const { entry } = note;
    if (entry.problems.length > 0) {
      for (const problem of entry.problems) block(note, { code: 'INVALID_ENTRY', message: problem });
      continue;
    }
    if (entry.path !== undefined) {
      const file = byPath.get(entry.path);
      if (file) note.file = file;
      else block(note, { code: 'TARGET_NOT_FOUND', message: `No note at ${entry.path}.` });
      continue;
    }

    // An id alone needs every note's frontmatter; read the vault once for all.
    if (!byId) {
      byId = new Map();
      const fileByPath = new Map(files.map((file) => [file.path, file]));
      for (const snapshotNote of (await fullSnapshot()).notes) {
        const noteId = snapshotNote.frontmatter?.['id'];
        const file = fileByPath.get(snapshotNote.path);
        if (!isValidNoteId(noteId) || !file) continue;
        const key = normalizeNoteId(noteId);
        byId.set(key, [...(byId.get(key) ?? []), file]);
      }
    }
    const matches = byId.get(normalizeNoteId(entry.id!)) ?? [];
    if (matches.length === 1) {
      note.file = matches[0]!;
    } else if (matches.length === 0) {
      block(note, { code: 'TARGET_NOT_FOUND', message: `No note has id ${entry.id}.` });
    } else {
      block(note, {
        code: 'TARGET_AMBIGUOUS',
        message: `Notes share id ${entry.id}: ${matches.map((file) => toSlashes(file.relativePath)).join(', ')}.`,
      });
    }
  }

  const entriesByPath = new Map<string, PlannedNote[]>();
  for (const note of notes) {
    if (!note.file) continue;
    entriesByPath.set(note.file.path, [...(entriesByPath.get(note.file.path) ?? []), note]);
  }
  for (const group of entriesByPath.values()) {
    if (group.length < 2) continue;
    const indexes = group.map((note) => note.entry.index).join(', ');
    for (const note of group) {
      block(note, {
        code: 'DUPLICATE_TARGET',
        message: `Entries ${indexes} all name ${toSlashes(note.file!.relativePath)}; name each note once.`,
      });
      delete note.file;
    }
  }
  for (const note of notes) {
    if (note.file) note.result.path = toSlashes(note.file.relativePath);
  }
}

/** Read each note and run the checks that need only it and the schema. */
async function resolvePatches(schema: LoadedSchema, notes: PlannedNote[]): Promise<void> {
  for (const note of notes) {
    const { entry, file } = note;
    if (!file || !entry.patch) continue;

    let parsed;
    try {
      parsed = await parseNote(file.path);
    } catch (error) {
      delete note.file;
      block(note, { code: 'READ_FAILED', message: `Could not read ${note.result.path}: ${(error as Error).message}` });
      continue;
    }
    note.result.beforeRevision = noteRevision(parsed.raw);
    const noteId = parsed.frontmatter['id'];
    if (isValidNoteId(noteId)) note.result.id = noteId;
    // An id-only target was found in the vault snapshot; check the note still says so.
    if (entry.id !== undefined && !(isValidNoteId(noteId) && normalizeNoteId(noteId) === normalizeNoteId(entry.id))) {
      block(note, {
        code: 'TARGET_MISMATCH',
        message: `${note.result.path} has id ${isValidNoteId(noteId) ? noteId : '(none)'}, not ${entry.id}.`,
      });
      continue;
    }

    const { _body: bodyPatch, ...patchData } = entry.patch;
    if (bodyPatch !== undefined) {
      block(note, { code: 'BODY_NOT_SUPPORTED', message: 'Patch batches edit frontmatter only; use bwrb edit --json for _body.' });
    }
    const reserved = rejectReservedPatchFields(patchData);
    if (reserved) {
      block(note, rejectionError(reserved));
      continue;
    }
    const resolved = resolveJsonEdit(schema, parsed, patchData, undefined);
    if (!resolved.ok) {
      block(note, rejectionError(resolved.rejection));
      continue;
    }
    note.edit = resolved.edit;
    note.result.updated = resolved.edit.updatedFields;
  }
}

/**
 * Shared vault state for the cross-note checks. Relative dates and parent
 * cycles see this batch's planned values, so two patches cannot together
 * make a cycle that neither makes alone.
 */
function vaultContext(
  schema: LoadedSchema,
  files: ManagedFile[],
  fullSnapshot: () => Promise<VaultNoteSnapshot>,
  notes: PlannedNote[]
): JsonEditVaultContext {
  const planned = new Map(notes.filter((note) => note.edit).map((note) => [note.file!.path, note.edit!]));
  return {
    noteTargetIndex: createNoteTargetIndexSource(schema, files, fullSnapshot),
    loadSnapshot: memo(async () => ({
      notes: (await fullSnapshot()).notes.map((snapshotNote) => {
        const edit = planned.get(snapshotNote.path);
        return edit
          ? { ...snapshotNote, frontmatter: edit.resolvedFrontmatter, resolvedType: edit.typePath }
          : snapshotNote;
      }),
    })),
    loadParentMap: memo(async () => {
      const parentMap = new Map<string, string>();
      for (const snapshotNote of (await fullSnapshot()).notes) {
        const frontmatter = planned.get(snapshotNote.path)?.resolvedFrontmatter ?? snapshotNote.frontmatter;
        const edge = frontmatter ? parentEdge(schema, snapshotNote.path, frontmatter) : undefined;
        if (edge) parentMap.set(edge.noteName, edge.parentTarget);
      }
      return parentMap;
    }),
  };
}

/** Run the checks that read other notes, then settle each note's plan. */
async function checkAgainstVault(
  schema: LoadedSchema,
  vaultDir: string,
  notes: PlannedNote[],
  context: JsonEditVaultContext,
  loadGuardIndex: () => Promise<NoteTargetIndex>
): Promise<void> {
  for (const note of notes) {
    const { entry, file, edit } = note;
    if (!file || !edit) continue;

    const rejection = await validateJsonEditAgainstVault(schema, vaultDir, file.path, edit, context);
    if (rejection) {
      block(note, rejectionError(rejection));
      continue;
    }

    const { frontmatter, resolvedFrontmatter, typeDef } = edit;
    note.unchanged = isDeepStrictEqual(resolvedFrontmatter, frontmatter) && edit.resolvedBody === edit.body;
    // A note that already holds every patched value is left alone even when
    // its revision has moved on. That is what makes re-running a manifest
    // after an interruption finish the remainder.
    if (note.unchanged) continue;

    note.result.changes = changedFields(frontmatter, resolvedFrontmatter);
    // Build the bytes now, so a note that can't be serialized blocks the batch
    // here instead of failing it midway through the writes.
    try {
      note.content = buildNoteContent(resolvedFrontmatter, edit.resolvedBody, edit.orderedFields);
    } catch (error) {
      block(note, { code: 'VALIDATION_FAILED', message: `Could not serialize the patched note: ${(error as Error).message}` });
    }
    if (entry.expectedRevision !== undefined && entry.expectedRevision !== note.result.beforeRevision) {
      block(note, {
        code: 'REVISION_MISMATCH',
        message: 'Note changed since it was read. Reread it and retry with the current revision.',
        expectedRevision: entry.expectedRevision,
        currentRevision: note.result.beforeRevision!,
      });
    }
    try {
      await assertTransitionGuards(schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter, loadGuardIndex);
      note.guardPaths = await transitionGuardTargetPaths(
        schema, vaultDir, typeDef.name, frontmatter, resolvedFrontmatter, loadGuardIndex
      );
    } catch (error) {
      const guard = error as Error & { code?: string; explanation?: unknown };
      block(note, guard.code === 'TRANSITION_GUARD_FAILED'
        ? { code: 'TRANSITION_GUARD_FAILED', message: guard.message, data: guard.explanation }
        : { code: 'VALIDATION_FAILED', message: guard.message });
    }
    // Writes to other notes would need their own all-or-nothing handling.
    if (entersTransitionEffects(schema, typeDef.name, frontmatter, resolvedFrontmatter)) {
      block(note, {
        code: 'RELATED_WRITES_NOT_SUPPORTED',
        message: 'This change enters a transition that updates related notes; edit this note on its own with bwrb edit --json.',
      });
    }
    try {
      const recurrence = await prepareRecurrenceFastPath(
        schema, vaultDir, typeDef.name, file.path, frontmatter, resolvedFrontmatter, edit.resolvedBody
      );
      if (recurrence.prepared) {
        block(note, {
          code: 'RELATED_WRITES_NOT_SUPPORTED',
          message: 'This change would create the next note in its recurrence; edit this note on its own with bwrb edit --json.',
        });
      }
    } catch (error) {
      block(note, { code: 'VALIDATION_FAILED', message: (error as Error).message });
    }
  }
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Recheck every note under its lock. A note that changed since planning
 * blocks the batch before anything is written.
 */
async function recheckUnderLock(
  schema: LoadedSchema,
  vaultDir: string,
  notes: PlannedNote[],
  loadGuardIndex: () => Promise<NoteTargetIndex>
): Promise<void> {
  for (const note of notes) {
    const { file, edit, entry } = note;
    const current = await readFile(file!.path, 'utf-8').catch(() => undefined);
    if (current !== edit!.raw) {
      const currentRevision = current === undefined ? undefined : noteRevision(current);
      block(note, entry.expectedRevision !== undefined
        ? {
            code: 'REVISION_MISMATCH',
            message: 'Note changed since it was read. Reread it and retry with the current revision.',
            expectedRevision: entry.expectedRevision,
            ...(currentRevision ? { currentRevision } : {}),
          }
        : { code: 'NOTE_CHANGED', message: 'Note changed while this batch was being checked. Rerun the batch.' });
      continue;
    }
    if (note.unchanged) continue;
    // Relation state can change after validation; re-evaluate guards while
    // their notes are locked, as a single edit does.
    try {
      await assertTransitionGuards(
        schema, vaultDir, edit!.typeDef.name, edit!.frontmatter, edit!.resolvedFrontmatter, loadGuardIndex
      );
    } catch (error) {
      const guard = error as Error & { code?: string; explanation?: unknown };
      block(note, guard.code === 'TRANSITION_GUARD_FAILED'
        ? { code: 'TRANSITION_GUARD_FAILED', message: guard.message, data: guard.explanation }
        : { code: 'VALIDATION_FAILED', message: guard.message });
    }
  }
}

/**
 * Replace a note's bytes in place. Opening with r+ never creates a file, so a
 * note moved or deleted since the recheck fails its write, and the batch rolls
 * back, instead of reappearing at its old path.
 */
async function overwriteNote(path: string, content: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(0);
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

/** Write each planned note in manifest order; on failure, undo this run's writes. */
async function writeNotes(notes: PlannedNote[], options: PatchBatchOptions): Promise<string | undefined> {
  const written: PlannedNote[] = [];
  for (const [position, note] of notes.entries()) {
    if (note.unchanged) {
      note.result.status = 'unchanged';
      note.result.revision = note.result.beforeRevision;
      continue;
    }
    try {
      await options.beforeWrite?.(note.result.path!);
      await overwriteNote(note.file!.path, note.content!);
      written.push(note);
      note.result.status = 'applied';
      note.result.revision = noteRevision(note.content!);
    } catch (error) {
      const message = `Could not write ${note.result.path}: ${(error as Error).message}`;
      note.result.status = 'failed';
      block(note, { code: 'WRITE_FAILED', message });
      await restoreFailedWrite(note);
      // Each restore reports its own failure, so one never stops the others.
      for (const earlier of written.reverse()) await restoreWrite(earlier);
      for (const later of notes.slice(position + 1)) later.result.status = 'not-attempted';
      return message;
    }
  }
  return undefined;
}

/** Undo a failed write's own partial effect, if the note holds nothing newer. */
async function restoreFailedWrite(note: PlannedNote): Promise<void> {
  const { file, edit } = note;
  let current: Buffer;
  try {
    current = await readFile(file!.path);
  } catch (error) {
    note.result.revision = null;
    // The r+ write never creates or removes a note, so a missing one was moved
    // or deleted by someone else and there is nothing of this batch to undo.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    block(note, {
      code: 'RESTORE_FAILED',
      message: `Could not read ${note.result.path} to check whether to restore it: ${(error as Error).message}`,
    });
    return;
  }
  note.result.revision = current.length === 0 ? null : noteRevision(current.toString('utf-8'));
  // A write that stopped partway leaves the start of the new bytes, or none.
  // Compare bytes: a cut inside a multibyte character doesn't decode to a prefix.
  const intended = Buffer.from(note.content!, 'utf-8');
  if (current.length > intended.length || !current.equals(intended.subarray(0, current.length))) return;
  try {
    await writeFileAtomic(file!.path, edit!.raw);
    note.result.revision = note.result.beforeRevision;
  } catch (error) {
    block(note, { code: 'RESTORE_FAILED', message: `Could not restore ${note.result.path}: ${(error as Error).message}` });
  }
}

async function restoreWrite(note: PlannedNote): Promise<void> {
  try {
    if (await rollbackNoteIfUnchanged(note.file!.path, note.content!, note.edit!.raw)) {
      note.result.status = 'restored';
      note.result.revision = note.result.beforeRevision;
    } else {
      const current = await readFile(note.file!.path, 'utf-8').catch(() => undefined);
      note.result.revision = current === undefined ? null : noteRevision(current);
      block(note, {
        code: 'RESTORE_SKIPPED',
        message: `${note.result.path} changed again after this batch wrote it, so it was left as it is.`,
      });
    }
  } catch (error) {
    block(note, { code: 'RESTORE_FAILED', message: `Could not restore ${note.result.path}: ${(error as Error).message}` });
  }
}

// ============================================================================
// Batch
// ============================================================================

function outcome(
  mode: PatchBatchResult['mode'],
  notes: PlannedNote[],
  success: boolean,
  exitCode: ExitCode,
  error?: string
): PatchBatchOutcome {
  const counts: PatchBatchCounts = {
    notes: notes.length,
    planned: 0,
    unchanged: 0,
    blocked: 0,
    applied: 0,
    restored: 0,
    failed: 0,
    'not-attempted': 0,
  };
  for (const note of notes) counts[note.result.status]++;
  return {
    success,
    exitCode,
    ...(error ? { error } : {}),
    result: { mode, counts, notes: notes.map((note) => note.result) },
  };
}

const IO_BLOCKERS = new Set<PatchErrorCode>(['REVISION_MISMATCH', 'NOTE_CHANGED', 'READ_FAILED']);

/** Stale, changed or unreadable notes are I/O problems, as in `edit --json`. */
function blockedExitCode(notes: PlannedNote[]): ExitCode {
  const codes = notes.flatMap((note) => note.result.errors ?? []).map((error) => error.code);
  return codes.every((code) => IO_BLOCKERS.has(code))
    ? ExitCodes.IO_ERROR
    : ExitCodes.VALIDATION_ERROR;
}

/**
 * Preview, or with `execute`, apply, a patch manifest.
 *
 * Throws {@link PatchManifestError} when the manifest itself is unusable.
 */
export async function runPatchBatch(
  schema: LoadedSchema,
  vaultDir: string,
  manifestText: string,
  options: PatchBatchOptions = {}
): Promise<PatchBatchOutcome> {
  const mode = options.execute ? 'execute' : 'preview';
  const notes: PlannedNote[] = parsePatchManifest(manifestText).map((entry) => ({
    entry,
    result: {
      index: entry.index,
      id: entry.id ?? null,
      path: entry.path ?? null,
      status: 'planned',
      updated: [],
      beforeRevision: null,
      revision: null,
    },
  }));

  // One discovery serves every note. Parsing the whole vault happens at most
  // once, and only when a check needs it.
  const files = await discoverManagedFiles(schema, vaultDir);
  const fullSnapshot = memo(() => buildVaultNoteSnapshotFromFiles(schema, files));
  const loadGuardIndex = memo(async () => deriveNoteTargetIndex(await fullSnapshot(), schema));

  await resolveTargets(notes, files, fullSnapshot);
  await resolvePatches(schema, notes);
  await checkAgainstVault(schema, vaultDir, notes, vaultContext(schema, files, fullSnapshot, notes), loadGuardIndex);

  for (const note of notes) {
    note.result.status = note.result.errors?.length ? 'blocked' : note.unchanged ? 'unchanged' : 'planned';
    if (note.unchanged && !note.result.errors?.length) note.result.revision = note.result.beforeRevision;
  }
  const blocked = notes.filter((note) => note.result.status === 'blocked');
  const blockedMessage = (count: number) =>
    `${count} of ${notes.length} notes ${count === 1 ? 'is' : 'are'} blocked, so nothing was written.`;

  if (blocked.length > 0) {
    if (mode === 'execute') {
      for (const note of notes) if (note.result.status !== 'blocked') note.result.status = 'not-attempted';
    }
    return outcome(mode, notes, false, blockedExitCode(blocked), blockedMessage(blocked.length));
  }
  if (mode === 'preview') return outcome(mode, notes, true, ExitCodes.SUCCESS);

  const lockPaths = notes.flatMap((note) => [note.file!.path, ...(note.guardPaths ?? [])]);
  // Set once the locked work has finished, so a failure releasing the locks
  // afterwards is not mistaken for a batch that never ran.
  const locked: { settled?: { failure?: string } } = {};
  try {
    await withLineageMutationLocks(vaultDir, lockPaths, async () => {
      await recheckUnderLock(schema, vaultDir, notes, loadGuardIndex);
      const stale = notes.filter((note) => note.result.errors?.length);
      if (stale.length > 0) {
        for (const note of notes) note.result.status = note.result.errors?.length ? 'blocked' : 'not-attempted';
        locked.settled = { failure: blockedMessage(stale.length) };
        return;
      }
      const failure = await writeNotes(notes, options);
      locked.settled = failure === undefined ? {} : { failure };
    });
  } catch (error) {
    const message = (error as Error).message;
    if (!locked.settled) {
      // The locks could not be taken, or the recheck failed; nothing was written.
      for (const note of notes) note.result.status = 'not-attempted';
      return outcome(mode, notes, false, ExitCodes.IO_ERROR, message);
    }
    // The notes are as reported; only releasing a lock went wrong.
    const settled = (locked.settled.failure ?? 'Every note was written').replace(/\.$/, '');
    return outcome(mode, notes, false, ExitCodes.IO_ERROR, `${settled}, but releasing a lock failed: ${message}`);
  }
  const failure = locked.settled?.failure;
  if (failure !== undefined) {
    const anyBlocked = notes.some((note) => note.result.status === 'blocked');
    return outcome(mode, notes, false, anyBlocked ? blockedExitCode(notes) : ExitCodes.IO_ERROR, failure);
  }
  return outcome(mode, notes, true, ExitCodes.SUCCESS);
}

/** One line per note and a summary, for `--output text`. */
export function formatPatchBatchText(batch: PatchBatchOutcome): string {
  const lines = batch.result.notes.map((note) => {
    const label = note.path ?? note.id ?? `entry ${note.index}`;
    const fields = note.updated.length > 0 ? ` (${note.updated.join(', ')})` : '';
    const errors = (note.errors ?? []).map((error) => `\n    ${error.code}: ${error.message}`).join('');
    return `${note.status.padEnd(13)} ${label}${fields}${errors}`;
  });
  const { counts, mode } = batch.result;
  const summary = (Object.entries(counts) as Array<[string, number]>)
    .filter(([key, count]) => key !== 'notes' && count > 0)
    .map(([key, count]) => `${count} ${key}`)
    .join(', ');
  lines.push(`${mode === 'preview' ? 'Preview' : 'Execute'}: ${counts.notes} notes; ${summary}.`);
  if (batch.error) lines.push(batch.error);
  else if (mode === 'preview') lines.push('Nothing was written. Rerun with --execute to apply.');
  return lines.join('\n');
}
