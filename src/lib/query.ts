import { basename } from 'path';
import type { LoadedSchema } from '../types/schema.js';
import {
  getAllFieldsForType,
  getEntityAliases,
  getType,
  resolveTypeFromFrontmatter,
} from './schema.js';
import { matchesExpression, buildEvalContext, type HierarchyData } from './expression.js';
import { collectFrontmatterKeys, normalizeWhereExpressions } from './where-normalize.js';
import { extractLinkTarget } from './links.js';
import { buildVaultNoteSnapshot, type VaultNoteSnapshot } from './discovery.js';

/**
 * Validate that a field name is valid for a type.
 */
export function validateFieldForType(
  schema: LoadedSchema,
  typeName: string,
  fieldName: string
): { valid: boolean; error?: string } {
  const validFields = getAllFieldsForType(schema, typeName);

  if (!validFields.has(fieldName)) {
    const fieldList = Array.from(validFields).join(', ');
    return {
      valid: false,
      error: `Unknown field '${fieldName}' for type '${typeName}'. Valid fields: ${fieldList}`,
    };
  }

  return { valid: true };
}

/**
 * Options for applyFrontmatterFilters.
 */
export interface FrontmatterFilterOptions {
  /** Expression-based filters (--where) */
  whereExpressions: string[];
  /** Vault directory for building eval context */
  vaultDir: string;
  /** Optional known frontmatter keys for normalization */
  knownKeys?: Set<string>;
  /** Optional schema for resolving parent-like hierarchy fields */
  schema?: LoadedSchema;
  /** Optional type path for type-aware hierarchy resolution */
  typePath?: string;
}

// ============================================================================
// Hierarchy Function Support
// ============================================================================

/** Names of functions that require hierarchy data */
const HIERARCHY_FUNCTIONS = ['isRoot', 'isChildOf', 'isDescendantOf', 'under'];

/**
 * Check if any expression uses hierarchy functions.
 * This is used to determine if we need to build hierarchy data before evaluation.
 */
function expressionsUseHierarchyFunctions(expressions: string[]): boolean {
  return expressions.some(expr =>
    HIERARCHY_FUNCTIONS.some(fn => expr.includes(fn + '('))
  );
}

/**
 * Hierarchy operators that resolve ancestor chains over the FULL vault and so
 * need the augmentation pass that builds `HierarchyData.aliasMap` and merges the
 * full-vault parent chains into `parentMap`.
 *
 * - `under` dereferences a relation field and walks the *target's* ancestor
 *   chain. The target note is usually NOT in the (type-)filtered candidate set,
 *   so its `parent` chain must be sourced from the full vault.
 * - `isChildOf` / `isDescendantOf` walk the candidate note's OWN `parent` chain.
 *   That chain may climb THROUGH notes outside the (type-)filtered candidate set
 *   (e.g. a `task` whose `parent` is a `milestone`), so it too must be sourced
 *   from the full vault or the walk stops early and misses a true ancestor
 *   (#709). They also need the alias map to canonicalize each step (#659).
 *
 * The operators stay semantically distinct regardless of which vault the parent
 * map is sourced from: `under` reads a RELATION FIELD then walks the *target's*
 * chain; `isChildOf`/`isDescendantOf` walk the *candidate note's own* `parent`
 * chain (direct child vs any ancestor). Sourcing every chain from the full vault
 * only fixes early truncation — it does not collapse what each operator reads.
 */
const FULL_VAULT_HIERARCHY_FUNCTIONS = ['under', 'isChildOf', 'isDescendantOf'];

function expressionsNeedVaultAugmentation(expressions: string[]): boolean {
  return expressions.some(expr =>
    FULL_VAULT_HIERARCHY_FUNCTIONS.some(fn => expr.includes(fn + '('))
  );
}

/**
 * Build hierarchy data from a set of files for use in expression evaluation.
 * This builds the parent and children maps needed for isRoot, isChildOf, isDescendantOf.
 */
function buildHierarchyDataFromFiles(
  files: FileWithFrontmatter[],
  options: Pick<FrontmatterFilterOptions, 'schema' | 'typePath'>
): HierarchyData {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, Set<string>>();
  const nonRootNames = new Set<string>();
  const reservedNames = new Set<string>();
  const hierarchyFieldCache = new Map<string, string[]>();

  for (const file of files) {
    // Candidate pass: reserve every candidate's basename as an authoritative
    // hierarchy identity (with or without a literal `parent`), so the full-vault
    // augmentation cannot fill/overwrite it from a same-basename note elsewhere.
    addParentRelationship(file, parentMap, childrenMap, reservedNames, true);
    // Separately record whether the candidate carries ANY parent-like link, for
    // `isRoot`. This is broader than the structural `parent` chain (it includes
    // single-valued same-ancestry relations like `task.milestone`), which is why
    // it is tracked apart from `parentMap`.
    if (noteHasParentLikeLink(file, options, hierarchyFieldCache)) {
      nonRootNames.add(basename(file.path, '.md'));
    }
  }

  return { parentMap, childrenMap, nonRootNames, reservedNames };
}

