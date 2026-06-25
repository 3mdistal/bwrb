/**
 * Schema diff engine.
 * Compares two schemas and generates a migration plan.
 */

import { Schema, Field, getOptionValues } from '../../types/schema.js';
import { resolveSchema, getConcreteTypeNames } from '../schema.js';
import type { LoadedSchema } from '../../types/schema.js';
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
  // Resolve both schemas up front. Field-changed detection reasons about the
  // EFFECTIVE (inheritance-resolved) field definition per concrete type rather
  // than raw per-type entries, because that is the structure existing notes were
  // actually written against (see detectEffectiveFieldChanges).
  const resolvedNew = resolveSchema(newSchema);
  const resolvedOld = oldSchema ? resolveSchema(oldSchema) : undefined;

  const changes = detectChanges(oldSchema, newSchema, resolvedOld, resolvedNew);
  const { deterministic, nonDeterministic } = classifyChanges(
    changes,
    resolvedOld,
    resolvedNew
  );

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
function detectChanges(
  oldSchema: Schema | undefined,
  newSchema: Schema,
  resolvedOld: LoadedSchema | undefined,
  resolvedNew: LoadedSchema
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  // If no old schema, everything in new schema is "added" but no migration needed
  if (!oldSchema || !resolvedOld) {
    return [];
  }

  // Note: Global enums have been removed in favor of inline options on fields.
  // Options changes are detected as part of field changes.

  // Compare types (added/removed/reparented + raw field add/remove).
  changes.push(...detectTypeChanges(oldSchema.types ?? {}, newSchema.types ?? {}));

  // Field-*changed* detection is computed from the EFFECTIVE resolved schemas,
  // not raw per-type entries (see detectEffectiveFieldChanges for why).
  changes.push(...detectEffectiveFieldChanges(resolvedOld, resolvedNew));

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
 * Detect raw field add/remove for a type.
 *
 * Only structural presence (a field appearing or disappearing in the type's RAW
 * definition) is detected here. Field *content* changes are intentionally NOT
 * detected from raw entries — those are derived from the EFFECTIVE resolved
 * schema instead (see detectEffectiveFieldChanges), because a raw structural
 * override on a child is silently dropped by the resolver's restricted merge and
 * raw ≠ effective for inherited fields.
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

  return changes;
}

/**
 * Detect field-changed migrations from the EFFECTIVE resolved schemas.
 *
 * The schema resolver applies a RESTRICTED merge for inherited fields: when a
 * child type re-declares a field it inherits, only metadata (`default`/`value`/
 * `description`/`granularity`) merges onto the parent's definition — the child's
 * raw STRUCTURAL keys (`options`/`multiple`/`required`/`source`) are IGNORED and
 * the parent's structure wins (see computeEffectiveFields in src/lib/schema.ts).
 *
 * Because notes are written against the EFFECTIVE schema, field-changed ops must
 * be derived by comparing each concrete type's effective field definition old →
 * new, NOT its raw entry. Doing so is correct in both directions:
 *
 *   - A child that raw-overrides `options` on an INHERITED field changes nothing
 *     effectively (the resolver drops the override). Its effective field is
 *     unchanged old → new, so NO op is emitted — its valid note values survive
 *     (fixes the data-loss defect, #728 P1).
 *   - A parent field change flows into every concrete descendant that inherits it
 *     (including metadata-only-override children and children whose raw
 *     same-name structural override the resolver ignores). Each such descendant's
 *     effective field changes, so it receives its own op and its notes are
 *     cleaned under its exact type (fixes the missed-cleanup defect, #728 P2).
 *
 * One detection is emitted per CONCRETE type, because `executeMigration` matches
 * ops to notes by the note's exact `expectedType`. The OLD effective definition
 * is used as the baseline for the per-aspect classification (it describes the
 * allowed value set the existing notes were written against).
 */
