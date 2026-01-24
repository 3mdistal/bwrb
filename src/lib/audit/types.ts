/**
 * Audit types and interfaces.
 * 
 * This module contains all type definitions for the audit system.
 */

import type { LoadedSchema } from '../../types/schema.js';

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Issue severity levels.
 */
export type IssueSeverity = 'error' | 'warning';

/**
 * Issue codes for audit findings.
 */
export type IssueCode =
  | 'orphan-file'
  | 'invalid-type'
  | 'missing-required'
  | 'invalid-option'
  | 'unknown-field'
  | 'wrong-directory'
  | 'type-mismatch'
  | 'format-violation'
  | 'stale-reference'
  | 'invalid-source-type'
  | 'owned-note-referenced'
  | 'owned-wrong-location'
  | 'parent-cycle'
  | 'self-reference'
  | 'ambiguous-link-target'
  | 'invalid-list-element'
  // Phase 2: Low-risk hygiene auto-fixes
  | 'trailing-whitespace' // NOTE: Not currently detectable (YAML parser strips whitespace)
  | 'frontmatter-key-casing'
  | 'unknown-enum-casing'
  | 'duplicate-list-values'
  | 'invalid-boolean-coercion'
  | 'singular-plural-mismatch'
  // Phase 5: Type coercion fixes
  | 'wrong-scalar-type'
  | 'invalid-date-format'
  // Phase 4: Structural integrity fixes
  | 'frontmatter-not-at-top'
  | 'duplicate-frontmatter-keys'
  | 'malformed-wikilink';

/**
 * A single audit issue.
 */
export interface AuditIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  field?: string | undefined;
  value?: unknown;
  expected?: string[] | string | undefined;
  suggestion?: string | undefined;
  autoFixable: boolean;
  /** For orphan-file issues: the expected type path inferred from directory location */
  inferredType?: string | undefined;
  /** For format-violation: the expected format */
  expectedFormat?: 'wikilink' | 'markdown' | undefined;
  /** For stale-reference: similar file names that exist */
  similarFiles?: string[] | undefined;
  /** For stale-reference: the target that couldn't be found */
  targetName?: string | undefined;
  /** For stale-reference: whether this is in body content vs frontmatter */
  inBody?: boolean | undefined;
  /** For stale-reference: the line number in the file (for body references) */
  lineNumber?: number | undefined;
  /** For owned-note-referenced: path to the owner note */
  ownerPath?: string | undefined;
  /** For owned-note-referenced: the note that was improperly referenced */
  ownedNotePath?: string | undefined;
  /** For invalid-source-type: the expected type(s) from field.source */
  expectedType?: string | undefined;
  /** For invalid-source-type: the actual type of the referenced note */
  actualType?: string | undefined;
  /** For parent-cycle: the cycle path showing the loop */
  cyclePath?: string[] | undefined;
  /** For wrong-directory: the current directory */
  currentDirectory?: string | undefined;
  /** For wrong-directory: the expected directory based on type */
  expectedDirectory?: string | undefined;
  /** For wrong-directory/owned-wrong-location: number of wikilinks that reference this file */
  wikilinkCount?: number | undefined;
  /** For key-casing/singular-plural: the canonical key name from schema */
  canonicalKey?: string | undefined;
  /** For enum-casing: the canonical enum value from schema */
  canonicalValue?: string | undefined;
  /** For singular-plural-mismatch: whether this key conflicts with existing key */
  hasConflict?: boolean | undefined;
  /** For singular-plural-mismatch with conflict: the value of the existing key */
  conflictValue?: unknown;
  // Phase 4: Structural integrity metadata
  /** For duplicate-frontmatter-keys: key name */
  duplicateKey?: string | undefined;
  /** For duplicate-frontmatter-keys: number of occurrences */
  duplicateCount?: number | undefined;
  /** For malformed-wikilink: array index when value is a list */
  listIndex?: number | undefined;
  /** For malformed-wikilink: deterministic fixed value */
  fixedValue?: string | undefined;
  /** For ambiguous-link-target: candidate paths */
  candidates?: string[] | undefined;
}

/**
 * Audit result for a single file.
 */
export interface FileAuditResult {
  path: string;
  relativePath: string;
  issues: AuditIssue[];
}

/**
 * Overall audit summary.
 */
export interface AuditSummary {
  filesChecked: number;
  filesWithErrors: number;
  filesWithWarnings: number;
  totalErrors: number;
  totalWarnings: number;
}

// ============================================================================
// Fix Types
// ============================================================================

/**
 * Fix result for a single issue.
 */