/**
 * True when the note carries any parent-LIKE link — the literal `parent`, an
 * `owner`, or a single-valued same-ancestry relation (e.g. `task.milestone`).
 * Used only to seed `HierarchyData.nonRootNames` for `isRoot`; the structural
 * `parent` chain walked by `isChildOf`/`isDescendantOf`/`under` is built
 * separately (literal `parent` only) by `addParentRelationship`.
 */
function noteHasParentLikeLink(
  file: FileWithFrontmatter,
  options: Pick<FrontmatterFilterOptions, 'schema' | 'typePath'>,
  hierarchyFieldCache: Map<string, string[]>
): boolean {
  const typeName = resolveHierarchyType(file.frontmatter, options);
  const hierarchyFields = getHierarchyFields(typeName, options.schema, hierarchyFieldCache);
  return getHierarchyParentValue(file.frontmatter, hierarchyFields) !== undefined;
}

/**
 * Record a note's structural `parent` edge into the parent/children maps.
 *
 * `reservedNames` distinguishes the two passes (see `HierarchyData.reservedNames`):
 *
 * - CANDIDATE pass (`reserve: true`): always RESERVE the candidate's basename as
 *   an authoritative identity — even when the candidate has no `parent` (it then
 *   stays terminal/root). This claims the basename so the later full-vault pass
 *   cannot fill or overwrite it from a same-basename note elsewhere.
 * - VAULT-AUGMENTATION pass (`reserve: false`): SKIP any basename already
 *   reserved by a candidate, and only add edges for non-candidate notes (the
 *   intermediate ancestors that complete a chain climbing through filtered-out
 *   notes, #709).
 */
function addParentRelationship(
  file: FileWithFrontmatter,
  parentMap: Map<string, string>,
  childrenMap: Map<string, Set<string>>,
  reservedNames: Set<string>,
  reserve: boolean
): void {
  const noteName = basename(file.path, '.md');

  if (reserve) {
    // Claim this candidate's basename as authoritative so the full-vault pass
    // cannot fill/overwrite it from a same-basename note elsewhere. A parentless
    // candidate is reserved too: it must stay root, not be hijacked.
    reservedNames.add(noteName);
  } else if (reservedNames.has(noteName)) {
    // A candidate already owns this basename; never let a same-basename vault
    // note supply or clobber its hierarchy.
    return;
  }

  // Don't let a later (less specific, full-vault) pass clobber an entry the
  // type-aware pass already resolved for the candidate set.
  if (parentMap.has(noteName)) return;

  // The STRUCTURAL parent chain is the literal `parent` field ONLY. Parent-like
  // relations (e.g. `task.milestone`) are NOT folded in here: doing so used to
  // make `isDescendantOf` silently collapse with `under(<relation>, …)` and made
  // these operators disagree with `--output tree` (which also walks `parent`
  // only). Query a relation field with the `under` operator instead. (#709)
  const parentValue = file.frontmatter['parent'];
  if (typeof parentValue !== 'string' || parentValue.trim() === '') return;

  const parentTarget = extractLinkTarget(parentValue) ?? parentValue.trim();
  if (!parentTarget) return;

  parentMap.set(noteName, parentTarget);

  if (!childrenMap.has(parentTarget)) {
    childrenMap.set(parentTarget, new Set());
  }
  childrenMap.get(parentTarget)!.add(noteName);
}

