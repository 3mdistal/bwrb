/**
 * Hierarchy utilities for recursive type support.
 * 
 * This module provides shared functionality for detecting cycles in parent
 * references. Used by both eager validation (new/edit commands) and audit.
 */

import { basename } from 'path';
import { parseNote } from './frontmatter.js';
import { extractWikilinkTarget } from './audit/types.js';
import { discoverManagedFiles } from './discovery.js';
import { getType, resolveTypeFromFrontmatter } from './schema.js';
import type { LoadedSchema } from '../types/schema.js';

// ============================================================================
// Types
// ============================================================================

export interface CycleDetectionResult {
  hasCycle: boolean;
  cyclePath: string[] | null;
}

export interface ParentMapOptions {
  /** Only include notes of this type (and descendants if recursive) */
  typeName?: string;
}

// ============================================================================
// Parent Map Building
// ============================================================================

/**
 * Build a map from note names to their parent note names for recursive types.
 * Used to detect cycles in parent references (e.g., A -> B -> A).
 */
export async function buildParentMap(
  schema: LoadedSchema,
  vaultDir: string,
  options: ParentMapOptions = {}
): Promise<Map<string, string>> {
  const parentMap = new Map<string, string>();
  const files = await discoverManagedFiles(schema, vaultDir);
  
  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file.path);
      const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
      if (!typePath) continue;
      
      // If filtering by type, skip notes that don't match
      if (options.typeName && typePath !== options.typeName) {
        // Also check if it's a descendant type
        const typeDef = getType(schema, typePath);
        if (!typeDef?.recursive) continue;
      }
      
      const typeDef = getType(schema, typePath);
      if (!typeDef?.recursive) continue;
      
      // Get the parent field value
      const parentValue = frontmatter['parent'];
      if (!parentValue) continue;
      
      // Extract the parent note name from the wikilink
      const parentTarget = extractWikilinkTarget(String(parentValue));
      if (parentTarget) {
        const noteName = basename(file.path, '.md');
        parentMap.set(noteName, parentTarget);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }
  
  return parentMap;
}

/**
 * Build a note name to path map for resolving wikilinks to file paths.
 */
export async function buildNotePathMap(
  schema: LoadedSchema,
  vaultDir: string
): Promise<Map<string, string>> {
  const notePathMap = new Map<string, string>();
  const files = await discoverManagedFiles(schema, vaultDir);
  
  for (const file of files) {
    const noteName = basename(file.path, '.md');
    notePathMap.set(noteName, file.path);
  }
  
  return notePathMap;
}

// ============================================================================
// Cycle Detection
// ============================================================================

/**
 * Detect if adding a parent relationship would create a cycle.
 * 
 * This is the core cycle detection algorithm used by both eager validation
 * and audit. It walks the parent chain from the proposed parent and checks
 * if we ever reach the note being edited.
 * 
 * @param noteName - The note being edited/created
 * @param proposedParent - The parent being set (wikilink target, not path)
 * @param parentMap - Map of noteName -> parentTarget for all recursive notes
 * @returns CycleDetectionResult with hasCycle and cyclePath if found
 */
export function detectCycle(
  noteName: string,
  proposedParent: string,
  parentMap: Map<string, string>
): CycleDetectionResult {
  // Self-reference is a cycle
  if (noteName === proposedParent) {
    return {
      hasCycle: true,
      cyclePath: [noteName, proposedParent],
    };
  }
  
  // Walk the parent chain from the proposed parent
  const visited = new Set<string>();
  const path: string[] = [noteName, proposedParent];
  
  visited.add(noteName);
  visited.add(proposedParent);
  
  let current = parentMap.get(proposedParent);
  
  while (current) {
    path.push(current);
    
    if (current === noteName) {
      // Found a cycle back to the original note
      return {
        hasCycle: true,
        cyclePath: path,
      };
    }
    
    if (visited.has(current)) {
      // Found a cycle, but not involving our note - this is an existing cycle
      // in the data that we're not making worse
      break;
    }
    
    visited.add(current);
    current = parentMap.get(current);
  }
  
  return {
    hasCycle: false,
    cyclePath: null,
  };
}

/**
 * Check if a note is part of an existing parent cycle.
 * Used by audit to detect cycles in the vault.
 * 
 * @param noteName - The note to check
 * @param parentMap - Map of noteName -> parentTarget for all recursive notes
 * @returns CycleDetectionResult with hasCycle and cyclePath if found
 */
export function checkExistingCycle(
  noteName: string,
  parentMap: Map<string, string>
): CycleDetectionResult {
  const visited = new Set<string>();
  const path: string[] = [noteName];
  
  visited.add(noteName);
  
  let current = parentMap.get(noteName);
  
  while (current) {
    if (visited.has(current)) {
      // Found a cycle
      return {
        hasCycle: true,
        cyclePath: [...path, current],
      };
    }
    
    visited.add(current);
    path.push(current);
    current = parentMap.get(current);
  }
  
  return {
    hasCycle: false,
    cyclePath: null,
  };
}

// ============================================================================
// Eager Validation
// ============================================================================

export interface CycleValidationError {
  type: 'parent_cycle';
  field: 'parent';
  message: string;
  cyclePath: string[];
}

/**
 * Validate that setting a parent on a note won't create a cycle.
 * This is the eager validation entry point called by new/edit commands.
 * 
 * @param schema - The loaded schema
 * @param vaultDir - The vault directory
 * @param noteName - The note being edited/created (basename without .md)
 * @param parentWikilink - The parent value from frontmatter (e.g., "[[Parent Note]]")
 * @returns null if valid, CycleValidationError if cycle detected
 */
export async function validateParentNoCycle(
  schema: LoadedSchema,
  vaultDir: string,
  noteName: string,
  parentWikilink: string
): Promise<CycleValidationError | null> {
  // Extract the parent target from the wikilink
  const parentTarget = extractWikilinkTarget(parentWikilink);
  if (!parentTarget) {
    // Not a valid wikilink, let other validation handle it
    return null;
  }
  
  // Build the parent map for cycle detection
  const parentMap = await buildParentMap(schema, vaultDir);
  
  // Check for cycle
  const result = detectCycle(noteName, parentTarget, parentMap);
  
  if (result.hasCycle && result.cyclePath) {
    const cycleStr = result.cyclePath.map(n => `[[${n}]]`).join(' → ');
    return {
      type: 'parent_cycle',
      field: 'parent',
      message: `Cannot set parent to '[[${parentTarget}]]' — would create a cycle.\nCycle: ${cycleStr}`,
      cyclePath: result.cyclePath,
    };
  }
  
  return null;
}