function detectEffectiveFieldChanges(
  resolvedOld: LoadedSchema,
  resolvedNew: LoadedSchema
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  // Only types present (concretely) in BOTH schemas can have a field *changed*:
  // a type that is new or removed is handled by the type-added/-removed path,
  // and its fields are not "changed" relative to an existing snapshot.
  const newConcrete = new Set(getConcreteTypeNames(resolvedNew));

  for (const typeName of getConcreteTypeNames(resolvedOld)) {
    if (!newConcrete.has(typeName)) continue;

    const oldType = resolvedOld.types.get(typeName);
    const newType = resolvedNew.types.get(typeName);
    if (!oldType || !newType) continue;

    const oldFields = oldType.fields;
    const newFields = newType.fields;

    // Compare every field the type effectively had before AND still has. A field
    // that only appears in one of the two effective sets is an add/remove, not a
    // change (and the add/remove path handles the declaring type already).
    for (const [fieldName, oldField] of Object.entries(oldFields)) {
      const newField = newFields[fieldName];
      if (newField === undefined) continue;

      const fieldChanges = detectFieldPropertyChanges(oldField, newField);
      if (fieldChanges.length > 0) {
        changes.push({
          kind: 'field-changed',
          type: typeName,
          field: fieldName,
          changes: fieldChanges,
        });
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
  resolvedOld: LoadedSchema | undefined,
  resolvedNew: LoadedSchema
): { deterministic: MigrationOp[]; nonDeterministic: MigrationOp[] } {
  const deterministic: MigrationOp[] = [];
  const nonDeterministic: MigrationOp[] = [];

  for (const change of changes) {
    switch (change.kind) {
      // Field operations
      case 'field-added': {
        // Adding a field is always deterministic - old notes just won't have it
        // If there's a default, we include it for potential backfill
        const field = resolvedNew.raw.types[change.type]?.fields?.[change.field];
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
        // `change.type` is a CONCRETE type and the field definitions compared are
        // its EFFECTIVE (resolved) ones — exactly what its notes were written
        // against. detectEffectiveFieldChanges already emits one detection per
        // concrete type that has the field, so classification just maps this
        // single type's effective old → new field to the safest op.
        const oldField = resolvedOld?.types.get(change.type)?.fields[change.field];
        const newField = resolvedNew.types.get(change.type)?.fields[change.field];
        classifyFieldChange(
          change,
          oldField,
          newField,
          deterministic,
          nonDeterministic
        );
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
 * The detection is already scoped to ONE concrete type (`change.type`) and the
 * `oldField`/`newField` are that type's EFFECTIVE (resolved) definitions, so this
 * function emits at most one op for that single `targetType`. The descendant
 * fan-out is handled upstream by emitting a separate detection per concrete type
 * whose effective field changed (see detectEffectiveFieldChanges), which is both
 * simpler than and strictly more correct than the previous raw override-exclusion
 * heuristic.
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
    // Normalize `multiple`: an absent/`undefined` value means single-valued,
    // exactly like an explicit `false`. Without this, merely ADDING (or removing)
    // an explicit `multiple: false` — a pure no-op for data shape — was treated
    // as a narrowing and wrongly emitted a `review-field` + suggested a MAJOR
    // bump (#728 / Codex defect B).
    const oldMultiple = oldField?.multiple === true;
    const newMultiple = newField?.multiple === true;

    if (newMultiple && !oldMultiple) {
      // Widening to multiple: existing scalar values wrap losslessly.
      deterministic.push({
        op: 'widen-field-to-multiple',
        targetType,
        field,
      });
    } else if (!newMultiple && oldMultiple) {
      // Narrowing to single: collapsing an array is lossy and ambiguous.
      nonDeterministic.push({
        op: 'review-field',
        targetType,
        field,
        reason: 'field no longer accepts multiple values; existing arrays need manual review',
      });
    }
    // Otherwise effective `multiple` is unchanged (e.g. false↔absent): no op.
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
    // A schema-shape change can occur with no note ops (e.g. a select option was
    // added). Surface it so `schema diff` consumers can tell the snapshot will
    // refresh on migrate even when no note migrations are needed (#728 defect B).
    schemaChanged: plan.schemaChanged,
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