/**
 * Augment hierarchy data with data sourced from the entire vault.
 *
 * Two things are attached, both derived from a SINGLE vault snapshot:
 *
 * 1. The full-vault parent map (`HierarchyData.parentMap`). Merged in for ALL
 *    the full-vault hierarchy operators (`under`, `isChildOf`,
 *    `isDescendantOf`). `under` dereferences a relation field to a note that
 *    usually lives OUTSIDE the (type-)filtered candidate set, so that target's
 *    ancestor chain must come from the whole vault. `isChildOf`/`isDescendantOf`
 *    walk the *candidate note's own* `parent` chain, but that chain may climb
 *    THROUGH notes outside the candidate set (e.g. a `task` whose `parent` is a
 *    `milestone` that is filtered out by `--type task`); sourcing only the
 *    candidate-filtered map truncated the walk and missed true ancestors (#709).
 *    The candidate pass runs first and always wins on conflicts
 *    (`addParentRelationship` skips notes already mapped); the full-vault pass
 *    only fills in the rest of the chain. All passes use the literal `parent`
 *    field, so the structural chain is uniform across the vault.
 *
 * 2. The alias -> canonical-note map (`HierarchyData.aliasMap`). Consumed by all
 *    the operators to canonicalize aliased relation/parent values and aliased
 *    query nodes before walking the chain (#636/#659).
 *
 * Performance: both outputs come from one `buildVaultNoteSnapshot` pass (the
 * vault is walked and parsed once, resolving each note's type in the same pass),
 * so a hierarchy query never re-reads the vault for the alias map.
 */
async function augmentHierarchyDataFromVault(
  hierarchyData: HierarchyData,
  options: Pick<FrontmatterFilterOptions, 'schema'> & {
    vaultDir: string;
    /** Optional pre-built snapshot to reuse instead of walking the vault again. */
    snapshot?: VaultNoteSnapshot;
  }
): Promise<void> {
  if (!options.schema) return;

  const snapshot =
    options.snapshot ?? (await buildVaultNoteSnapshot(options.schema, options.vaultDir));

  // Candidate basenames are authoritative identities; the vault pass must not
  // fill or overwrite them from a same-basename note elsewhere (see
  // HierarchyData.reservedNames). It still supplies parent edges for
  // NON-candidate notes — the intermediate ancestors of a chain that climbs
  // through filtered-out notes (#709).
  const reservedNames = hierarchyData.reservedNames ?? new Set<string>();
  for (const note of snapshot.notes) {
    if (!note.frontmatter) continue;
    addParentRelationship(
      { path: note.path, frontmatter: note.frontmatter },
      hierarchyData.parentMap,
      hierarchyData.childrenMap,
      reservedNames,
      false
    );
  }

  // Build the alias -> canonical-note map from the SAME snapshot so the
  // operators can canonicalize aliased values and query nodes (see
  // HierarchyData.aliasMap) without re-reading the vault.
  hierarchyData.aliasMap = buildVaultAliasMap(options.schema, snapshot);
}

/**
 * Build a map from each declared alias to the canonical note name it resolves
 * to, from a vault snapshot. Reuses the same alias index that drives navigation
 * (`getEntityAliases` from #266) so `under` canonicalizes aliases identically to
 * `bwrb open <alias>`.
 *
 * Trust model (consistent with navigation's alias resolution and
 * `deriveNotePathMap`):
 * - An alias never shadows a real note name.
 * - An alias claimed by more than one note is AMBIGUOUS and is dropped from the
 *   map entirely. Resolving it to one note's subtree would reintroduce silent
 *   data loss, and silently picking a winner is exactly the footgun this guards
 *   against, so an ambiguous alias resolves to nothing (no match, no crash).
 */
function buildVaultAliasMap(
  schema: LoadedSchema,
  snapshot: VaultNoteSnapshot
): Map<string, string> {
  // Real note names always win over aliases.
  const realNames = new Set<string>();
  for (const note of snapshot.notes) {
    realNames.add(basename(note.relativePath, '.md'));
  }

  // First pass: count how many notes claim each (non-shadowed) alias.
  const claims = new Map<string, string[]>();
  for (const note of snapshot.notes) {
    if (!note.resolvedType || !note.frontmatter) continue;
    const canonical = basename(note.relativePath, '.md');
    const aliases = getEntityAliases(schema, note.resolvedType, note.frontmatter);
    for (const alias of aliases) {
      if (realNames.has(alias)) continue; // never shadow a real note
      const existing = claims.get(alias);
      if (existing) {
        if (!existing.includes(canonical)) existing.push(canonical);
      } else {
        claims.set(alias, [canonical]);
      }
    }
  }

  // Second pass: keep only unambiguous aliases.
  const aliasMap = new Map<string, string>();
  for (const [alias, canonicals] of claims) {
    if (canonicals.length === 1) {
      aliasMap.set(alias, canonicals[0]!);
    }
  }
  return aliasMap;
}

function resolveHierarchyType(
  frontmatter: Record<string, unknown>,
  options: Pick<FrontmatterFilterOptions, 'schema' | 'typePath'>
): string | undefined {
  if (options.typePath) {
    return options.typePath;
  }

  if (!options.schema) {
    return undefined;
  }

  return resolveTypeFromFrontmatter(options.schema, frontmatter);
}

