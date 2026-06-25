/**
 * Schema diff engine.
 * Compares two schemas and generates a migration plan.
 */

import { Schema, Field, getOptionValues } from '../../types/schema.js';
import { resolveSchema, getDescendants } from '../schema.js';
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

  // Resolve both schemas once so field-changed ops can enumerate the descendant
  // types that *inherit* the changed field (and therefore hold notes affected by
  // the change). We resolve the OLD schema to decide affectedness: a descendant
  // is affected iff, in the pre-change schema, its EFFECTIVE field still inherited
  // the declaring type's structural aspect being changed (it did not override
  // `options`/`multiple`). That is exactly the structure its existing notes were
  // written against. Resolution is pure and synchronous and reuses the same
  // `extends`-based inheritance the rest of the app uses. Lazily computed so
  // schemas with no field-changed ops pay nothing.
  let resolvedNew: ReturnType<typeof resolveSchema> | undefined;
  const getResolvedNew = (): ReturnType<typeof resolveSchema> => {
    if (!resolvedNew) resolvedNew = resolveSchema(newSchema);
    return resolvedNew;
  };
  let resolvedOld: ReturnType<typeof resolveSchema> | undefined | null;
  const getResolvedOld = (): ReturnType<typeof resolveSchema> | undefined => {
    if (resolvedOld === undefined) {
      resolvedOld = oldSchema ? resolveSchema(oldSchema) : null;
    }
    return resolvedOld ?? undefined;
  };

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
        const affectedTypes = affectedTypesForField(
          getResolvedNew(),
          getResolvedOld(),
          change.type,
          change.field,
          change.changes
        );
        classifyFieldChange(
          change,
          oldField,
          newField,
          affectedTypes,
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
 * Enumerate the types whose notes are affected by a field-changed op.
 *
 * A field-changed op is recorded against the type that *declares* the field, but
 * `executeMigration` matches ops to notes by the note's exact type. Descendant
 * types that INHERIT the field (via `extends`, without overriding the changed
 * structural aspect) hold notes that carry the same value set and are therefore
 * equally affected — yet they would never receive the op if it only targeted the
 * declaring type (#728 / Codex defect A: removing a parent-type select option
 * leaves invalid values in child-type notes untouched while the snapshot
 * advances).
 *
 * A descendant is excluded only when it *structurally* overrides the specific
 * aspect being changed. The decision must distinguish two kinds of raw child
 * field entry, which differ in how schema resolution treats them:
 *
 *   - **Metadata-only override** (child re-declares the field but sets ONLY
 *     `description`/`default`/`value`/`granularity`): resolution's restricted
 *     merge for inherited fields KEEPS the parent's structural `options`/
 *     `multiple`, so the child's notes still inherit the parent's value set and
 *     ARE affected. The prior fix wrongly excluded these (treated any raw entry
 *     as a full redefinition) — the data-loss defect.
 *   - **Structural override** (child's raw entry declares the very aspect being
 *     changed — `options` for an options change, `multiple` for a multiple
 *     change): the child owns that aspect independently of the parent, so the
 *     parent's change does not reach it → excluded.
 *
 * The structural aspect being changed comes from `changedProps`. We therefore ask
 * a per-aspect question of each type on the chain between the descendant and the
 * declaring type: does its RAW field entry declare that aspect? If so, the
 * descendant is excluded. We read raw entries (not the resolved field) precisely
 * because resolution's restricted merge would otherwise hide a child's own
 * `options` and make metadata-only and structural overrides indistinguishable.
 *
 * `resolvedNew`/`resolvedOld` provide the descendant tree and ancestor chains
 * (identical topology in both for a pure field-changed edit). Raw entries are
 * read from the relevant schema; the old schema is preferred so the decision
 * reflects the structure existing notes were written against.
 */
function affectedTypesForField(
  resolvedNew: ReturnType<typeof resolveSchema>,
  resolvedOld: ReturnType<typeof resolveSchema> | undefined,
  declaringType: string,
  field: string,
  changedProps: string[]
): string[] {
  const affected = [declaringType];
  const structural = resolvedOld ?? resolvedNew;
  const traits = structural.raw.traits ?? {};

  // The structural aspects this op touches. A descendant (or an intermediate
  // ancestor) that raw-declares ANY of these for the field breaks inheritance of
  // the parent's structure and is excluded. Metadata-only keys are intentionally
  // NOT listed: re-declaring just a description/default/value/granularity leaves
  // the parent's structure intact (restricted merge), so the child stays affected.
  const structuralAspects: (keyof Field)[] = [];
  if (changedProps.includes('options')) structuralAspects.push('options');
  if (changedProps.includes('multiple')) structuralAspects.push('multiple');
  if (changedProps.includes('required')) structuralAspects.push('required');
  if (changedProps.includes('source')) structuralAspects.push('source');

  // A type structurally overrides the field when its OWN raw definition declares
  // one of the changed aspects, or a composed trait provides the field (a trait
  // fully replaces the field, so it owns every aspect). A raw entry that touches
  // only metadata keys does NOT count.
  const overridesStructure = (typeName: string): boolean => {
    const rawField = structural.raw.types[typeName]?.fields?.[field];
    if (rawField !== undefined) {
      const ownsAspect = structuralAspects.some(
        (aspect) => (rawField as Field)[aspect] !== undefined
      );
      if (ownsAspect) return true;
    }
    const composed = structural.types.get(typeName)?.traits ?? [];
    return composed.some((t) => traits[t]?.fields?.[field] !== undefined);
  };

  for (const descendantName of getDescendants(resolvedNew, declaringType)) {
    const descendant = structural.types.get(descendantName);
    if (!descendant) continue;
    if (!(field in descendant.fields)) continue; // field not present at all

    // Walk from the descendant up to (but not including) the declaring type. A
    // structural override anywhere on that path means the descendant's notes are
    // governed by an independent definition, so the parent's change does not
    // reach them.
    const chainToParent = [descendantName, ...descendant.ancestors];
    let overridden = false;
    for (const typeName of chainToParent) {
      if (typeName === declaringType) break;
      if (overridesStructure(typeName)) {
        overridden = true;
        break;
      }
    }

    if (!overridden) affected.push(descendantName);
  }

  return affected;
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
  affectedTypes: string[],
  deterministic: MigrationOp[],
  nonDeterministic: MigrationOp[]
): void {
  const { field, changes: changedProps } = change;

  // A field-changed op applies to every type whose notes carry the field: the
  // type that declares it AND all descendant types that inherit it (#728). We
  // therefore emit one op per affected type so `executeMigration`, which matches
  // ops to notes by exact type, reaches inheriting descendants too.
  const emitForEach = (
    bucket: MigrationOp[],
    make: (targetType: string) => MigrationOp
  ): void => {
    for (const targetType of affectedTypes) {
      bucket.push(make(targetType));
    }
  };

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
        emitForEach(nonDeterministic, (targetType) => ({
          op: 'clear-invalid-options',
          targetType,
          field,
          allowedValues: [...newValues],
        }));
      } else {
        // Options were removed *entirely*: the field no longer constrains its
        // values (it has become free-text / unconstrained). Every existing value
        // is still valid for the new definition, so clearing them would be silent
        // data loss. Surface the change for review instead of mutating notes.
        emitForEach(nonDeterministic, (targetType) => ({
          op: 'review-field',
          targetType,
          field,
          reason:
            'field is no longer a constrained select (all options removed); existing values are kept as free text',
        }));
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
      emitForEach(deterministic, (targetType) => ({
        op: 'widen-field-to-multiple',
        targetType,
        field,
      }));
    } else if (!newMultiple && oldMultiple) {
      // Narrowing to single: collapsing an array is lossy and ambiguous.
      emitForEach(nonDeterministic, (targetType) => ({
        op: 'review-field',
        targetType,
        field,
        reason: 'field no longer accepts multiple values; existing arrays need manual review',
      }));
    }
    // Otherwise effective `multiple` is unchanged (e.g. false↔absent): no op.
  }

  if (changedProps.includes('required') && newField?.required === true && oldField?.required !== true) {
    // Field became required: notes missing the value now violate the schema,
    // but we cannot fabricate a value, so surface it for review.
    emitForEach(nonDeterministic, (targetType) => ({
      op: 'review-field',
      targetType,
      field,
      reason: 'field is now required; notes missing a value need manual review',
    }));
  }

  if (changedProps.includes('source')) {
    // Relation source retargeted: existing links may point at the wrong type.
    emitForEach(nonDeterministic, (targetType) => ({
      op: 'review-field',
      targetType,
      field,
      reason: 'relation source changed; existing links may need manual review',
    }));
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
