import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import {
  insertFrontmatterScalarPreservingBytes,
  parseNoteContent,
  writeFileAtomic,
  type ParsedNote,
} from '../../lib/frontmatter.js';
import { resolveExactNoteTarget, type ResolvedExactNoteTarget } from '../../lib/exact-note-target.js';
import { buildVaultNoteSnapshot, type VaultNoteSnapshot } from '../../lib/discovery.js';
import { collectLineageIssues } from '../../lib/audit/lineage.js';
import {
  generateUniqueNoteId,
  isValidNoteId,
  normalizeNoteId,
  registerIssuedNoteIds,
  withNoteIdAssignmentLock,
} from '../../lib/note-id.js';
import {
  getLineageMutationLockPath,
  withLineageMutationLocks,
} from '../../lib/lineage-lock.js';
import {
  assertNoteBytesUnchanged,
  rollbackNoteIfUnchanged,
} from '../../lib/note-write-concurrency.js';

export type LineageAdoptMode = 'dry-run' | 'execute';

export interface LineageAdoptOptions {
  child: string;
  parent: string;
  execute: boolean;
}

export interface LineageAdoptDependencies {
  registerIds?: typeof registerIssuedNoteIds;
}

export interface LineageAdoptChange {
  path: string;
  field: 'id' | 'forked-from';
  value: string;
  status: 'planned' | 'applied';
}

export interface LineageAdoptBodyEvidence {
  before_sha256: string;
  after_sha256: string;
  unchanged: boolean;
}

export interface LineageAdoptResult {
  mode: LineageAdoptMode;
  child: {
    path: string;
    id: string;
    id_generated: boolean;
  };
  parent: {
    path: string;
    id: string;
    id_generated: boolean;
  };
  changes: LineageAdoptChange[];
  warnings: string[];
  body_invariance: {
    child: LineageAdoptBodyEvidence;
    parent: LineageAdoptBodyEvidence;
  };
}

interface PreparedAdoption {
  result: LineageAdoptResult;
  child: ResolvedExactNoteTarget;
  parent: ResolvedExactNoteTarget;
  childOriginal: ParsedNote;
  parentOriginal: ParsedNote;
  childNextRaw: string;
  parentNextRaw: string;
  registrations: Array<{ id: string; notePath: string }>;
}

/** Preview or apply one guarded immediate-source edge between existing notes. */
export async function adoptLineage(
  schema: LoadedSchema,
  vaultDir: string,
  options: LineageAdoptOptions,
  dependencies: LineageAdoptDependencies = {}
): Promise<LineageAdoptResult> {
  const initial = await resolveTargets(schema, vaultDir, options.child, options.parent);
  assertDifferentNotes(vaultDir, initial.child, initial.parent);

  if (!options.execute) {
    return (await prepareAdoption(schema, vaultDir, initial.child, initial.parent, 'dry-run')).result;
  }

  const lockedPaths = [initial.child.file.path, initial.parent.file.path];
  return withLineageMutationLocks(vaultDir, lockedPaths, async () =>
    withNoteIdAssignmentLock(vaultDir, async () => {
      const current = await resolveTargets(schema, vaultDir, options.child, options.parent);
      assertTargetsStayedLocked(vaultDir, initial, current);
      const prepared = await prepareAdoption(
        schema,
        vaultDir,
        current.child,
        current.parent,
        'execute'
      );
      await applyPreparedAdoption(
        vaultDir,
        prepared,
        dependencies.registerIds ?? registerIssuedNoteIds,
        schema.config.identityStore
      );
      return prepared.result;
    }, {}, schema.config.identityStore)
  );
}

async function resolveTargets(
  schema: LoadedSchema,
  vaultDir: string,
  childTarget: string,
  parentTarget: string
): Promise<{ child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget }> {
  const child = await resolveExactNoteTarget(schema, vaultDir, childTarget, {
    purpose: 'adoption child',
  });
  const parent = await resolveExactNoteTarget(schema, vaultDir, parentTarget, {
    purpose: 'adoption parent',
  });
  return { child, parent };
}