function getHierarchyFields(
  typeName: string | undefined,
  schema: LoadedSchema | undefined,
  cache: Map<string, string[]>
): string[] {
  if (!typeName || !schema) {
    return ['parent', 'owner'];
  }

  const cached = cache.get(typeName);
  if (cached) {
    return cached;
  }

  const type = getType(schema, typeName);
  if (!type) {
    return ['parent', 'owner'];
  }

  const fields = new Set<string>(['parent']);
  const ancestry = new Set(type.ancestors.filter(ancestor => ancestor !== 'meta'));

  if (schema.ownership.canBeOwnedBy.has(typeName)) {
    fields.add('owner');
  }

  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (fieldName === 'parent' || fieldName === 'owner') continue;
    if (field.prompt !== 'relation' || field.multiple === true || !field.source) continue;

    const sources = Array.isArray(field.source) ? field.source : [field.source];
    const matchesParentLikeRelation = sources.some(sourceName => {
      if (fieldName !== sourceName) {
        return false;
      }

      if (sourceName === typeName || ancestry.has(sourceName)) {
        return true;
      }

      const sourceType = getType(schema, sourceName);
      if (!sourceType) {
        return false;
      }

      return sourceType.ancestors.some(
        ancestor => ancestor !== 'meta' && ancestry.has(ancestor)
      );
    });

    if (matchesParentLikeRelation) {
      fields.add(fieldName);
    }
  }

  const resolved = Array.from(fields);
  cache.set(typeName, resolved);
  return resolved;
}

function getHierarchyParentValue(
  frontmatter: Record<string, unknown>,
  hierarchyFields: string[]
): unknown {
  for (const fieldName of hierarchyFields) {
    const value = frontmatter[fieldName];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  return undefined;
}

/**
 * A file with its parsed frontmatter.
 */
export interface FileWithFrontmatter {
  path: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Apply frontmatter filters to a list of files.
 * 
 * Filters files using expression filters (--where).
 * Returns only files that match all criteria.
 * 
 * @param files - Array of objects with path and frontmatter
 * @param options - Filter options
 * @returns Filtered array of files
 */
export async function applyFrontmatterFilters<T extends FileWithFrontmatter>(
  files: T[],
  options: FrontmatterFilterOptions
): Promise<T[]> {
  const { whereExpressions, vaultDir, knownKeys, schema, typePath } = options;
  const result: T[] = [];
  const effectiveKnownKeys =
    knownKeys ?? collectFrontmatterKeys(files.map(file => file.frontmatter));
  const normalizedExpressions = normalizeWhereExpressions(
    whereExpressions,
    effectiveKnownKeys
  );
  const expressionPairs = normalizedExpressions.map((normalized, index) => ({
    normalized,
    original: whereExpressions[index] ?? normalized,
  }));

  // Build hierarchy data if any expression uses hierarchy functions
  // This is done once before the loop for efficiency
  let hierarchyData: HierarchyData | undefined;
  if (
    normalizedExpressions.length > 0 &&
    expressionsUseHierarchyFunctions(normalizedExpressions)
  ) {
    hierarchyData = buildHierarchyDataFromFiles(files, {
      ...(schema ? { schema } : {}),
      ...(typePath ? { typePath } : {}),
    });

    // `under`, `isChildOf`, and `isDescendantOf` all resolve ancestor chains
    // over the FULL vault: `under` dereferences a relation to a target outside
    // the candidate set, and `isChildOf`/`isDescendantOf` may walk the candidate
    // note's own `parent` chain THROUGH notes outside the candidate set (#709).
    // The vault-wide parent map and alias map are built from a single snapshot;
    // the candidate-only pass above runs first and wins on conflicts.
    if (schema && expressionsNeedVaultAugmentation(normalizedExpressions)) {
      await augmentHierarchyDataFromVault(hierarchyData, {
        schema,
        vaultDir,
      });
    }
  }

  for (const file of files) {
    // Apply expression filters (--where style)
    if (expressionPairs.length > 0) {
      const context = await buildEvalContext(file.path, vaultDir, file.frontmatter);
      // Add hierarchy data to context if available
      if (hierarchyData) {
        context.hierarchyData = hierarchyData;
      }
      let allMatch = true;
      for (const { normalized, original } of expressionPairs) {
        try {
          if (!matchesExpression(normalized, context)) {
            allMatch = false;
            break;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(`Expression error in "${original}": ${message}`);
        }
      }

      if (!allMatch) {
        continue;
      }
    }

    result.push(file);
  }

  return result;
}
