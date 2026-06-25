/**
 * Ownership tracking and validation.
 * 
 * This module handles runtime ownership validation:
 * - Building an index of what notes are owned by what
 * - Checking if a note is already owned before allowing references
 * - Validating ownership exclusivity (owned notes can't be referenced by other notes)
 */

import { readdir } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { existsSync } from 'fs';
import {
  getOwnedFields,
  getOutputDir,
  getDescendants,
  resolveTypeFromFrontmatter,
} from './schema.js';
import { getOwnedChildFolderFromOwnerDir } from './ownership-paths.js';
import type { LoadedSchema } from '../types/schema.js';
import {
  extractLinkTargets,
  isWikilink,
  wikilinkTargetBasename,
  wikilinkTargetPath,
} from './links.js';
import { parseNote } from './frontmatter.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Information about an owned note in the vault.
 */
export interface OwnedNoteInfo {
  /** Path to the owned note (relative to vault) */
  notePath: string;
  /** Path to the owner note (relative to vault) */
  ownerPath: string;
  /** Owner type name */
  ownerType: string;
  /** Field on owner that declares ownership */
  fieldName: string;
  /**
   * The PATH-QUALIFIED target portion of the wikilink the owner wrote in its
   * `owned` field, with any display alias/heading stripped but the path qualifier
   * PRESERVED (via `wikilinkTargetPath`). For a declaration built from the
   * physical-folder scan this is undefined (no original link to remember).
   *
   * This is what makes declared-ownership resolution path-aware (#734): when the
   * declaration is path-qualified (`Albums/Best Album/songs/Owned`) the link can
   * be resolved to the file at that EXACT relative path, so an UNRELATED note
   * that merely shares the basename at a different path is NOT mistaken for the
   * declared owned note. A bare declaration (`Owned`, no `/`) leaves this as the
   * bare basename and falls back to basename matching as before. Always present
   * for declarations sourced from owner frontmatter.
   */
  declaredTarget?: string;
}

/**
 * Index of ownership relationships in the vault.
 * Built by scanning the vault and matching notes to owners.
 */
export interface OwnershipIndex {
  /** Map from owned note path → ownership info */
  ownedNotes: Map<string, OwnedNoteInfo>;
  /** Map from owner note path → set of owned note paths */
  ownerToOwned: Map<string, Set<string>>;
  /**
   * Map from a *declared* owned-note name (the wikilink target an owner lists in
   * one of its `owned` fields, lowercased) → ownership info.
   *
   * Unlike `ownedNotes` (which is keyed by physical path and only ever contains
   * notes already sitting in a valid owner subtree), this map is built from the
   * owner's frontmatter declaration, so it ALSO covers an owned note that has
   * been moved OUT of its owner's `<owner-dir>/<field>/` folder. It is what lets
   * audit recognise a genuinely-misplaced owned note as owned and restore it
   * under its owner (#702/#703).
   *
   * When the SAME basename is declared by two or more DISTINCT owners, only the
   * first-scanned owner is kept here (a map can hold one value per key); the
   * collision is recorded separately in `ambiguousDeclaredOwners` so callers can
   * detect the conflict instead of silently trusting the arbitrary winner.
   */
  declaredOwned: Map<string, OwnedNoteInfo>;
  /**
   * Set of `declaredOwned` keys that are declared by MORE THAN ONE distinct
   * owner. A basename in this set is AMBIGUOUS: we cannot know which owner a
   * misplaced note of that name truly belongs to, so audit must surface it as a
   * conflict requiring MANUAL resolution rather than auto-restoring it under an
   * arbitrarily-chosen owner (#734 / multi-owner data-safety gap).
   *
   * NOTE: this set answers ambiguity by BASENAME ALONE and is intentionally
   * type-blind. It is retained for callers that only care that a basename is
   * declared by multiple owners. Audit's misplaced-owned-note logic must NOT use
   * it directly to decide a conflict, because two owners declaring the same
   * basename for owned fields of one type does not make a DIFFERENT-typed,
   * correctly-filed note of that name ambiguous. For type-aware ambiguity, use
   * `getDeclaredOwners` and filter by the audited note's resolved child type.
   */
  ambiguousDeclaredOwners: Set<string>;
  /**
   * Map from a declared owned-note name (normalized via `declaredOwnerKey`) →
   * the list of ALL distinct PER-FIELD declarations of that basename
   * (deduplicated by owner path + declaring field). Unlike `declaredOwned`
   * (first owner only) this preserves every declaration's `OwnedNoteInfo` (owner
   * path/type + the declaring field + declared target), so callers can
   * re-evaluate ambiguity AFTER filtering to the declarations whose owned child
   * TYPE matches the audited note's resolved type. This is what lets audit avoid
   * flagging an unrelated, different-typed note that merely shares a basename
   * with an ambiguous owned declaration (#734 follow-up).
   *
   * Keyed per FIELD (not per owner) so one owner that declares the same basename
   * in TWO owned fields of DIFFERENT child types (e.g. `tracks -> track` AND
   * `notes -> note` both listing `[[Shared]]`) keeps BOTH declarations; the
   * type-aware filter then resolves the audited note via the declaration whose
   * child type matches it. Because one owner can therefore contribute multiple
   * entries, callers that judge MULTI-OWNER ambiguity must re-dedup by owner path
   * (a single owner spanning two fields is not two owners) (#734).
   */
  declaredOwnersByName: Map<string, OwnedNoteInfo[]>;
}

