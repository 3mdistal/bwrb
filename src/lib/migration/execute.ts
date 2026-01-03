/**
 * Migration execution - applies schema changes to vault notes.
 */

import { parseNote, writeNote } from '../frontmatter.js';
import { discoverManagedFiles } from '../discovery.js';
import { createBackup } from '../bulk/backup.js';
import type { LoadedSchema } from '../../types/schema.js';
import type {
  MigrationPlan,
  MigrationOp,
  MigrationResult,
  FileMigrationResult,
  AppliedChange,
} from '../../types/migration.js';

export interface ExecuteMigrationOptions {
  vaultDir: string;
  schema: LoadedSchema;
  plan: MigrationPlan;
  execute: boolean;
  backup: boolean;
  /** Value mappings for non-deterministic changes (e.g., old enum value -> new value) */
  valueMappings?: Map<string, unknown>;
}

/**
 * Execute a migration plan against the vault.
 */
export async function executeMigration(
  options: ExecuteMigrationOptions
): Promise<MigrationResult> {
  const { vaultDir, schema, plan, execute, backup, valueMappings } = options;

  const result: MigrationResult = {
    dryRun: !execute,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    totalFiles: 0,
    affectedFiles: 0,
    fileResults: [],
    errors: [],
  };

  // If no operations, nothing to do
  const allOps = [...plan.deterministic, ...plan.nonDeterministic];
  if (allOps.length === 0) {
    return result;
  }

  // Group operations by type for efficient processing
  const opsByType = groupOperationsByType(allOps);

  // Discover all files that might need migration
  const allFiles = await discoverManagedFiles(schema, vaultDir);
  result.totalFiles = allFiles.length;

  // Collect files that need changes
  const filesToMigrate: Array<{
    path: string;
    relativePath: string;
    frontmatter: Record<string, unknown>;
    body: string;
    changes: AppliedChange[];
  }> = [];

  for (const file of allFiles) {
    try {
      const { frontmatter, body } = await parseNote(file.path);
      const typeName = file.expectedType ?? '';

      // Calculate what changes this file needs
      const changes = calculateFileChanges(
        frontmatter,
        typeName,
        opsByType,
        valueMappings
      );

      if (changes.length > 0) {
        filesToMigrate.push({
          path: file.path,
          relativePath: file.relativePath,
          frontmatter,
          body,
          changes,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to parse ${file.relativePath}: ${message}`);
    }
  }

  // Create backup if requested and executing
  if (execute && backup && filesToMigrate.length > 0) {
    result.backupPath = await createBackup(
      vaultDir,
      filesToMigrate.map(f => f.path),
      `schema migration ${plan.fromVersion} → ${plan.toVersion}`
    );
  }

  // Apply changes to each file
  for (const file of filesToMigrate) {
    const fileResult: FileMigrationResult = {
      filePath: file.path,
      relativePath: file.relativePath,
      changes: file.changes,
      applied: false,
    };

    try {
      if (execute) {
        // Apply changes to frontmatter
        const modified = applyChangesToFrontmatter(
          { ...file.frontmatter },
          file.changes
        );
        await writeNote(file.path, modified, file.body);
        fileResult.applied = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fileResult.error = message;
      result.errors.push(`Failed to migrate ${file.relativePath}: ${message}`);
    }

    result.fileResults.push(fileResult);
  }

  result.affectedFiles = result.fileResults.filter(r => r.changes.length > 0).length;

  return result;
}

/**
 * Group migration operations by the type they affect.
 */
function groupOperationsByType(
  ops: MigrationOp[]
): Map<string | null, MigrationOp[]> {
  const grouped = new Map<string | null, MigrationOp[]>();

  for (const op of ops) {
    // Get the type this operation affects (null for enum ops that affect all types)
    const targetType = getOperationTargetType(op);

    if (!grouped.has(targetType)) {
      grouped.set(targetType, []);
    }
    grouped.get(targetType)!.push(op);
  }

  return grouped;
}

/**
 * Get the type that an operation targets, or null for global operations.
 */
function getOperationTargetType(op: MigrationOp): string | null {
  switch (op.op) {
    case 'add-field':
    case 'remove-field':
    case 'rename-field':
      return op.targetType;
    case 'add-enum-value':
    case 'remove-enum-value':
    case 'rename-enum-value':
      // Enum changes can affect any type that uses the enum
      return null;
    case 'add-type':
    case 'remove-type':
    case 'rename-type':
    case 'reparent-type':
      // Type structural changes don't affect existing note frontmatter directly
      return null;
    default:
      return null;
  }
}

/**
 * Calculate what changes a specific file needs based on its type and the operations.
 */
function calculateFileChanges(
  frontmatter: Record<string, unknown>,
  typeName: string,
  opsByType: Map<string | null, MigrationOp[]>,
  valueMappings?: Map<string, unknown>
): AppliedChange[] {
  const changes: AppliedChange[] = [];

  // Get operations that affect this specific type
  const typeOps = opsByType.get(typeName) || [];
  // Get global operations (enum changes)
  const globalOps = opsByType.get(null) || [];

  const allOps = [...typeOps, ...globalOps];

  for (const op of allOps) {
    const change = calculateSingleChange(frontmatter, op, valueMappings);
    if (change) {
      changes.push(change);
    }
  }

  return changes;
}

/**
 * Calculate the change for a single operation on a file.
 */
function calculateSingleChange(
  frontmatter: Record<string, unknown>,
  op: MigrationOp,
  valueMappings?: Map<string, unknown>
): AppliedChange | null {
  switch (op.op) {
    case 'add-field': {
      // Only add if field doesn't exist and has a default
      if (!(op.field in frontmatter) && op.default !== undefined) {
        return {
          kind: 'set',
          field: op.field,
          oldValue: undefined,
          newValue: op.default,
        };
      }
      return null;
    }

    case 'remove-field': {
      // Remove field if it exists
      if (op.field in frontmatter) {
        return {
          kind: 'delete',
          field: op.field,
          oldValue: frontmatter[op.field],
          newValue: undefined,
        };
      }
      return null;
    }

    case 'rename-field': {
      // Rename field if old name exists and new name doesn't
      if (op.from in frontmatter && !(op.to in frontmatter)) {
        return {
          kind: 'rename',
          field: op.from,
          newField: op.to,
          oldValue: frontmatter[op.from],
          newValue: frontmatter[op.from],
        };
      }
      return null;
    }

    case 'remove-enum-value': {
      // Check if any field has this enum value
      // We need value mapping to know what to change it to
      const mappingKey = `enum:${op.enum}:${op.value}`;
      const newValue = valueMappings?.get(mappingKey);
      
      // Also check if the op has a mapTo field
      const targetValue = newValue ?? op.mapTo;
      if (targetValue === undefined) {
        // No mapping provided, skip
        return null;
      }

      // Find fields with this value
      for (const [field, value] of Object.entries(frontmatter)) {
        if (value === op.value) {
          return {
            kind: 'set',
            field,
            oldValue: value,
            newValue: targetValue,
          };
        }
        // Handle array fields
        if (Array.isArray(value) && value.includes(op.value)) {
          const newArray = value.map(v => (v === op.value ? targetValue : v));
          return {
            kind: 'set',
            field,
            oldValue: value,
            newValue: newArray,
          };
        }
      }
      return null;
    }

    case 'rename-enum-value': {
      // Find fields with the old enum value and update them
      for (const [field, value] of Object.entries(frontmatter)) {
        if (value === op.from) {
          return {
            kind: 'set',
            field,
            oldValue: value,
            newValue: op.to,
          };
        }
        // Handle array fields
        if (Array.isArray(value) && value.includes(op.from)) {
          const newArray = value.map(v => (v === op.from ? op.to : v));
          return {
            kind: 'set',
            field,
            oldValue: value,
            newValue: newArray,
          };
        }
      }
      return null;
    }

    // These operations don't directly affect frontmatter values
    case 'add-enum-value':
    case 'add-type':
    case 'remove-type':
    case 'rename-type':
    case 'reparent-type':
      return null;

    default:
      return null;
  }
}

/**
 * Apply calculated changes to frontmatter.
 */
function applyChangesToFrontmatter(
  frontmatter: Record<string, unknown>,
  changes: AppliedChange[]
): Record<string, unknown> {
  for (const change of changes) {
    switch (change.kind) {
      case 'set':
        frontmatter[change.field] = change.newValue;
        break;
      case 'delete':
        delete frontmatter[change.field];
        break;
      case 'rename':
        if (change.newField) {
          delete frontmatter[change.field];
          frontmatter[change.newField] = change.newValue;
        }
        break;
    }
  }

  return frontmatter;
}

/**
 * Format a migration result for display.
 */
export function formatMigrationResult(result: MigrationResult): string {
  const lines: string[] = [];

  if (result.dryRun) {
    lines.push('Dry run - no changes applied\n');
  }

  lines.push(`Migration: ${result.fromVersion} → ${result.toVersion}`);
  lines.push(`Files scanned: ${result.totalFiles}`);
  lines.push(`Files affected: ${result.affectedFiles}`);

  if (result.backupPath) {
    lines.push(`Backup created: ${result.backupPath}`);
  }

  if (result.fileResults.length > 0) {
    lines.push('\nChanges:');
    for (const file of result.fileResults) {
      if (file.changes.length === 0) continue;

      lines.push(`  ${file.relativePath}:`);
      for (const change of file.changes) {
        lines.push(`    ${formatAppliedChange(change)}`);
      }
      if (file.error) {
        lines.push(`    ERROR: ${file.error}`);
      }
    }
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  ${error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a single applied change for display.
 */
function formatAppliedChange(change: AppliedChange): string {
  const formatValue = (v: unknown): string => {
    if (v === undefined) return '(empty)';
    if (Array.isArray(v)) return `[${v.join(', ')}]`;
    return String(v);
  };

  switch (change.kind) {
    case 'set':
      return `${change.field}: ${formatValue(change.oldValue)} → ${formatValue(change.newValue)}`;
    case 'delete':
      return `${change.field}: ${formatValue(change.oldValue)} → (removed)`;
    case 'rename':
      return `${change.field} → ${change.newField}: ${formatValue(change.oldValue)}`;
    default:
      return `${change.field}: unknown change`;
  }
}
