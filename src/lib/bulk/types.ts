/**
 * Type definitions for bulk operations.
 */

import type { LoadedSchema } from '../../types/schema.js';

/**
 * Types of bulk operations.
 */
export type OperationType = 'set' | 'clear' | 'rename' | 'delete' | 'append' | 'remove' | 'move';

/**
 * A single bulk operation to apply.
 */
export interface BulkOperation {
  type: OperationType;
  field: string;
  value?: unknown;        // For set, append, remove
  newField?: string;      // For rename
  targetPath?: string;    // For move
}

/**
 * A change to a single field.
 */
export interface FieldChange {
  operation: OperationType;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  newField?: string;      // For rename operations
}

/**
 * Changes to a single file.
 */
export interface FileChange {
  filePath: string;
  relativePath: string;
  changes: FieldChange[];
  applied: boolean;
  error?: string;
}

/**
 * Result of a bulk operation.
 */
export interface BulkResult {
  dryRun: boolean;
  totalFiles: number;
  affectedFiles: number;
  changes: FileChange[];
  backupPath?: string;
  errors: string[];
  /** For move operations: file move results */
  moveResults?: MoveFileResult[];
  /** For move operations: wikilink update results */
  wikilinkUpdates?: WikilinkUpdateInfo[];
  /** For move operations: total wikilinks updated */
  totalLinksUpdated?: number;
}

/**
 * Result of moving a single file.
 */
export interface MoveFileResult {
  oldPath: string;
  newPath: string;
  oldRelativePath: string;
  newRelativePath: string;
  applied: boolean;
  error?: string;
}

/**
 * Result of updating wikilinks in a file.
 */
export interface WikilinkUpdateInfo {
  filePath: string;
  relativePath: string;
  linksUpdated: number;
  applied: boolean;
  error?: string;
}

/**
 * Simple filter (--field=value syntax).
 */
export interface SimpleFilter {
  field: string;
  operator: 'eq' | 'neq';
  values: string[];
}

/**
 * Options for bulk execution.
 */
export interface BulkOptions {
  typePath?: string;
  pathGlob?: string;
  textQuery?: string;
  operations: BulkOperation[];
  whereExpressions: string[];
  simpleFilters: SimpleFilter[];
  execute: boolean;
  backup: boolean;
  limit?: number;
  verbose: boolean;
  quiet: boolean;
  jsonMode: boolean;
  vaultDir: string;
  schema: LoadedSchema;
  all?: boolean;
}

/**
 * Backup manifest structure.
 */
export interface BackupManifest {
  timestamp: string;
  operation: string;
  files: string[];
}

/**
 * Information about a backup.
 */
export interface BackupInfo {
  id: string;
  timestamp: Date;
  operation: string;
  fileCount: number;
  path: string;
}