/**
 * Result of an ownership validation check.
 */
export interface OwnershipValidation {
  valid: boolean;
  errors: OwnershipError[];
}

/**
 * An ownership violation error.
 */
export interface OwnershipError {
  type: 'already_owned' | 'multiple_owners' | 'wrong_location' | 'referencing_owned';
  notePath: string;
  message: string;
  details?: {
    existingOwner?: string;
    existingOwnerPath?: string;
    attemptedOwner?: string;
    expectedLocation?: string;
    actualLocation?: string;
    referencingNote?: string;
  };
}

// ============================================================================
// Ownership Index Building
// ============================================================================

/**
 * Build an ownership index by scanning the vault.
 * 
 * This scans all notes in the vault and determines which are owned by analyzing:
 * 1. Their location (in an owner's folder structure)
 * 2. Owner notes' frontmatter (which references owned notes)
 */
export async function buildOwnershipIndex(
  schema: LoadedSchema,
  vaultDir: string
): Promise<OwnershipIndex> {
  const ownedNotes = new Map<string, OwnedNoteInfo>();
  const ownerToOwned = new Map<string, Set<string>>();
  const declaredOwned = new Map<string, OwnedNoteInfo>();
  const ambiguousDeclaredOwners = new Set<string>();
  const declaredOwnersByName = new Map<string, OwnedNoteInfo[]>();

  // Find all types that can own things
  const ownerTypes = new Set<string>();
  for (const [typeName] of schema.ownership.owns) {
    ownerTypes.add(typeName);
  }
  
  // Scan each owner type's directory
  for (const ownerTypeName of ownerTypes) {
    const ownerOutputDir = getOutputDir(schema, ownerTypeName);
    if (!ownerOutputDir) continue;
    
    const ownerDir = join(vaultDir, ownerOutputDir);
    if (!existsSync(ownerDir)) continue;
    
    // Find owner notes
    const entries = await readdir(ownerDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check for owner note inside folder (e.g., drafts/My Novel/My Novel.md)
        const ownerNotePath = join(ownerDir, entry.name, `${entry.name}.md`);
        if (existsSync(ownerNotePath)) {
          await indexOwnerNote(
            schema,
            vaultDir,
            ownerNotePath,
            ownerTypeName,
            ownedNotes,
            ownerToOwned,
            declaredOwned,
            ambiguousDeclaredOwners,
            declaredOwnersByName
          );
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Flat owner note (e.g., drafts/My Novel.md)
        const ownerNotePath = join(ownerDir, entry.name);
        await indexOwnerNote(
          schema,
          vaultDir,
          ownerNotePath,
          ownerTypeName,
          ownedNotes,
          ownerToOwned,
          declaredOwned,
          ambiguousDeclaredOwners,
          declaredOwnersByName
        );
      }
    }
  }

  return {
    ownedNotes,
    ownerToOwned,
    declaredOwned,
    ambiguousDeclaredOwners,
    declaredOwnersByName,
  };
}

/**
 * Index a single owner note and its owned children.
 */