async function prepareAdoption(
  schema: LoadedSchema,
  vaultDir: string,
  child: ResolvedExactNoteTarget,
  parent: ResolvedExactNoteTarget,
  mode: LineageAdoptMode
): Promise<PreparedAdoption> {
  assertDifferentNotes(vaultDir, child, parent);
  if (child.typeName !== parent.typeName) {
    throw new Error(
      `Cannot adopt lineage across note types: child ${child.file.relativePath} is ${child.typeName}, ` +
      `parent ${parent.file.relativePath} is ${parent.typeName}.`
    );
  }

  assertNoExistingProvenance(child);
  assertValidExistingId(child, 'child');
  assertValidExistingId(parent, 'parent');

  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  assertGraphSafe(snapshot);

  const usedIds = new Set<string>();
  for (const note of snapshot.notes) {
    const id = note.frontmatter?.id;
    if (isValidNoteId(id)) usedIds.add(normalizeNoteId(id));
  }

  const parentExistingId = parent.frontmatter.id;
  const parentId = isValidNoteId(parentExistingId)
    ? parentExistingId
    : await generateProspectiveId(schema, vaultDir, usedIds);
  usedIds.add(normalizeNoteId(parentId));

  const childExistingId = child.frontmatter.id;
  const childId = isValidNoteId(childExistingId)
    ? childExistingId
    : await generateProspectiveId(schema, vaultDir, usedIds);
  usedIds.add(normalizeNoteId(childId));

  if (normalizeNoteId(childId) === normalizeNoteId(parentId)) {
    throw new Error('Cannot adopt a note under itself: child and parent have the same stable id.');
  }

  const prospective = withProspectiveEdge(
    snapshot,
    child.file.path,
    parent.file.path,
    childId,
    parentId
  );
  assertGraphSafe(prospective, true);

  const parentRaw = await readFile(parent.file.path, 'utf-8');
  const childRaw = await readFile(child.file.path, 'utf-8');
  const parentNextRaw = isValidNoteId(parentExistingId)
    ? parentRaw
    : insertFrontmatterScalarPreservingBytes(parentRaw, 'id', parentId);
  let childNextRaw = childRaw;
  if (!isValidNoteId(childExistingId)) {
    childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'id', childId);
  }
  childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'forked-from', parentId);

  const childOriginal = parseNoteContent(childRaw);
  const parentOriginal = parseNoteContent(parentRaw);
  const childNext = parseNoteContent(childNextRaw);
  const parentNext = parseNoteContent(parentNextRaw);
  assertOnlySystemFieldsChanged(child.file.relativePath, childOriginal, childNext);
  assertOnlySystemFieldsChanged(parent.file.relativePath, parentOriginal, parentNext);

  const status = mode === 'execute' ? 'applied' : 'planned';
  const changes: LineageAdoptChange[] = [];
  if (!isValidNoteId(parentExistingId)) {
    changes.push({ path: parent.file.relativePath, field: 'id', value: parentId, status });
  }
  if (!isValidNoteId(childExistingId)) {
    changes.push({ path: child.file.relativePath, field: 'id', value: childId, status });
  }
  changes.push({
    path: child.file.relativePath,
    field: 'forked-from',
    value: parentId,
    status,
  });

  const registrations: Array<{ id: string; notePath: string }> = [];
  if (!isValidNoteId(parentExistingId)) {
    registrations.push({ id: parentId, notePath: parent.file.path });
  }
  if (!isValidNoteId(childExistingId)) {
    registrations.push({ id: childId, notePath: child.file.path });
  }

  return {
    child,
    parent,
    childOriginal,
    parentOriginal,
    childNextRaw,
    parentNextRaw,
    registrations,
    result: {
      mode,
      child: {
        path: child.file.relativePath,
        id: childId,
        id_generated: !isValidNoteId(childExistingId),
      },
      parent: {
        path: parent.file.relativePath,
        id: parentId,
        id_generated: !isValidNoteId(parentExistingId),
      },
      changes,
      warnings: mode === 'dry-run' && registrations.length > 0
        ? ['Generated IDs in a dry run are provisional; execute revalidates and assigns fresh UUIDs.']
        : [],
      body_invariance: {
        child: buildBodyEvidence(childOriginal.body, childNext.body),
        parent: buildBodyEvidence(parentOriginal.body, parentNext.body),
      },
    },
  };
}

