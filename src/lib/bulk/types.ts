/**
 * Type definitions for bulk operations.
 */

import type { Schema } from '../../types/schema.js';

/**
 * Types of bulk operations.
 */
export type OperationType = 'set' | 'clear' | 'rename' | 'delete' | 'append' | 'remove';

/**
 * A single bulk operation to apply.
 */
export interface BulkOperation {
  type: OperationType;
  field: string;
  value?: unknown;        // For set, append, remove
  newField?: string;      // For rename
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
  typePath: string;
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
  schema: Schema;
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