async function indexOwnerNote(
  schema: LoadedSchema,
  vaultDir: string,
  ownerNotePath: string,
  ownerTypeName: string,
  ownedNotes: Map<string, OwnedNoteInfo>,
  ownerToOwned: Map<string, Set<string>>,
  declaredOwned: Map<string, OwnedNoteInfo>,
  ambiguousDeclaredOwners: Set<string>,
  declaredOwnersByName: Map<string, OwnedNoteInfo[]>
): Promise<void> {
  const relativeOwnerPath = relative(vaultDir, ownerNotePath);
  const ownedFields = getOwnedFields(schema, ownerTypeName);

  if (ownedFields.length === 0) return;

  // Check if there's a folder structure for this owner
  const ownerFolder = dirname(ownerNotePath);

  // Read the owner's frontmatter once so its `owned`-field references can be
  // recorded as DECLARED ownership. This is what lets audit recognise an owned
  // note that has been moved out of its owner subtree (the physical-folder scan
  // below can only see notes still in the right place). Best-effort: a parse
  // failure simply means no declared ownership for this owner.
  let ownerFrontmatter: Record<string, unknown> = {};
  try {
    ownerFrontmatter = (await parseNote(ownerNotePath)).frontmatter;
  } catch {
    ownerFrontmatter = {};
  }

  // Validate that this note is a GENUINE owner of `ownerTypeName` before letting
  // its `owned` declarations into `declaredOwned`. The physical-folder scan above
  // reached this note purely because it sits at `<owner-dir>/<owner>.md` — it
  // never checked that the note's actual `type` resolves to the expected owner
  // type. A "fake owner" (e.g. `Albums/Fake/Fake.md` with `type: note`, not
  // `album`) would otherwise contribute declared ownership, making any same-named
  // child-type note elsewhere look `owned-wrong-location` and get restored under
  // the fake owner. This mirrors the #661 fake-owner guard on the colocated
  // (physical) path in detection.ts (`ownerNoteIsValid`): only honor the owner
  // when its resolved type equals `ownerTypeName` (or is a descendant of it).
  // When the note has no resolvable type we conservatively skip its declarations
  // rather than risk crediting a fake owner.
  const ownerNoteResolvedType = resolveTypeFromFrontmatter(schema, ownerFrontmatter);
  const ownerNoteIsGenuine =
    ownerNoteResolvedType !== undefined &&
    (ownerNoteResolvedType === ownerTypeName ||
      getDescendants(schema, ownerTypeName).includes(ownerNoteResolvedType));

  // For each owned field, look for the owned field subfolder
  for (const ownedField of ownedFields) {
    // Record declared ownership from the owner's frontmatter (`owned` field).
    // Keyed by the NORMALIZED wikilink target (basename, alias/heading/path
    // stripped, lowercased) via `declaredOwnerKey` so a misplaced owned note can
    // be matched by basename regardless of how the owner wrote the link
    // (`[[Opening Track]]`, `[[Tracks/Opening Track]]`, `[[Opening Track|Intro]]`,
    // `[[Tracks/Opening Track|Intro]]`). The lookup (`findDeclaredOwner`) derives
    // its key the same way, so all wikilink forms agree.
    // Skipped entirely for a fake/wrong-type owner (see `ownerNoteIsGenuine`).
    for (const refName of ownerNoteIsGenuine
      ? extractWikilinkReferences(ownerFrontmatter[ownedField.fieldName])
      : []) {
      const normalizedName = wikilinkTargetBasename(refName);
      const key = declaredOwnerKey(normalizedName);
      const info: OwnedNoteInfo = {
        notePath: normalizedName,
        ownerPath: relativeOwnerPath,
        ownerType: ownerTypeName,
        fieldName: ownedField.fieldName,
        // Preserve the PATH-QUALIFIED target so detection can resolve a
        // path-qualified declaration to the file at that exact path and avoid
        // claiming an unrelated same-basename note elsewhere (#734).
        declaredTarget: wikilinkTargetPath(refName),
      };
      const existing = declaredOwned.get(key);
      if (existing === undefined) {
        declaredOwned.set(key, info);
      } else if (existing.ownerPath !== relativeOwnerPath) {
        // A DIFFERENT owner already declares this basename. We cannot pick one
        // owner without guessing, so flag the key as ambiguous. The first-seen
        // entry is retained in `declaredOwned` (callers that only need *some*
        // owner still work) but audit consults `ambiguousDeclaredOwners` first
        // and refuses to auto-restore an ambiguous note under a guessed owner
        // (#734). A repeat declaration from the SAME owner (e.g. the basename
        // listed twice, or under two of its own fields) is not a conflict.
        ambiguousDeclaredOwners.add(key);
      }

      // Record EVERY distinct PER-FIELD declaration of this basename, preserving
      // each owner's type + the declaring field + the path-qualified target. This
      // is the type-aware source of truth: audit filters this list to the
      // declarations whose owned child TYPE matches the audited note's resolved
      // type before deciding whether the note is ambiguous, misplaced, or simply
      // not owned (#734 follow-up).
      //
      // The dedup key is owner path + declaring FIELD (not owner path alone): one
      // owner can declare the same basename in TWO owned fields with DIFFERENT
      // child types (e.g. `tracks -> track` AND `notes -> note` both listing
      // `[[Shared]]`). Keying by owner path alone would drop the second field's
      // declaration and its child type, so the type-aware filter would never see
      // the matching child type and would misclassify the note (#734). Keying by
      // owner+field keeps both, so the audited file resolves via the declaration
      // whose child type matches it. A TRUE duplicate (same owner, same field,
      // same basename — e.g. listed twice in one multi-value field) still
      // collapses to one. The downstream filter additionally re-dedups the
      // surviving declarations by owner path before counting toward ambiguity, so
      // a single owner declaring this basename across two fields never counts as
      // two distinct owners.
      const owners = declaredOwnersByName.get(key);
      if (owners === undefined) {
        declaredOwnersByName.set(key, [info]);
      } else if (
        !owners.some(
          o =>
            o.ownerPath === relativeOwnerPath &&
            o.fieldName === ownedField.fieldName
        )
      ) {
        owners.push(info);
      }
    }

    const ownedFieldFolder = getOwnedChildFolderFromOwnerDir(ownerFolder, ownedField.fieldName);

    if (!existsSync(ownedFieldFolder)) continue;

    const childEntries = await readdir(ownedFieldFolder, { withFileTypes: true });

    for (const childEntry of childEntries) {
      if (childEntry.isFile() && childEntry.name.endsWith('.md')) {
        const ownedNotePath = join(ownedFieldFolder, childEntry.name);
        const relativeOwnedPath = relative(vaultDir, ownedNotePath);

        // Add to index
        ownedNotes.set(relativeOwnedPath, {
          notePath: relativeOwnedPath,
          ownerPath: relativeOwnerPath,
          ownerType: ownerTypeName,
          fieldName: ownedField.fieldName,
        });

        // Add to owner's owned set
        const owned = ownerToOwned.get(relativeOwnerPath) ?? new Set();
        owned.add(relativeOwnedPath);
        ownerToOwned.set(relativeOwnerPath, owned);
      }
    }
  }
}

