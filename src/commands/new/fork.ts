import { unlink } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import type { ManagedFile } from '../../lib/navigation.js';
import { buildNoteIndex } from '../../lib/navigation.js';
import {
  insertFrontmatterScalarPreservingBytes,
  parseNote,
  writeFileAtomic,
  writeNoteExclusive,
} from '../../lib/frontmatter.js';
import {
  generateUniqueNoteId,
  isValidNoteId,
  normalizeNoteId,
  registerIssuedNoteId,
  withNoteIdAssignmentLock,
} from '../../lib/note-id.js';
import {
  getAliasFieldName,
  getFieldsForType,
  resolveTypeFromFrontmatter,
} from '../../lib/schema.js';
import { applyDefaults, normalizeDateFields } from '../../lib/validation.js';
import { isBwrbBuiltinFrontmatterField } from '../../lib/frontmatter/systemFields.js';
import { buildNotePath } from './paths.js';
import { promptInput } from '../../lib/prompt.js';
import { UserCancelledError } from '../../lib/errors.js';
import { resolveExactNoteTarget } from '../../lib/exact-note-target.js';
import { withLineageMutationLocks } from '../../lib/lineage-lock.js';
import {
  assertNoteBytesUnchanged,
  rollbackNoteIfUnchanged,
} from '../../lib/note-write-concurrency.js';

const PORTABLE_PATH_WARNING_LENGTH = 200;
const PORTABLE_PATH_MAX_LENGTH = 260;
const STRUCTURAL_FIELDS = new Set(['type', 'id', 'name', 'forked-from', 'prev', 'next']);

export interface ForkNoteOptions {
  target: string;
  name?: string;
  label?: string;
  nonInteractive: boolean;
}

export interface ForkNoteResult {
  path: string;
  id: string;
  forkedFrom: string;
  warnings: string[];
  nameTransformed?: {
    original: string;
    sanitized: string;
    filename: string;
  };
  pathLengthWarning?: {
    path: string;
    length: number;
    threshold: number;
    max: number;
  };
}

interface ResolvedForkSource {
  file: ManagedFile;
  frontmatter: Record<string, unknown>;
  body: string;
  typeName: string;
}

export async function forkNote(
  schema: LoadedSchema,
  vaultDir: string,
  options: ForkNoteOptions
): Promise<ForkNoteResult> {
  const source = await resolveForkSource(schema, vaultDir, options.target);
  if (isValidNoteId(source.frontmatter.id)) {
    await assertSourceIdUnique(schema, vaultDir, source.file.path, source.frontmatter.id);
  }
  assertOwnedForkAllowed(schema, source.file);

  const sourceName = resolveSourceName(source);
  const childName = await resolveChildName(sourceName, options);

  return withLineageMutationLocks(vaultDir, [source.file.path], async () => {
    // The path-keyed lock begins before legacy ID backfill and remains held
    // through the child registry append. A concurrent non-force delete either
    // removes the source first or observes this completed child.
    const sourceId = await ensureSourceId(schema, vaultDir, source.file.path);

    // Re-read after a possible ID backfill so the child copies the source's
    // current frontmatter rather than a stale pre-lock snapshot.
    const current = await parseNote(source.file.path);
    const currentType = resolveTypeFromFrontmatter(schema, current.frontmatter);
    if (!currentType) {
      throw new Error(`Fork source no longer has a valid schema type: ${source.file.relativePath}`);
    }

    const warnings = collectSchemaDriftWarnings(schema, currentType, current.frontmatter);
    const frontmatter = normalizeDateFields(
      schema,
      currentType,
      buildForkFrontmatter(
        schema,
        currentType,
        current.frontmatter,
        childName,
        sourceId
      )
    );
    const childId = await generateUniqueNoteId(vaultDir, schema);
    frontmatter.id = childId;

    const pathResult = buildNotePath(dirname(source.file.path), childName, 'interactive');
    const relativePath = relative(vaultDir, pathResult.path);
    if (relativePath.length > PORTABLE_PATH_MAX_LENGTH) {
      throw new Error(
        `Note path is ${relativePath.length} characters, exceeding the portable limit of ${PORTABLE_PATH_MAX_LENGTH}: ${relativePath}`
      );
    }

    const pathLengthWarning = relativePath.length > PORTABLE_PATH_WARNING_LENGTH
      ? {
          path: relativePath,
          length: relativePath.length,
          threshold: PORTABLE_PATH_WARNING_LENGTH,
          max: PORTABLE_PATH_MAX_LENGTH,
        }
      : undefined;

    const orderedFields = buildForkFieldOrder(current.frontmatter, frontmatter);
    try {
      await writeNoteExclusive(pathResult.path, frontmatter, current.body, orderedFields);
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new Error(`File already exists: ${relativePath}`);
      }
      throw error;
    }

    try {
      await registerIssuedNoteId(
        vaultDir,
        childId,
        pathResult.path,
        schema.config.identityStore
      );
    } catch (error) {
      // A note without a registry row is not a completed creation. Roll it
      // back; the source ID backfill intentionally remains durable.
      await unlink(pathResult.path).catch(() => undefined);
      throw error;
    }

    return {
      path: pathResult.path,
      id: childId,
      forkedFrom: sourceId,
      warnings,
      ...(pathResult.nameTransformed ? { nameTransformed: pathResult.nameTransformed } : {}),
      ...(pathLengthWarning ? { pathLengthWarning } : {}),
    };
  });
}

