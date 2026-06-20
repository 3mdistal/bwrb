/**
 * Schema documentation coverage check.
 *
 * Unlike the rest of the audit subsystem (which validates notes against the
 * schema), this is a schema-quality check: it reports types and fields that
 * lack a `description`. It keeps a self-documenting schema honest over time —
 * the same way a lint rule nudges for missing docstrings.
 *
 * This is surfaced via the opt-in `bwrb audit --check-schema-docs` flag so it
 * never changes the default per-note audit contract.
 */

import type { LoadedSchema } from '../../types/schema.js';
import { getTypeNames, getFieldsByOrigin } from '../schema.js';

export interface UndocumentedSchemaEntries {
  /** Type names with no `description`. */
  types: string[];
  /** Fields (by owning type) with no `description`. */
  fields: Array<{ type: string; field: string }>;
}

/**
 * Find types and fields that have no description.
 *
 * Only a type's *own* fields are checked — an inherited field is documented at
 * the ancestor that defines it, so reporting it on every descendant would be
 * noise. Static identity fields (a fixed `value`, e.g. the `type` discriminator)
 * are skipped because their meaning is self-evident.
 */
export function findUndocumentedSchemaEntries(schema: LoadedSchema): UndocumentedSchemaEntries {
  const types: string[] = [];
  const fields: Array<{ type: string; field: string }> = [];

  for (const typeName of getTypeNames(schema)) {
    if (typeName === 'meta') continue;
    const resolved = schema.types.get(typeName);
    if (!resolved) continue;

    if (!resolved.description) {
      types.push(typeName);
    }

    const { ownFields } = getFieldsByOrigin(schema, typeName);
    for (const [fieldName, field] of Object.entries(ownFields)) {
      if (field.value !== undefined) continue; // static identity field
      if (!field.description) {
        fields.push({ type: typeName, field: fieldName });
      }
    }
  }

  return { types, fields };
}