// ============================================================================
// Ownership Validation
// ============================================================================

/**
 * Check if a note is owned.
 */
export function isNoteOwned(
  index: OwnershipIndex,
  notePath: string
): OwnedNoteInfo | undefined {
  return index.ownedNotes.get(notePath);
}

/**
 * Compute the `declaredOwned` map key for a note name.
 *
 * Both the index (built from owner wikilink declarations) and the lookup
 * (`findDeclaredOwner`, called with a note's basename) route through this single
 * helper so their keys always agree. `wikilinkTargetBasename` makes the key
 * tolerant of path-qualified/aliased declared links; lowercasing keeps it
 * case-insensitive, consistent with the rest of relation resolution.
 */
function declaredOwnerKey(noteName: string): string {
  return wikilinkTargetBasename(noteName).toLowerCase();
}

/**
 * Look up the owner that DECLARES this note as owned (via one of its `owned`
 * frontmatter fields), keyed by the note's basename (without extension).
 *
 * Unlike `isNoteOwned` (physical-location index), this resolves ownership from
 * the owner's declaration, so it still finds the owner of a note that has been
 * moved out of its `<owner-dir>/<field>/` folder — the case audit needs to
 * restore a genuinely-misplaced owned note (#702/#703).
 *
 * The key is derived via the same `declaredOwnerKey` normalization used when the
 * index is built, so a declaration written with a path qualifier or display
 * alias (`[[Tracks/Opening Track|Intro]]`) still matches a lookup by the note's
 * plain basename (`Opening Track`).
 */
export function findDeclaredOwner(
  index: OwnershipIndex,
  noteName: string
): OwnedNoteInfo | undefined {
  return index.declaredOwned.get(declaredOwnerKey(noteName));
}