async function resolveForkSource(
  schema: LoadedSchema,
  vaultDir: string,
  target: string
): Promise<ResolvedForkSource> {
  const source = await resolveExactNoteTarget(schema, vaultDir, target, { purpose: 'fork' });
  return {
    file: source.file,
    frontmatter: source.frontmatter,
    body: source.body,
    typeName: source.typeName,
  };
}

function resolveSourceName(source: ResolvedForkSource): string {
  const name = source.frontmatter.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return basename(source.file.relativePath, '.md');
}

async function resolveChildName(sourceName: string, options: ForkNoteOptions): Promise<string> {
  if (options.name?.trim()) return options.name.trim();
  if (options.label?.trim()) return `${sourceName} — ${options.label.trim()}`;
  if (options.nonInteractive) {
    throw new Error('Fork creation requires --name <name> or --label <label> in non-interactive mode.');
  }
  const selected = await promptInput('Fork name:', `${sourceName} (fork)`);
  if (selected === null) throw new UserCancelledError();
  if (!selected.trim()) throw new Error('Fork name cannot be empty.');
  return selected.trim();
}

async function ensureSourceId(
  schema: LoadedSchema,
  vaultDir: string,
  sourcePath: string
): Promise<string> {
  return withNoteIdAssignmentLock(vaultDir, async () => {
    const parsed = await parseNote(sourcePath);
    const existing = parsed.frontmatter.id;
    if (existing !== undefined) {
      if (!isValidNoteId(existing)) {
        throw new Error(`Fork source has an invalid id and was not modified: ${relative(vaultDir, sourcePath)}`);
      }
      await assertSourceIdUnique(schema, vaultDir, sourcePath, existing);
      return existing;
    }

    const id = await generateUniqueNoteId(vaultDir, schema);
    const collisions = await findNotesWithId(schema, vaultDir, id);
    if (collisions.length > 0) {
      throw new Error('Generated source ID collides with an existing note; retry the command.');
    }
    const nextRaw = insertFrontmatterScalarPreservingBytes(parsed.raw, 'id', id);
    await assertNoteBytesUnchanged(sourcePath, parsed.raw);
    await writeFileAtomic(sourcePath, nextRaw);
    try {
      await registerIssuedNoteId(vaultDir, id, sourcePath, schema.config.identityStore);
    } catch (error) {
      const rolledBack = await rollbackNoteIfUnchanged(sourcePath, nextRaw, parsed.raw);
      if (!rolledBack) {
        throw new Error(
          `Source ID registration failed (${formatError(error)}) and rollback was skipped because ` +
          'the source changed again; newer bytes were preserved.'
        );
      }
      throw error;
    }
    return id;
  }, {}, schema.config.identityStore);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertSourceIdUnique(
  schema: LoadedSchema,
  vaultDir: string,
  sourcePath: string,
  id: string
): Promise<void> {
  const matches = await findNotesWithId(schema, vaultDir, id);
  const otherMatches = matches.filter(file => resolve(file.path) !== resolve(sourcePath));
  if (otherMatches.length === 0) return;

  const candidates = Array.from(new Set([
    relative(vaultDir, sourcePath),
    ...matches.map(file => file.relativePath),
  ]))
    .sort()
    .join(', ');
  throw new Error(
    `Cannot fork source ${relative(vaultDir, sourcePath)}: id ${id} is duplicated; matches: ${candidates}`
  );
}

async function findNotesWithId(
  schema: LoadedSchema,
  vaultDir: string,
  id: string
): Promise<ManagedFile[]> {
  const normalized = normalizeNoteId(id);
  const index = await buildNoteIndex(schema, vaultDir);
  const matches: ManagedFile[] = [];
  for (const file of index.allFiles) {
    try {
      const parsed = await parseNote(file.path);
      if (
        isValidNoteId(parsed.frontmatter.id) &&
        normalizeNoteId(parsed.frontmatter.id) === normalized
      ) {
        matches.push(file);
      }
    } catch {
      // An unrelated unreadable note cannot be a confirmed identity match.
    }
  }
  return matches;
}

function buildForkFrontmatter(
  schema: LoadedSchema,
  typeName: string,
  source: Record<string, unknown>,
  childName: string,
  sourceId: string
): Record<string, unknown> {
  const fields = getFieldsForType(schema, typeName);
  const aliasField = getAliasFieldName(schema, typeName);
  const copied: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'id' || key === 'forked-from' || key === 'prev' || key === 'next') continue;
    if (key === aliasField) continue;
    if (!STRUCTURAL_FIELDS.has(key) && fields[key]?.reset_on_fork === true) continue;
    copied[key] = value;
  }

  const withDefaults = applyDefaults(schema, typeName, copied);
  // Alias defaults must not duplicate the source's identity aliases.
  if (aliasField) delete withDefaults[aliasField];
  withDefaults.name = childName;
  withDefaults['forked-from'] = sourceId;
  return withDefaults;
}