export type FixAction = 'fixed' | 'skipped' | 'failed';

export interface FixResult {
  file: string;
  issue: AuditIssue;
  action: FixAction;
  message?: string;
}

/**
 * Summary of fix operations.
 */
export interface FixSummary {
  /** When true, fixes are previewed (no writes). */
  dryRun: boolean;
  fixed: number;
  skipped: number;
  failed: number;
  remaining: number;
}

// ============================================================================
// Internal Types
// ============================================================================

// Re-export ManagedFile from discovery module (single source of truth)
export type { ManagedFile } from '../discovery.js';

/**
 * Audit command options.
 */
export interface AuditOptions {
  strict?: boolean;
  path?: string;
  only?: string;
  ignore?: string;
  output?: string;
  fix?: boolean;
  auto?: boolean;
  /** Preview fixes without writing. */
  dryRun?: boolean;
  /** Apply auto-fixes; required for audit --fix --auto to write changes. */
  execute?: boolean;
  all?: boolean;
  allowField?: string[];
}

/**
 * Options for running audit detection.
 */
export interface AuditRunOptions {
  typePath?: string | undefined;
  strict: boolean;
  pathFilter?: string | undefined;
  /** Where expressions for frontmatter filtering */
  whereExpressions?: string[] | undefined;
  /** Text query for body content filtering */
  textQuery?: string | undefined;
  onlyIssue?: IssueCode | undefined;
  ignoreIssue?: IssueCode | undefined;
  allowedFields?: Set<string> | undefined;
  /** Vault directory path for resolving wikilink references */
  vaultDir?: string | undefined;
  /** Schema for looking up field formats */
  schema?: LoadedSchema | undefined;
}

/**
 * Context passed to fix operations.
 */
export interface FixContext {
  schema: LoadedSchema;
  vaultDir: string;
  /** When true, fixes are previewed (no writes). */
  dryRun: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Native fields that are always allowed (Obsidian-specific).
 */
export const ALLOWED_NATIVE_FIELDS = new Set([
  'tags',
  'aliases',
  'cssclasses',
  'publish',
  'type',  // type discriminator
]);

/**
 * Check if a value is formatted as a wikilink.
 */
export function isWikilink(value: string): boolean {
  return /^\[\[.+\]\]$/.test(value);
}

/**
 * Check if a value is formatted as a quoted wikilink.
 */
export function isQuotedWikilink(value: string): boolean {
  return /^"\[\[.+\]\]"$/.test(value);
}

/**
 * Check if a value is formatted as a markdown link.
 * Matches: [Note Name](Note Name.md) or "[Note Name](Note Name.md)"
 */
export function isMarkdownLink(value: string): boolean {
  // Remove quotes if present
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  return /^\[.+\]\(.+\.md\)$/.test(v);
}

/**
 * Extract the target from a markdown link.
 * Returns the target without the .md extension.
 * Example: "[Note Name](Note Name.md)" → "Note Name"
 */
export function extractMarkdownLinkTarget(value: string): string | null {
  // Handle quoted markdown link
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  
  // Match [display](path.md) and extract the path without .md
  const match = v.match(/^\[.+\]\((.+)\.md\)$/);
  return match ? match[1]! : null;
}

/**
 * Extract the target from a wikilink.
 * Returns the target without brackets, heading, or alias.
 */
export function extractWikilinkTarget(value: string): string | null {
  // Handle quoted wikilink
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  
  const match = v.match(/^\[\[([^\]|#]+)/);
  return match ? match[1]! : null;
}


/**
 * Convert a value to wikilink format.
 * Extracts the note name from markdown links if needed.
 */
export function toWikilink(value: string): string {
  // If already a wikilink, return as-is
  if (isWikilink(value) || isQuotedWikilink(value)) {
    return value;
  }
  
  // Extract name from markdown link if present
  let name = value;
  if (isMarkdownLink(value)) {
    name = extractMarkdownLinkTarget(value) ?? value;
  }
  
  return `[[${name}]]`;
}

/**
 * Convert a value to markdown link format.
 * Extracts the note name from wikilinks if needed.
 */
export function toMarkdownLink(value: string): string {
  // If already a markdown link, return as-is
  if (isMarkdownLink(value)) {
    return value;
  }
  
  // Extract name from wikilink if present
  let name = value;
  if (isWikilink(value)) {
    name = extractWikilinkTarget(value) ?? value;
  } else if (isQuotedWikilink(value)) {
    name = extractWikilinkTarget(value.slice(1, -1)) ?? value;
  }
  
  // Convert to markdown link format
  return `[${name}](${name}.md)`;
}
