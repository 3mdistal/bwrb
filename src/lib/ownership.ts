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
} from './schema.js';
import { getOwnedChildFolderFromOwnerDir } from './ownership-paths.js';
import type { LoadedSchema } from '../types/schema.js';
import { extractLinkTargets, isWikilink } from './links.js';
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
   */
  declaredOwned: Map<string, OwnedNoteInfo>;
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
            declaredOwned
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
          declaredOwned
        );
      }
    }
  }

  return { ownedNotes, ownerToOwned, declaredOwned };
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
  declaredOwned: Map<string, OwnedNoteInfo>
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

  // For each owned field, look for the owned field subfolder
  for (const ownedField of ownedFields) {
    // Record declared ownership from the owner's frontmatter (`owned` field).
    // Keyed by the lowercased wikilink target name so a misplaced owned note can
    // be matched by basename regardless of where it currently lives.
    for (const refName of extractWikilinkReferences(ownerFrontmatter[ownedField.fieldName])) {
      const key = refName.toLowerCase();
      if (!declaredOwned.has(key)) {
        declaredOwned.set(key, {
          notePath: refName,
          ownerPath: relativeOwnerPath,
          ownerType: ownerTypeName,
          fieldName: ownedField.fieldName,
        });
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
 * Look up the owner that DECLARES this note as owned (via one of its `owned`
 * frontmatter fields), keyed by the note's basename (without extension).
 *
 * Unlike `isNoteOwned` (physical-location index), this resolves ownership from
 * the owner's declaration, so it still finds the owner of a note that has been
 * moved out of its `<owner-dir>/<field>/` folder — the case audit needs to
 * restore a genuinely-misplaced owned note (#702/#703).
 */
export function findDeclaredOwner(
  index: OwnershipIndex,
  noteName: string
): OwnedNoteInfo | undefined {
  return index.declaredOwned.get(noteName.toLowerCase());
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