/**
 * Return ALL distinct PER-FIELD declarations of this note's basename as owned
 * (each via one of an owner's `owned` frontmatter fields), deduplicated by owner
 * path + declaring field.
 *
 * Unlike `findDeclaredOwner` (which returns only the first-scanned owner) and
 * `isDeclaredOwnershipAmbiguous` (a type-blind basename check), this exposes
 * every declaration together with the owner and field that declared it, so a
 * caller holding the schema can derive each declaration's owned child TYPE and
 * decide ambiguity using ONLY the declarations whose child type matches the
 * audited note. That type filter is what prevents a correctly-filed,
 * different-typed note that merely shares a basename with an ambiguous owned
 * declaration from being mislabeled an ownership conflict (#734 follow-up).
 *
 * Because the list is keyed per field, a single owner that declares the same
 * basename across two fields appears more than once. Callers judging MULTI-OWNER
 * ambiguity must re-dedup by owner path after the type filter (one owner across
 * two fields is not two owners).
 *
 * Keyed via the same `declaredOwnerKey` normalization as the index, so all
 * wikilink forms agree with the lookup. Returns an empty array when no owner
 * declares the basename.
 */
export function getDeclaredOwners(
  index: OwnershipIndex,
  noteName: string
): OwnedNoteInfo[] {
  return index.declaredOwnersByName.get(declaredOwnerKey(noteName)) ?? [];
}

/**
 * Whether this note's basename is declared as owned by MORE THAN ONE distinct
 * owner — an AMBIGUOUS ownership claim (#734).
 *
 * `findDeclaredOwner` returns only the first-scanned owner for such a basename,
 * which is arbitrary. Audit must therefore consult this BEFORE acting on a
 * declared owner: an ambiguous note cannot be auto-restored under a guessed
 * owner and is instead surfaced as a conflict for manual resolution. Keyed via
 * the same `declaredOwnerKey` normalization as the index, so all wikilink forms
 * agree with the lookup.
 */
export function isDeclaredOwnershipAmbiguous(
  index: OwnershipIndex,
  noteName: string
): boolean {
  return index.ambiguousDeclaredOwners.has(declaredOwnerKey(noteName));
}

/**
 * Check if a note can be referenced by a field on another note.
 * 
 * Rules:
 * - If the target note is owned, it cannot be referenced by ANY schema field
 *   on any note other than its owner
 * - Body wikilinks are unrestricted (not checked here)
 */
export function canReference(
  index: OwnershipIndex,
  referencingNotePath: string,
  targetNotePath: string
): OwnershipValidation {
  const ownedInfo = index.ownedNotes.get(targetNotePath);
  
  if (!ownedInfo) {
    // Target is not owned - can reference freely
    return { valid: true, errors: [] };
  }
  
  // Target is owned - only the owner can reference it
  if (ownedInfo.ownerPath === referencingNotePath) {
    return { valid: true, errors: [] };
  }
  
  // Someone else is trying to reference an owned note - error
  return {
    valid: false,
    errors: [{
      type: 'referencing_owned',
      notePath: targetNotePath,
      message: `Cannot reference owned note "${targetNotePath}" - it is owned by "${ownedInfo.ownerPath}"`,
      details: {
        existingOwner: ownedInfo.ownerType,
        existingOwnerPath: ownedInfo.ownerPath,
        referencingNote: referencingNotePath,
      },
    }],
  };
}

/**
 * Validate that a new owned note doesn't violate ownership rules.
 */
export function validateNewOwned(
  index: OwnershipIndex,
  newNotePath: string,
  ownerPath: string
): OwnershipValidation {
  const existingOwner = index.ownedNotes.get(newNotePath);
  
  if (existingOwner && existingOwner.ownerPath !== ownerPath) {
    return {
      valid: false,
      errors: [{
        type: 'already_owned',
        notePath: newNotePath,
        message: `Note "${newNotePath}" is already owned by "${existingOwner.ownerPath}"`,
        details: {
          existingOwner: existingOwner.ownerType,
          existingOwnerPath: existingOwner.ownerPath,
          attemptedOwner: ownerPath,
        },
      }],
    };
  }
  
  return { valid: true, errors: [] };
}

/**
 * Extract wikilink references from frontmatter field values.
 * Handles both single wikilinks and arrays of wikilinks.
 */
export function extractWikilinkReferences(value: unknown): string[] {
  // Ownership checks historically treated relation values as *wikilinks* only.
  // Keep behavior stable: only extract wikilinks (even if they're embedded in a string)
  // and ignore markdown links.
  if (typeof value === 'string') {
    const targets = extractLinkTargets(value);
    const wikilinkMatches = targets.filter((t) => isWikilink(`[[${t}]]`));
    return Array.from(new Set(wikilinkMatches));
  }

  if (Array.isArray(value)) {
    const refs: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const targets = extractLinkTargets(item);
      const wikilinkMatches = targets.filter((t) => isWikilink(`[[${t}]]`));
      refs.push(...wikilinkMatches);
    }
    return Array.from(new Set(refs));
  }

  return [];
}