function collectSchemaDriftWarnings(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>
): string[] {
  const fields = getFieldsForType(schema, typeName);
  const unknown = Object.keys(frontmatter).filter(
    key => !fields[key] && !isBwrbBuiltinFrontmatterField(key) && key !== 'prev' && key !== 'next'
  );
  if (unknown.length === 0) return [];
  return [
    `Copied schema-drift field${unknown.length === 1 ? '' : 's'} unchanged: ${unknown.sort().join(', ')}`,
  ];
}

function assertOwnedForkAllowed(schema: LoadedSchema, file: ManagedFile): void {
  if (!file.ownership) return;
  const ownedField = schema.ownership.owns
    .get(file.ownership.ownerType)
    ?.find(field => field.fieldName === file.ownership?.fieldName);
  if (ownedField && !ownedField.multiple) {
    throw new Error(
      `Cannot fork owned note ${file.relativePath}: owner field '${file.ownership.fieldName}' is single-valued.`
    );
  }
}

function buildForkFieldOrder(
  source: Record<string, unknown>,
  child: Record<string, unknown>
): string[] {
  const sourceKeys = Object.keys(source).filter(key => key in child && key !== 'id' && key !== 'forked-from');
  const order = ['id', 'forked-from', ...sourceKeys];
  for (const key of Object.keys(child)) {
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
