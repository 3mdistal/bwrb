import { isAbsolute, relative, resolve, sep } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import { parseNote } from './frontmatter.js';
import { isValidNoteId, normalizeNoteId } from './note-id.js';
import { buildNoteIndex, type ManagedFile, type NoteIndex } from './navigation.js';
import { getEntityAliases, resolveTypeFromFrontmatter } from './schema.js';
import { buildVaultNoteSnapshot, type VaultNoteSnapshot } from './discovery.js';

type ParsedNote = Awaited<ReturnType<typeof parseNote>>;

export interface ResolvedExactNoteTarget {
  file: ManagedFile;
  frontmatter: Record<string, unknown>;
  body: string;
  typeName: string;
  /** Parsed vault state from the same pass used to resolve the target. */
  snapshot: VaultNoteSnapshot;
}

export interface ExactNoteTargetOptions {
  /** Noun used in resolution errors. Fork mode keeps its established wording. */
  purpose?: 'fork' | 'lineage';
}

/**
 * Resolve a note through Bowerbird's exact identity surfaces only.
 *
 * Resolution precedence is UUID, absolute/relative path, basename,
 * frontmatter name, then schema-declared aliases. Approximate matching is
 * deliberately absent: callers use this when substituting a nearby note would
 * be data corruption wearing a friendly hat.
 */
export async function resolveExactNoteTarget(
  schema: LoadedSchema,
  vaultDir: string,
  target: string,
  options: ExactNoteTargetOptions = {}
): Promise<ResolvedExactNoteTarget> {
  const purpose = options.purpose ?? 'fork';
  const parsedByPath = new Map<string, ParsedNote>();
  const frontmatterByPath = new Map<string, Record<string, unknown>>();
  let snapshot: VaultNoteSnapshot | undefined;
  let index: NoteIndex;

  if (purpose === 'lineage') {
    // Lineage needs a graph-wide snapshot anyway. Build resolution maps from
    // that snapshot and parse only the selected target's body afterward.
    snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
    index = noteIndexFromSnapshot(snapshot);
    for (const note of snapshot.notes) {
      if (note.frontmatter) frontmatterByPath.set(note.path, note.frontmatter);
    }
  } else {
    // Fork keeps the established ManagedFile metadata (notably ownership).
    index = await buildNoteIndex(schema, vaultDir);
  }
  const idMatches: ManagedFile[] = [];

  for (const file of index.allFiles) {
    let frontmatter = frontmatterByPath.get(file.path);
    try {
      if (!frontmatter) {
        const parsed = await parseNote(file.path);
        parsedByPath.set(file.path, parsed);
        frontmatter = parsed.frontmatter;
        frontmatterByPath.set(file.path, parsed.frontmatter);
      }
      if (
        isValidNoteId(target) &&
        isValidNoteId(frontmatter.id) &&
        normalizeNoteId(frontmatter.id) === normalizeNoteId(target)
      ) {
        idMatches.push(file);
      }
    } catch {
      // Exact path/name resolution below will produce a useful parse error if
      // this malformed note is the requested target.
    }
  }

  let file: ManagedFile | undefined;
  if (idMatches.length > 1) {
    throwAmbiguousTarget(target, idMatches, purpose);
  }
  if (idMatches.length === 1) {
    file = idMatches[0];
  } else {
    file = resolveExactFile(schema, index, vaultDir, target, frontmatterByPath, purpose);
  }

  if (!file) {
    throw new Error(`No exact note found for ${purpose} target: ${target}`);
  }

  let parsed = parsedByPath.get(file.path);
  if (!parsed) {
    try {
      parsed = await parseNote(file.path);
      parsedByPath.set(file.path, parsed);
    } catch (error) {
      throw new Error(
        `Cannot read ${purpose} source ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const typeName = resolveTypeFromFrontmatter(schema, parsed.frontmatter);
  if (!typeName) {
    throw new Error(`${capitalize(purpose)} source does not have a valid schema type: ${file.relativePath}`);
  }

  snapshot ??= {
    notes: index.allFiles.map((candidate) => {
      const candidateFrontmatter = frontmatterByPath.get(candidate.path);
      const resolvedType = candidateFrontmatter
        ? resolveTypeFromFrontmatter(schema, candidateFrontmatter)
        : undefined;
      return {
        path: candidate.path,
        relativePath: candidate.relativePath,
        ...(candidate.expectedType ? { directoryType: candidate.expectedType } : {}),
        ...(candidateFrontmatter ? { frontmatter: candidateFrontmatter } : {}),
        ...(resolvedType ? { resolvedType } : {}),
      };
    }),
  };

  return {
    file,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    typeName,
    snapshot,
  };
}

function resolveExactFile(
  schema: LoadedSchema,
  index: NoteIndex,
  vaultDir: string,
  target: string,
  frontmatterByPath: Map<string, Record<string, unknown>>,
  purpose: 'fork' | 'lineage' = 'fork'
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
  if (basenameMatches.length > 1) throwAmbiguousTarget(target, basenameMatches, purpose);
  if (basenameMatches.length === 1) return basenameMatches[0];

  const requested = cleanTarget.toLowerCase();
  const nameMatches: ManagedFile[] = [];
  for (const file of index.allFiles) {
    const name = frontmatterByPath.get(file.path)?.name;
    if (typeof name === 'string' && name.toLowerCase() === requested) {
      nameMatches.push(file);
    }
  }
  if (nameMatches.length > 1) throwAmbiguousTarget(target, nameMatches, purpose);
  if (nameMatches.length === 1) return nameMatches[0];

  const aliasMatches: ManagedFile[] = [];
  for (const file of index.allFiles) {
    const frontmatter = frontmatterByPath.get(file.path);
    if (!frontmatter) continue;
    const typeName = resolveTypeFromFrontmatter(schema, frontmatter);
    if (!typeName) continue;
    const aliases = getEntityAliases(schema, typeName, frontmatter);
    if (aliases.some(alias => alias.toLowerCase() === requested)) aliasMatches.push(file);
  }
  if (aliasMatches.length > 1) throwAmbiguousTarget(target, aliasMatches, purpose);
  return aliasMatches[0];
}

function noteIndexFromSnapshot(snapshot: VaultNoteSnapshot): NoteIndex {
  const allFiles: ManagedFile[] = snapshot.notes.map(note => ({
    path: note.path,
    relativePath: note.relativePath,
    ...(note.directoryType ? { expectedType: note.directoryType } : {}),
  }));
  const byPath = new Map<string, ManagedFile>();
  const byBasename = new Map<string, ManagedFile[]>();
  for (const file of allFiles) {
    byPath.set(file.relativePath, file);
    const name = file.relativePath.replace(/^.*\//, '').replace(/\.md$/, '');
    const matches = byBasename.get(name) ?? [];
    matches.push(file);
    byBasename.set(name, matches);
  }
  return { allFiles, byPath, byBasename, byAlias: new Map() };
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

function throwAmbiguousTarget(
  target: string,
  files: ManagedFile[],
  purpose: 'fork' | 'lineage' = 'fork'
): never {
  const candidates = files.map(file => file.relativePath).sort().join(', ');
  throw new Error(`Ambiguous ${purpose} target "${target}"; matches: ${candidates}`);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
