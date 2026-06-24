/**
 * Schema diff engine.
 * Compares two schemas and generates a migration plan.
 */

import { Schema, Field, getOptionValues } from '../../types/schema.js';
import {
  MigrationPlan,
  MigrationOp,
  DetectedChange,
} from '../../types/migration.js';

/**
 * Compare two schemas and generate a migration plan.
 * 
 * @param oldSchema - The previously applied schema (or undefined for first migration)
 * @param newSchema - The current schema to migrate to
 * @param fromVersion - Version string for the old schema
 * @param toVersion - Version string for the new schema
 */
export function diffSchemas(
  oldSchema: Schema | undefined,
  newSchema: Schema,
  fromVersion: string,
  toVersion: string
): MigrationPlan {
  const changes = detectChanges(oldSchema, newSchema);
  const { deterministic, nonDeterministic } = classifyChanges(changes, newSchema);
  
  // Check for config.linkFormat changes
  const configOps = detectConfigChanges(oldSchema, newSchema);
  deterministic.push(...configOps);
  
  return {
    fromVersion,
    toVersion,
    deterministic,
    nonDeterministic,
    hasChanges: deterministic.length > 0 || nonDeterministic.length > 0,
  };
}

/**
 * Detect config-level changes that require migration.
 */
function detectConfigChanges(
  oldSchema: Schema | undefined,
  newSchema: Schema
): MigrationOp[] {
  const ops: MigrationOp[] = [];
  
  if (!oldSchema) {
    return ops; // No config changes if no old schema
  }
  
  // Check link_format change
  const oldLinkFormat = oldSchema.config?.link_format ?? 'wikilink';
  const newLinkFormat = newSchema.config?.link_format ?? 'wikilink';
  
  if (oldLinkFormat !== newLinkFormat) {
    ops.push({
      op: 'normalize-links',
      fromFormat: oldLinkFormat,
      toFormat: newLinkFormat,
    });
  }
  
  return ops;
}

/**
 * Detect all changes between two schemas.
 */
function detectChanges(oldSchema: Schema | undefined, newSchema: Schema): DetectedChange[] {
  const changes: DetectedChange[] = [];
  
  // If no old schema, everything in new schema is "added" but no migration needed
  if (!oldSchema) {
    return [];
  }
  
  // Note: Global enums have been removed in favor of inline options on fields.
  // Options changes are detected as part of field changes.
  
  // Compare types
  changes.push(...detectTypeChanges(oldSchema.types ?? {}, newSchema.types ?? {}));
  
  return changes;
}



/**
 * Detect changes in type definitions.
 */
function detectTypeChanges(
  oldTypes: Record<string, unknown>,
  newTypes: Record<string, unknown>
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const oldNames = new Set(Object.keys(oldTypes));
  const newNames = new Set(Object.keys(newTypes));
  
  // Added types
  for (const name of newNames) {
    if (!oldNames.has(name)) {
      changes.push({ kind: 'type-added', type: name });
    }
  }
  
  // Removed types
  for (const name of oldNames) {
    if (!newNames.has(name)) {
      changes.push({ kind: 'type-removed', type: name });
    }
  }
  
  // Changed types
  for (const name of oldNames) {
    if (newNames.has(name)) {
      const oldType = oldTypes[name] as { extends?: string; fields?: Record<string, Field> };
      const newType = newTypes[name] as { extends?: string; fields?: Record<string, Field> };
      
      // Check parent change
      if (oldType.extends !== newType.extends) {
        const reparentChange: DetectedChange = {
          kind: 'type-reparented',
          type: name,
        };
        if (oldType.extends !== undefined) {
          reparentChange.from = oldType.extends;
        }
        if (newType.extends !== undefined) {
          reparentChange.to = newType.extends;
        }
        changes.push(reparentChange);
      }
      
      // Check field changes
      changes.push(...detectFieldChanges(
        name,
        oldType.fields ?? {},
        newType.fields ?? {}
      ));
    }
  }
  
  return changes;
}

/**
 * Detect changes in field definitions for a type.
 */
function detectFieldChanges(
  typeName: string,
  oldFields: Record<string, Field>,
  newFields: Record<string, Field>
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  const oldNames = new Set(Object.keys(oldFields));
  const newNames = new Set(Object.keys(newFields));
  
  // Added fields
  for (const name of newNames) {
    if (!oldNames.has(name)) {
      const field = newFields[name];
      const hasDefault = field !== undefined && (field.default !== undefined || field.value !== undefined);
      changes.push({ kind: 'field-added', type: typeName, field: name, hasDefault });
    }
  }
  
  // Removed fields
  for (const name of oldNames) {
    if (!newNames.has(name)) {
      changes.push({ kind: 'field-removed', type: typeName, field: name });
    }
  }
  
  // Changed fields (detect significant changes)
  for (const name of oldNames) {
    if (newNames.has(name)) {
      const oldField = oldFields[name];
      const newField = newFields[name];
      if (oldField !== undefined && newField !== undefined) {
        const fieldChanges = detectFieldPropertyChanges(oldField, newField);
        if (fieldChanges.length > 0) {
          changes.push({ kind: 'field-changed', type: typeName, field: name, changes: fieldChanges });
        }
      }
    }
  }
  
  return changes;
}

/**
 * Detect property changes within a field definition.
 * Returns list of changed property names.
 */
