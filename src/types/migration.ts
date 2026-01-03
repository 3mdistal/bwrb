import { z } from 'zod';

// ============================================================================
// Migration Operations
// ============================================================================

/**
 * Field-level migration operations.
 */
export const FieldMigrationOpSchema = z.discriminatedUnion('op', [
  // Add a new field to a type
  z.object({
    op: z.literal('add-field'),
    targetType: z.string(),
    field: z.string(),
    default: z.unknown().optional(),
  }),
  // Remove a field from a type
  z.object({
    op: z.literal('remove-field'),
    targetType: z.string(),
    field: z.string(),
  }),
  // Rename a field on a type
  z.object({
    op: z.literal('rename-field'),
    targetType: z.string(),
    from: z.string(),
    to: z.string(),
  }),
]);

/**
 * Enum-level migration operations.
 */
export const EnumMigrationOpSchema = z.discriminatedUnion('op', [
  // Add a value to an enum
  z.object({
    op: z.literal('add-enum-value'),
    enum: z.string(),
    value: z.string(),
  }),
  // Remove a value from an enum
  z.object({
    op: z.literal('remove-enum-value'),
    enum: z.string(),
    value: z.string(),
    mapTo: z.string().optional(), // Value to map existing notes to
  }),
  // Rename an enum value
  z.object({
    op: z.literal('rename-enum-value'),
    enum: z.string(),
    from: z.string(),
    to: z.string(),
  }),
]);

/**
 * Type-level migration operations.
 */
export const TypeMigrationOpSchema = z.discriminatedUnion('op', [
  // Add a new type (no migration needed for notes, but tracked for history)
  z.object({
    op: z.literal('add-type'),
    typeName: z.string(),
  }),
  // Remove a type
  z.object({
    op: z.literal('remove-type'),
    typeName: z.string(),
  }),
  // Rename a type
  z.object({
    op: z.literal('rename-type'),
    from: z.string(),
    to: z.string(),
  }),
  // Change type's parent (re-parent)
  z.object({
    op: z.literal('reparent-type'),
    typeName: z.string(),
    from: z.string().optional(), // undefined = was root
    to: z.string().optional(), // undefined = becomes root
  }),
]);

/**
 * All migration operations.
 */
export const MigrationOpSchema = z.union([
  FieldMigrationOpSchema,
  EnumMigrationOpSchema,
  TypeMigrationOpSchema,
]);

export type FieldMigrationOp = z.infer<typeof FieldMigrationOpSchema>;
export type EnumMigrationOp = z.infer<typeof EnumMigrationOpSchema>;
export type TypeMigrationOp = z.infer<typeof TypeMigrationOpSchema>;
export type MigrationOp = z.infer<typeof MigrationOpSchema>;

// ============================================================================
// Migration Plan
// ============================================================================

/**
 * A migration plan describes what changes need to be applied.
 * Operations are categorized by whether they can be auto-applied.
 */
export interface MigrationPlan {
  /** Source schema version (or 'unversioned' if no schemaVersion) */
  fromVersion: string;
  /** Target schema version */
  toVersion: string;
  /** Operations that can be auto-applied without user input */
  deterministic: MigrationOp[];
  /** Operations that require user confirmation or input */
  nonDeterministic: MigrationOp[];
  /** Whether there are any changes to apply */
  hasChanges: boolean;
}

// ============================================================================
// Migration History
// ============================================================================

/**
 * Record of a single applied migration.
 */
export const AppliedMigrationSchema = z.object({
  /** Schema version after this migration */
  version: z.string(),
  /** When the migration was applied */
  appliedAt: z.string(), // ISO 8601
  /** Operations that were applied */
  operations: z.array(MigrationOpSchema),
  /** Number of notes affected */
  notesAffected: z.number(),
  /** Backup file path (if created) */
  backupPath: z.string().optional(),
});

export type AppliedMigration = z.infer<typeof AppliedMigrationSchema>;

/**
 * Migration history stored in .pika/migrations.json
 */
export const MigrationHistorySchema = z.object({
  /** List of applied migrations (oldest first) */
  applied: z.array(AppliedMigrationSchema),
});

export type MigrationHistory = z.infer<typeof MigrationHistorySchema>;

// ============================================================================
// Schema Snapshot
// ============================================================================

import { PikaSchema, type Schema } from './schema.js';

/**
 * Schema snapshot stored in .pika/schema.applied.json
 * This is the full schema content at the time of last migration.
 */
export const SchemaSnapshotSchema = z.object({
  /** Schema version at time of snapshot */
  schemaVersion: z.string(),
  /** When snapshot was taken */
  snapshotAt: z.string(), // ISO 8601
  /** Full schema content (for diff comparison) */
  schema: PikaSchema,
});

export interface SchemaSnapshot {
  schemaVersion: string;
  snapshotAt: string;
  schema: Schema;
}

// ============================================================================
// Migration Result
// ============================================================================

/**
 * A single change applied to a file during migration.
 */
export interface AppliedChange {
  kind: 'set' | 'delete' | 'rename';
  field: string;
  oldValue: unknown;
  newValue: unknown;
  newField?: string; // For rename operations
}

/**
 * Result of migrating a single file.
 */
export interface FileMigrationResult {
  filePath: string;
  relativePath: string;
  changes: AppliedChange[];
  applied: boolean;
  error?: string;
}

/**
 * Result of executing a migration.
 */
export interface MigrationResult {
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Source schema version */
  fromVersion: string;
  /** Target schema version */
  toVersion: string;
  /** Total files scanned */
  totalFiles: number;
  /** Files that had changes */
  affectedFiles: number;
  /** Per-file results */
  fileResults: FileMigrationResult[];
  /** Any errors encountered */
  errors: string[];
  /** Backup path if created */
  backupPath?: string;
}

// ============================================================================
// Change Detection Types
// ============================================================================

/**
 * Detected change between two schemas.
 * Used internally by the diff engine before classification.
 */
export type DetectedChange =
  | { kind: 'field-added'; type: string; field: string; hasDefault: boolean }
  | { kind: 'field-removed'; type: string; field: string }
  | { kind: 'field-changed'; type: string; field: string; changes: string[] }
  | { kind: 'enum-value-added'; enum: string; value: string }
  | { kind: 'enum-value-removed'; enum: string; value: string }
  | { kind: 'enum-added'; enum: string; values: string[] }
  | { kind: 'enum-removed'; enum: string }
  | { kind: 'type-added'; type: string }
  | { kind: 'type-removed'; type: string }
  | { kind: 'type-reparented'; type: string; from?: string; to?: string };
