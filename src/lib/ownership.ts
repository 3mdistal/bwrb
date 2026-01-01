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
  getType, 
  getOwnedFields,
  resolveTypeFromFrontmatter,
  getOutputDir,
} from './schema.js';
import type { LoadedSchema } from '../types/schema.js';

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
            ownerToOwned
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
          ownerToOwned
        );
      }
    }
  }
  
  return { ownedNotes, ownerToOwned };
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
  ownerToOwned: Map<string, Set<string>>
): Promise<void> {
  const relativeOwnerPath = relative(vaultDir, ownerNotePath);
  const ownedFields = getOwnedFields(schema, ownerTypeName);
  
  if (ownedFields.length === 0) return;
  
  // Check if there's a folder structure for this owner
  const ownerFolder = dirname(ownerNotePath);
  
  // For each owned field, look for the child type subfolder
  for (const ownedField of ownedFields) {
    const childTypeFolder = join(ownerFolder, ownedField.childType);
    
    if (!existsSync(childTypeFolder)) continue;
    
    const childEntries = await readdir(childTypeFolder, { withFileTypes: true });
    
    for (const childEntry of childEntries) {
      if (childEntry.isFile() && childEntry.name.endsWith('.md')) {
        const ownedNotePath = join(childTypeFolder, childEntry.name);
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
  const references: string[] = [];
  const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
  
  if (typeof value === 'string') {
    let match;
    while ((match = wikilinkPattern.exec(value)) !== null) {
      references.push(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        let match;
        while ((match = wikilinkPattern.exec(item)) !== null) {
          references.push(match[1]!);
        }
      }
    }
  }
  
  return references;
}

/**
 * Validate all frontmatter references in a note against ownership rules.
 */
export async function validateFrontmatterReferences(
  schema: LoadedSchema,
  index: OwnershipIndex,
  notePath: string,
  frontmatter: Record<string, unknown>,
  vaultDir: string
): Promise<OwnershipValidation> {
  const errors: OwnershipError[] = [];
  const noteType = resolveTypeFromFrontmatter(schema, frontmatter);
  
  if (!noteType) {
    return { valid: true, errors: [] };
  }
  
  const type = getType(schema, noteType);
  if (!type) {
    return { valid: true, errors: [] };
  }
  
  // Check each field that references other notes
  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (field.format === 'wikilink' || field.format === 'quoted-wikilink') {
      const value = frontmatter[fieldName];
      const references = extractWikilinkReferences(value);
      
      for (const refName of references) {
        // Find the referenced note's path
        const refPath = await findNoteByName(vaultDir, refName);
        
        if (refPath) {
          const validation = canReference(index, notePath, refPath);
          errors.push(...validation.errors);
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Find a note by name in the vault.
 * Returns the relative path if found.
 */
async function findNoteByName(
  vaultDir: string,
  noteName: string
): Promise<string | undefined> {
  // This is a simplified search - in a full implementation,
  // we'd want to use the discovery module for proper indexing
  
  // Try exact path first
  const directPath = `${noteName}.md`;
  if (existsSync(join(vaultDir, directPath))) {
    return directPath;
  }
  
  // Could expand to search all directories, but for now
  // we rely on the caller providing accurate names
  return undefined;
}
