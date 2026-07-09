import { mkdir, open, stat, unlink } from 'fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import type { ManagedFile, NoteIndex } from '../../lib/navigation.js';
import { buildNoteIndex } from '../../lib/navigation.js';
import { parseNote, writeNote, writeNoteExclusive } from '../../lib/frontmatter.js';
import {
  generateUniqueNoteId,
  isValidNoteId,
  normalizeNoteId,
  registerIssuedNoteId,
} from '../../lib/note-id.js';
import {
  getAliasFieldName,
  getEntityAliases,
  getFieldsForType,
  resolveTypeFromFrontmatter,
} from '../../lib/schema.js';
import { applyDefaults } from '../../lib/validation.js';
import { isBwrbBuiltinFrontmatterField } from '../../lib/frontmatter/systemFields.js';
import { buildNotePath } from './paths.js';
import { promptInput } from '../../lib/prompt.js';
import { UserCancelledError } from '../../lib/errors.js';

const SOURCE_ID_LOCK = '.bwrb/locks/fork-source-id.lock';
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;
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
  assertOwnedForkAllowed(schema, source.file);

  const sourceName = resolveSourceName(source);
  const childName = await resolveChildName(sourceName, options);
  const sourceId = await ensureSourceId(vaultDir, source.file.path);

  // Re-read after a possible ID backfill so the child copies the source's
  // current frontmatter rather than a stale pre-lock snapshot.
  const current = await parseNote(source.file.path);
  const currentType = resolveTypeFromFrontmatter(schema, current.frontmatter);
  if (!currentType) {
    throw new Error(`Fork source no longer has a valid schema type: ${source.file.relativePath}`);
  }

  const warnings = collectSchemaDriftWarnings(schema, currentType, current.frontmatter);
  const frontmatter = buildForkFrontmatter(
    schema,
    currentType,
    current.frontmatter,
    childName,
    sourceId
  );
  const childId = await generateUniqueNoteId(vaultDir);
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
    await registerIssuedNoteId(vaultDir, childId, pathResult.path);
  } catch (error) {
    // A note without a registry row is not a completed creation. Roll it back;
    // the source ID backfill intentionally remains durable.
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
}