async function applyPreparedAdoption(
  vaultDir: string,
  prepared: PreparedAdoption,
  registerIds: typeof registerIssuedNoteIds,
  identityStore: LoadedSchema['config']['identityStore']
): Promise<void> {
  let parentWritten = false;
  let childWritten = false;
  try {
    if (prepared.parentNextRaw !== prepared.parentOriginal.raw) {
      await assertNoteBytesUnchanged(
        prepared.parent.file.path,
        prepared.parentOriginal.raw
      );
      await writeFileAtomic(prepared.parent.file.path, prepared.parentNextRaw);
      parentWritten = true;
    }
    await assertNoteBytesUnchanged(
      prepared.child.file.path,
      prepared.childOriginal.raw
    );
    await writeFileAtomic(prepared.child.file.path, prepared.childNextRaw);
    childWritten = true;
    await registerIds(vaultDir, prepared.registrations, identityStore);
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (childWritten) {
      await rollbackNoteIfUnchanged(
        prepared.child.file.path,
        prepared.childNextRaw,
        prepared.childOriginal.raw
      ).then(rolledBack => {
        if (!rolledBack) {
          rollbackErrors.push(`${prepared.child.file.relativePath} changed again; newer bytes left as-is`);
        }
      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (parentWritten) {
      await rollbackNoteIfUnchanged(
        prepared.parent.file.path,
        prepared.parentNextRaw,
        prepared.parentOriginal.raw
      ).then(rolledBack => {
        if (!rolledBack) {
          rollbackErrors.push(`${prepared.parent.file.relativePath} changed again; newer bytes left as-is`);
        }
      }).catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Lineage adoption failed (${formatError(error)}) and rollback was incomplete: ${rollbackErrors.join('; ')}`
      );
    }
    throw error;
  }
}

function assertDifferentNotes(
  vaultDir: string,
  child: ResolvedExactNoteTarget,
  parent: ResolvedExactNoteTarget
): void {
  const childLock = getLineageMutationLockPath(vaultDir, child.file.path);
  const parentLock = getLineageMutationLockPath(vaultDir, parent.file.path);
  if (childLock === parentLock) {
    throw new Error(`Cannot adopt a note under itself: ${child.file.relativePath}.`);
  }
}

function assertTargetsStayedLocked(
  vaultDir: string,
  initial: { child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget },
  current: { child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget }
): void {
  for (const role of ['child', 'parent'] as const) {
    const initialLock = getLineageMutationLockPath(vaultDir, initial[role].file.path);
    const currentLock = getLineageMutationLockPath(vaultDir, current[role].file.path);
    if (initialLock !== currentLock) {
      throw new Error(`The adoption ${role} target changed while waiting for a lock; retry the command.`);
    }
  }
}

function assertNoExistingProvenance(child: ResolvedExactNoteTarget): void {
  if (Object.prototype.hasOwnProperty.call(child.frontmatter, 'forked-from')) {
    throw new Error(
      `Cannot adopt ${child.file.relativePath}: child already has forked-from provenance.`
    );
  }
}

function assertValidExistingId(target: ResolvedExactNoteTarget, role: 'child' | 'parent'): void {
  const id = target.frontmatter.id;
  if (id !== undefined && !isValidNoteId(id)) {
    throw new Error(
      `Cannot adopt ${role} ${target.file.relativePath}: existing id is not a valid UUID.`
    );
  }
}

function assertGraphSafe(snapshot: VaultNoteSnapshot, prospective = false): void {
  const issues = [...collectLineageIssues(snapshot).entries()]
    .flatMap(([path, pathIssues]) => pathIssues.map(issue => ({ path, issue })))
    .sort((a, b) =>
      a.issue.code.localeCompare(b.issue.code, 'en') || a.path.localeCompare(b.path, 'en')
    );
  if (issues.length === 0) return;

  const cycle = issues.find(({ issue }) => issue.code === 'fork-cycle');
  if (prospective && cycle) {
    throw new Error(`Cannot adopt lineage: the proposed edge would create a cycle (${cycle.issue.message}).`);
  }
  const first = issues[0]!;
  throw new Error(
    `Cannot adopt lineage while existing provenance is unsafe: ${first.issue.code} at ` +
    `${first.path}: ${first.issue.message}`
  );
}

function withProspectiveEdge(
  snapshot: VaultNoteSnapshot,
  childPath: string,
  parentPath: string,
  childId: string,
  parentId: string
): VaultNoteSnapshot {
  const childAbsolute = resolve(childPath);
  const parentAbsolute = resolve(parentPath);
  let foundChild = false;
  let foundParent = false;
  const notes = snapshot.notes.map(note => {
    const absolute = resolve(note.path);
    if (absolute === childAbsolute) {
      foundChild = true;
      return {
        ...note,
        frontmatter: { ...note.frontmatter, id: childId, 'forked-from': parentId },
      };
    }
    if (absolute === parentAbsolute) {
      foundParent = true;
      return { ...note, frontmatter: { ...note.frontmatter, id: parentId } };
    }
    return note;
  });
  if (!foundChild || !foundParent) {
    throw new Error('Adoption target disappeared while validating the vault; retry the command.');
  }
  return { notes };
}

async function generateProspectiveId(
  schema: LoadedSchema,
  vaultDir: string,
  usedIds: Set<string>
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = await generateUniqueNoteId(vaultDir, schema);
    if (!usedIds.has(normalizeNoteId(id))) return id;
  }
  throw new Error('Could not assign a unique note ID; retry the command.');
}

function assertOnlySystemFieldsChanged(
  path: string,
  before: ParsedNote,
  after: ParsedNote
): void {
  if (before.body !== after.body) {
    throw new Error(`Refusing lineage adoption because it would change the body of ${path}.`);
  }
  if (!isDeepStrictEqual(stripMutableSystemFields(before.frontmatter), stripMutableSystemFields(after.frontmatter))) {
    throw new Error(`Refusing lineage adoption because it would change ordinary metadata in ${path}.`);
  }
}

function stripMutableSystemFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...frontmatter };
  delete copy.id;
  delete copy['forked-from'];
  return copy;
}

function buildBodyEvidence(before: string, after: string): LineageAdoptBodyEvidence {
  const beforeHash = hashBody(before);
  const afterHash = hashBody(after);
  return {
    before_sha256: beforeHash,
    after_sha256: afterHash,
    unchanged: beforeHash === afterHash && before === after,
  };
}

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
