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
  const { deterministic, nonDeterministic } = classifyChanges(changes, oldSchema, newSchema);

  // Check for config.linkFormat changes
  const configOps = detectConfigChanges(oldSchema, newSchema);
  deterministic.push(...configOps);

  // `schemaChanged` tracks migration-relevant *shape* differences vs the
  // snapshot, including ones that emit no op (e.g. a select option was added).
  // `detectChanges`/`detectConfigChanges` already exclude cosmetic edits
  // (descriptions, labels, key reordering), so this stays quiet for those.
  const schemaChanged = changes.length > 0 || configOps.length > 0;

  return {
    fromVersion,
    toVersion,
    deterministic,
    nonDeterministic,
    hasChanges: deterministic.length > 0 || nonDeterministic.length > 0,
    schemaChanged,
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
  oldSchema: Schema | undefined,
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
        
      case 'field-changed': {
        // An existing field's definition changed. Different property changes
        // imply different migration actions; classify each by whether existing
        // note values can still satisfy the new definition.
        const oldField = oldSchema?.types?.[change.type]?.fields?.[change.field];
        const newField = newSchema.types[change.type]?.fields?.[change.field];
        classifyFieldChange(change, oldField, newField, deterministic, nonDeterministic);
        break;
      }
        
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
 * Classify a single `field-changed` detection into migration ops.
 *
 * Each property change is mapped to the safest action that keeps existing notes
 * consistent with the new field definition:
 *
 * - `options` narrowed (values removed) while the field stays a constrained
 *   select (a non-empty allowed set remains): existing notes may hold a value
 *   that is no longer allowed → `clear-invalid-options` (non-deterministic, lossy
 *   cleanup). Options *added* keep every existing value valid → no op.
 * - `options` removed *entirely* (the allowed set becomes empty, i.e. the field
 *   is no longer a constrained select): every existing value is valid for the
 *   now-unconstrained field, so clearing would be data loss → `review-field`
 *   (non-deterministic, no note mutation).
 * - `multiple` false → true: a scalar value is still valid as a single-element
 *   array → `widen-field-to-multiple` (deterministic, lossless wrap).
 * - `multiple` true → false, `required` toggled on, or `source` retargeted:
 *   existing values may now be invalid but there is no safe deterministic fix →
 *   `review-field` (non-deterministic, no note mutation, surfaced for the user).
 */
function classifyFieldChange(
  change: Extract<DetectedChange, { kind: 'field-changed' }>,
  oldField: Field | undefined,
  newField: Field | undefined,
  deterministic: MigrationOp[],
  nonDeterministic: MigrationOp[]
): void {
  const { type: targetType, field, changes: changedProps } = change;

  if (changedProps.includes('options')) {
    const oldValues = getOptionValues(oldField?.options);
    const newValues = new Set(getOptionValues(newField?.options));
    const removed = oldValues.filter((value) => !newValues.has(value));
    // Only a *narrowing* (removed allowed values) can orphan existing data.
    // Pure additions leave every existing value valid, so they need no op.
    if (removed.length > 0) {
      if (newValues.size > 0) {
        // The field is still a constrained select with a smaller allowed set.
        // Existing values outside that set are now invalid → lossy cleanup.
        nonDeterministic.push({
          op: 'clear-invalid-options',
          targetType,
          field,
          allowedValues: [...newValues],
        });
      } else {
        // Options were removed *entirely*: the field no longer constrains its
        // values (it has become free-text / unconstrained). Every existing value
        // is still valid for the new definition, so clearing them would be silent
        // data loss. Surface the change for review instead of mutating notes.
        nonDeterministic.push({
          op: 'review-field',
          targetType,
          field,
          reason:
            'field is no longer a constrained select (all options removed); existing values are kept as free text',
        });
      }
    }
  }

  if (changedProps.includes('multiple')) {
    if (newField?.multiple === true && oldField?.multiple !== true) {
      // Widening to multiple: existing scalar values wrap losslessly.
      deterministic.push({ op: 'widen-field-to-multiple', targetType, field });
    } else {
      // Narrowing to single: collapsing an array is lossy and ambiguous.
      nonDeterministic.push({
        op: 'review-field',
        targetType,
        field,
        reason: 'field no longer accepts multiple values; existing arrays need manual review',
      });
    }
  }

  if (changedProps.includes('required') && newField?.required === true && oldField?.required !== true) {
    // Field became required: notes missing the value now violate the schema,
    // but we cannot fabricate a value, so surface it for review.
    nonDeterministic.push({
      op: 'review-field',
      targetType,
      field,
      reason: 'field is now required; notes missing a value need manual review',
    });
  }

  if (changedProps.includes('source')) {
    // Relation source retargeted: existing links may point at the wrong type.
    nonDeterministic.push({
      op: 'review-field',
      targetType,
      field,
      reason: 'relation source changed; existing links may need manual review',
    });
  }
}

/**
 * Suggest a version bump based on the migration plan.
 *
 * This is the single source of truth for migration version-bump suggestions
 * (the `schema migrate` command reuses it rather than reimplementing the rule).
 *
 * - Major: any non-deterministic op is present (removals, value re-validation,
 *   invalid-option cleanup) — these are potentially breaking for existing notes.
 * - Minor: only deterministic ops (additions, lossless widenings).
 * - No bump: no changes (kept current; `schema migrate` guards this path).
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
    case 'clear-invalid-options':
      return `! Clear invalid values of field "${op.field}" on type "${op.targetType}" (allowed: ${op.allowedValues.map((v) => JSON.stringify(v)).join(', ')})`;
    case 'widen-field-to-multiple':
      return `~ Widen field "${op.field}" on type "${op.targetType}" to allow multiple values`;
    case 'review-field':
      return `! Review field "${op.field}" on type "${op.targetType}": ${op.reason}`;
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
