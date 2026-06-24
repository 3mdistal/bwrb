import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AuditConfigSchema,
  BodySectionSchema,
  BwrbSchema,
  ConfigSchema,
  FieldSchema,
  FilterConditionSchema,
  RecurrenceSchema,
  TraitSchema,
  TypeSchema,
} from '../types/schema.js';

/**
 * The published JSON Schema (`schema.schema.json` + `docs-site/public/schema.json`)
 * is GENERATED from the Zod source of truth in `src/types/schema.ts` — it is not
 * hand-maintained. This eliminates the drift class behind #626/#693/#666: there is
 * one source (Zod), and the committed JSON files are regenerable artifacts.
 *
 * Run `pnpm schema:gen` to regenerate after changing the Zod schema; CI runs
 * `pnpm schema:check` (regenerate + diff) so a stale committed file fails the build.
 */

const JSON_SCHEMA_TITLE = 'Bowerbird Schema';
const JSON_SCHEMA_DESCRIPTION =
  'Schema for defining types, fields, and configuration for markdown vaults';

/**
 * Stable `definitions` names for the reusable sub-schemas. These names are part of
 * the published contract: editors and the drift-guard test reference
 * `#/definitions/frontmatterField`, `#/definitions/typeNode`, etc. The keys here map
 * those published names onto the Zod sub-schemas so `zod-to-json-schema` emits shared
 * `$ref`s instead of inlining (and so renaming a Zod export can't silently change a
 * published `$ref`).
 */
const DEFINITIONS = {
  config: ConfigSchema,
  trait: TraitSchema,
  recurrence: RecurrenceSchema,
  typeNode: TypeSchema,
  frontmatterField: FieldSchema,
  bodySection: BodySectionSchema,
  filterCondition: FilterConditionSchema,
  auditConfig: AuditConfigSchema,
} as const;

const ROOT_DEF_NAME = '__root';

/**
 * Build the published JSON Schema object from the Zod `BwrbSchema`.
 *
 * `$id` is a parameter because the two published copies differ only by it:
 * - root `schema.schema.json` → `https://bwrb.dev/schema.schema.json`
 * - `docs-site/public/schema.json` (served at the `$schema` URL `bwrb init` writes)
 *   → `https://bwrb.dev/schema.json`
 */
export function buildJsonSchema($id: string): Record<string, unknown> {
  const generated = zodToJsonSchema(BwrbSchema, {
    name: ROOT_DEF_NAME,
    target: 'jsonSchema7',
    $refStrategy: 'root',
    definitions: DEFINITIONS,
    definitionPath: 'definitions',
  }) as {
    definitions: Record<string, Record<string, unknown>>;
  };

  const { [ROOT_DEF_NAME]: root, ...definitions } = generated.definitions;
  if (!root) {
    throw new Error('schema generation failed: root definition missing');
  }

  // Flatten the root object up to the top level (draft-07 meta-schema style) and
  // attach the standard header + the remaining shared definitions. Property order
  // is fixed so the serialized file is stable across regenerations.
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id,
    title: JSON_SCHEMA_TITLE,
    description: JSON_SCHEMA_DESCRIPTION,
    ...root,
    definitions,
  };
}

export const ROOT_SCHEMA_ID = 'https://bwrb.dev/schema.schema.json';
export const DOCS_SCHEMA_ID = 'https://bwrb.dev/schema.json';

/** Deterministic, newline-terminated JSON for writing/diffing the committed files. */
export function serializeJsonSchema(schema: Record<string, unknown>): string {
  return JSON.stringify(schema, null, 2) + '\n';
}