async function resolveForkSource(
  schema: LoadedSchema,
  vaultDir: string,
  target: string
): Promise<ResolvedForkSource> {
  const index = await buildNoteIndex(schema, vaultDir);
  const idMatches: ManagedFile[] = [];
  const parsedByPath = new Map<string, Awaited<ReturnType<typeof parseNote>>>();

  for (const file of index.allFiles) {
    try {
      const parsed = await parseNote(file.path);
      parsedByPath.set(file.path, parsed);
      if (
        isValidNoteId(target) &&
        isValidNoteId(parsed.frontmatter.id) &&
        normalizeNoteId(parsed.frontmatter.id) === normalizeNoteId(target)
      ) {
        idMatches.push(file);
      }
    } catch {
      // Exact path/name resolution below will produce a useful parse error if
      // this malformed note is the requested source.
    }
  }

  let file: ManagedFile | undefined;
  if (idMatches.length > 1) {
    throwAmbiguousTarget(target, idMatches);
  }
  if (idMatches.length === 1) {
    file = idMatches[0];
  } else {
    file = resolveExactFile(schema, index, vaultDir, target, parsedByPath);
  }

  if (!file) {
    throw new Error(`No exact note found for fork target: ${target}`);
  }

  let parsed = parsedByPath.get(file.path);
  if (!parsed) {
    try {
      parsed = await parseNote(file.path);
    } catch (error) {
      throw new Error(
        `Cannot read fork source ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const typeName = resolveTypeFromFrontmatter(schema, parsed.frontmatter);
  if (!typeName) {
    throw new Error(`Fork source does not have a valid schema type: ${file.relativePath}`);
  }
  return { file, frontmatter: parsed.frontmatter, body: parsed.body, typeName };
}

function resolveExactFile(
  schema: LoadedSchema,
  index: NoteIndex,
  vaultDir: string,
  target: string,
  parsedByPath: Map<string, Awaited<ReturnType<typeof parseNote>>>
): ManagedFile | undefined {
  if (isAbsolute(target)) {
    const absolute = resolve(target);
    const root = resolve(vaultDir);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
    const relativeTarget = relative(root, absolute);
    const withExtension = relativeTarget.endsWith('.md') ? relativeTarget : `${relativeTarget}.md`;
    return index.byPath.get(relativeTarget) ?? index.byPath.get(withExtension);
  }

  const normalizedTarget = target.replace(/^\.\//, '');
  const cleanTarget = normalizedTarget.replace(/\.md$/, '');
  const withExtension = `${cleanTarget}.md`;

  const pathMatch = index.byPath.get(normalizedTarget) ?? index.byPath.get(withExtension);
  if (pathMatch) return pathMatch;

  const basenameMatches = exactMapMatches(index.byBasename, cleanTarget);
  if (basenameMatches.length > 1) throwAmbiguousTarget(target, basenameMatches);
  if (basenameMatches.length === 1) return basenameMatches[0];

  // A frontmatter name can intentionally differ from the filename. It remains
  // an exact identity surface, never a fuzzy one.
  const requested = cleanTarget.toLowerCase();
  const nameMatches: ManagedFile[] = [];
  for (const file of index.allFiles) {
    const name = parsedByPath.get(file.path)?.frontmatter.name;
    if (typeof name === 'string' && name.toLowerCase() === requested) {
      nameMatches.push(file);
    }
  }
  if (nameMatches.length > 1) throwAmbiguousTarget(target, nameMatches);
  if (nameMatches.length === 1) return nameMatches[0];

  // Aliases are the final exact tier: a real path, basename, or frontmatter
  // name always wins over an alias claiming the same surface.
  const aliasMatches: ManagedFile[] = [];
  for (const file of index.allFiles) {
    const parsed = parsedByPath.get(file.path);
    if (!parsed) continue;
    const typeName = resolveTypeFromFrontmatter(schema, parsed.frontmatter);
    if (!typeName) continue;
    const aliases = getEntityAliases(schema, typeName, parsed.frontmatter);
    if (aliases.some(alias => alias.toLowerCase() === requested)) aliasMatches.push(file);
  }
  if (aliasMatches.length > 1) throwAmbiguousTarget(target, aliasMatches);
  return aliasMatches[0];
}

function exactMapMatches(
  map: Map<string, ManagedFile[]>,
  target: string
): ManagedFile[] {
  const direct = map.get(target);
  if (direct) return direct;
  const lower = target.toLowerCase();
  return Array.from(map.entries())
    .filter(([key]) => key.toLowerCase() === lower)
    .flatMap(([, files]) => files);
}

function throwAmbiguousTarget(target: string, files: ManagedFile[]): never {
  const candidates = files.map(file => file.relativePath).sort().join(', ');
  throw new Error(`Ambiguous fork target "${target}"; matches: ${candidates}`);
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

async function ensureSourceId(vaultDir: string, sourcePath: string): Promise<string> {
  return withSourceIdLock(vaultDir, async () => {
    const parsed = await parseNote(sourcePath);
    const existing = parsed.frontmatter.id;
    if (existing !== undefined) {
      if (!isValidNoteId(existing)) {
        throw new Error(`Fork source has an invalid id and was not modified: ${relative(vaultDir, sourcePath)}`);
      }
      return existing;
    }

    const id = await generateUniqueNoteId(vaultDir);
    const nextFrontmatter = { ...parsed.frontmatter, id };
    const order = buildBackfillFieldOrder(parsed.frontmatter);
    await writeNote(sourcePath, nextFrontmatter, parsed.body, order);
    try {
      await registerIssuedNoteId(vaultDir, id, sourcePath);
    } catch (error) {
      await writeNote(sourcePath, parsed.frontmatter, parsed.body, Object.keys(parsed.frontmatter));
      throw error;
    }
    return id;
  });
}

async function withSourceIdLock<T>(vaultDir: string, task: () => Promise<T>): Promise<T> {
  const lockPath = resolve(vaultDir, SOURCE_ID_LOCK);
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf-8');
        return await task();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error('Timed out waiting to assign the fork source ID; retry the command.');
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
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

function buildBackfillFieldOrder(frontmatter: Record<string, unknown>): string[] {
  const keys = Object.keys(frontmatter);
  const typeIndex = keys.indexOf('type');
  if (typeIndex >= 0) keys.splice(typeIndex + 1, 0, 'id');
  else keys.unshift('id');
  return keys;
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

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