function detectFieldPropertyChanges(oldField: Field, newField: Field): string[] {
  const changes: string[] = [];

  // Compare option *values* only. Per-option descriptions are cosmetic metadata
  // (they document what a value means, not what values are allowed), so adding
  // or editing a description must not register as a migration-relevant change.
  if (
    JSON.stringify(getOptionValues(oldField.options)) !==
    JSON.stringify(getOptionValues(newField.options))
  ) {
    changes.push('options');
  }

  // Other properties that matter for migration. Note: `description` and `label`
  // are intentionally excluded — they are documentation, never data shape.
  const props: (keyof Field)[] = ['source', 'required', 'multiple'];

  for (const prop of props) {
    if (JSON.stringify(oldField[prop]) !== JSON.stringify(newField[prop])) {
      changes.push(prop);
    }
  }

  return changes;
}

/**
 * Classify detected changes into deterministic and non-deterministic operations.
 */
function classifyChanges(
  changes: DetectedChange[],
  newSchema: Schema
): { deterministic: MigrationOp[]; nonDeterministic: MigrationOp[] } {
  const deterministic: MigrationOp[] = [];
  const nonDeterministic: MigrationOp[] = [];
  
  for (const change of changes) {
    switch (change.kind) {
      // Field operations
      case 'field-added': {
        // Adding a field is always deterministic - old notes just won't have it
        // If there's a default, we include it for potential backfill
        const field = newSchema.types[change.type]?.fields?.[change.field];
        const defaultValue = field?.default ?? field?.value;
        deterministic.push({
          op: 'add-field',
          targetType: change.type,
          field: change.field,
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        });
        break;
      }
        
      case 'field-removed':
        // Removing data is always non-deterministic
        nonDeterministic.push({
          op: 'remove-field',
          targetType: change.type,
          field: change.field,
        });
        break;
        
      case 'field-changed':
        // Field property changes might need migration
        // For now, treat as informational (no note changes needed)
        // Future: handle options changes, format changes, etc.
        break;
        
      // Type operations
      case 'type-added':
        // No migration needed - just a new type
        deterministic.push({
          op: 'add-type',
          typeName: change.type,
        });
        break;
        
      case 'type-removed':
        // Existing notes of this type become orphaned
        nonDeterministic.push({
          op: 'remove-type',
          typeName: change.type,
        });
        break;
        
      case 'type-reparented':
        // May affect inherited fields
        nonDeterministic.push({
          op: 'reparent-type',
          typeName: change.type,
          from: change.from,
          to: change.to,
        });
        break;
    }
  }
  
  return { deterministic, nonDeterministic };
}

/**
 * Suggest a version bump based on the migration plan.
 * - Major: breaking changes (removals, renames)
 * - Minor: additions
 * - Patch: no changes (shouldn't happen in migration context)
 */
export function suggestVersionBump(
  currentVersion: string,
  plan: MigrationPlan
): string {
  const [major, minor, _patch] = parseVersion(currentVersion);
  
  if (plan.nonDeterministic.length > 0) {
    // Breaking changes = major bump
    return `${major + 1}.0.0`;
  } else if (plan.deterministic.length > 0) {
    // Additions only = minor bump
    return `${major}.${minor + 1}.0`;
  } else {
    // No changes = keep current version
    return currentVersion;
  }
}

/**
 * Parse a semver string into components.
 */
function parseVersion(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [1, 0, 0]; // Default to 1.0.0 if unparseable
  }
  return [
    parseInt(match[1] ?? '1', 10),
    parseInt(match[2] ?? '0', 10),
    parseInt(match[3] ?? '0', 10),
  ];
}

/**
 * Format a migration plan for display in the terminal.
 */
export function formatDiffForDisplay(plan: MigrationPlan): string {
  const lines: string[] = [];
  
  if (plan.deterministic.length > 0) {
    lines.push('Deterministic changes (will be auto-applied):');
    for (const op of plan.deterministic) {
      lines.push(`  ${formatOpForDisplay(op)}`);
    }
  }
  
  if (plan.nonDeterministic.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Non-deterministic changes (require confirmation):');
    for (const op of plan.nonDeterministic) {
      lines.push(`  ${formatOpForDisplay(op)}`);
    }
  }
  
  if (lines.length === 0) {
    return 'No changes detected.';
  }
  
  return lines.join('\n');
}

/**
 * Format a single operation for display.
 */
function formatOpForDisplay(op: MigrationOp): string {
  switch (op.op) {
    case 'add-field':
      return `+ Add field "${op.field}" to type "${op.targetType}"${op.default !== undefined ? ` (default: ${JSON.stringify(op.default)})` : ''}`;
    case 'remove-field':
      return `- Remove field "${op.field}" from type "${op.targetType}"`;
    case 'rename-field':
      return `~ Rename field "${op.from}" to "${op.to}" on type "${op.targetType}"`;
    case 'add-type':
      return `+ Add type "${op.typeName}"`;
    case 'remove-type':
      return `- Remove type "${op.typeName}"`;
    case 'rename-type':
      return `~ Rename type "${op.from}" to "${op.to}"`;
    case 'reparent-type':
      return `~ Change parent of type "${op.typeName}" from "${op.from ?? 'none'}" to "${op.to ?? 'none'}"`;
    case 'normalize-links':
      return `~ Normalize all links from "${op.fromFormat}" to "${op.toFormat}" format`;
  }
}

/**
 * Format a migration plan for JSON output.
 */
export function formatDiffForJson(plan: MigrationPlan): Record<string, unknown> {
  return {
    hasChanges: plan.hasChanges,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    deterministic: plan.deterministic,
    nonDeterministic: plan.nonDeterministic,
    summary: {
      deterministicCount: plan.deterministic.length,
      nonDeterministicCount: plan.nonDeterministic.length,
    },
  };
}
