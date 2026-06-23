/**
 * `schema discover` — deterministic frontmatter field-usage facts.
 *
 * This module is purely DESCRIPTIVE. It reports facts about the frontmatter
 * across a folder of Markdown notes — never a pass/fail judgment. It powers two
 * roles:
 *   1. Before a schema exists → onboarding: raw material for designing types.
 *   2. After a schema exists  → drift detection: fields used-but-undefined,
 *      defined-but-unused, and values diverging from declared `select` options.
 *
 * It deliberately does NOT depend on a vault layout. It walks an arbitrary
 * folder so it can be pointed at a messy, unmanaged directory of Markdown.
 *
 * Contrast with `audit` (which is PRESCRIPTIVE: what is *wrong* vs the schema,
 * with exit codes and fixes). `discover` simply describes what is there.
 */

import { readdir } from 'fs/promises';
import { join, relative } from 'path';
import { parseNote } from './frontmatter.js';
import {
  getAllOwnFieldNames,
  getConcreteTypeNames,
  getFieldsForType,
} from './schema.js';
import { type LoadedSchema, type Field, getOptionValues } from '../types/schema.js';

// ============================================================================
// Value-type classification
// ============================================================================

/**
 * The descriptive value-type buckets `discover` reports per observed value.
 *
 * These are deliberately coarse and frontmatter-shaped (not the schema's
 * `prompt` taxonomy). `date` is a string that matches an ISO-ish date shape —
 * surfaced separately because it is a common, meaningful distinction when
 * eyeballing a messy folder. `empty` covers null / empty string / empty list.
 */
export type ValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'list'
  | 'object'
  | 'empty';

// YYYY, YYYY-MM, or YYYY-MM-DD (optionally with a time component).
const DATE_LIKE = /^\d{4}(-\d{2}(-\d{2}(T[\d:.]+Z?)?)?)?$/;

/**
 * Classify a single frontmatter value into a descriptive {@link ValueType}.
 *
 * `parseNote` already normalizes YAML dates to `YYYY-MM-DD` strings, so dates
 * arrive here as strings and are re-detected by shape.
 */
function classifyValue(value: unknown): ValueType {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (value.trim().length === 0) return 'empty';
    if (DATE_LIKE.test(value.trim())) return 'date';
    return 'string';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'empty' : 'list';
  }
  if (typeof value === 'object') return 'object';
  return 'string';
}

/**
 * Collect the scalar string values a field holds in a note, for matching
 * against declared `select` options. Scalars contribute their string form;
 * lists contribute each scalar element; everything else contributes nothing.
 */
function collectComparableValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectComparableValues(item));
  }
  return [];
}

// ============================================================================
// Report shape
// ============================================================================

/** A value that diverged from a field's declared `select` options. */
export interface DivergingValue {
  value: string;
  /** Note paths (relative to the scanned root) that used this value. */
  files: string[];
}

/** Per-field descriptive facts aggregated across the scanned notes. */
export interface FieldFacts {
  field: string;
  /** Number of notes in which this field appears (its key is present). */
  count: number;
  /** Fraction of notes-with-frontmatter that use this field (0..1). */
  frequency: number;
  /**
   * Observed value-types and how many notes exhibited each, sorted by
   * descending count then name. More than one entry = mixed value types.
   */
  types: Array<{ type: ValueType; count: number }>;
  /** True when the field shows more than one (non-empty) value-type. */
  mixedTypes: boolean;
  /**
   * Files whose value-type for this field differs from the field's most common
   * value-type. Purely descriptive ("these diverge"), never an error.
   */
  divergingFiles: string[];
  /**
   * Drift facts present only when a schema was loaded.
   * `defined` — whether the field is declared by any concrete type's schema.
   * `divergingOptions` — values that fall outside the field's declared
   *   `select` options (only computed for fields that declare options).
   */
  defined?: boolean;
  divergingOptions?: DivergingValue[];
}

/** Drift facts that only make sense relative to a loaded schema. */
export interface DriftFacts {
  /** Fields that appear in notes but are not declared by any type. */
  usedButUndefined: string[];
  /** Fields declared by the schema but never seen in any scanned note. */
  definedButUnused: string[];
  /** Fields whose values diverge from their declared `select` options. */
  optionDivergences: Array<{ field: string; values: DivergingValue[] }>;
}

/** The complete descriptive report. */
export interface DiscoverReport {
  /** Absolute path that was scanned. */
  root: string;
  /** Total Markdown files seen. */
  totalFiles: number;
  /** Files that had a (non-empty) frontmatter block. */
  filesWithFrontmatter: number;
  /**
   * Paths that could not be read and were skipped (path + reason). Never fatal.
   * Includes individual files that failed to parse and NESTED subdirectories
   * that could not be listed mid-walk. (An unreadable scanned ROOT is a hard
   * error and never reaches a report.)
   */
  unreadable: Array<{ file: string; error: string }>;
  /** Whether a schema was found and loaded for drift detection. */
  schemaPresent: boolean;
  /** Per-field facts, sorted by descending count then field name. */
  fields: FieldFacts[];
  /** Drift section — present only when a schema was loaded. */
  drift?: DriftFacts;
}

// ============================================================================
// File walking
// ============================================================================

/** Result of walking a folder for Markdown files. */
interface MarkdownWalkResult {
  /** Absolute paths of every `.md` file found, sorted. */
  files: string[];
  /**
   * Nested directories that could not be read mid-walk (path + reason). The
   * scanned ROOT is never recorded here — an unreadable root is a hard error
   * raised by the caller of {@link collectMarkdownFiles}, not a recoverable
   * skip. These are surfaced (not silently dropped) but do not abort the scan.
   */
  unreadableDirs: Array<{ dir: string; error: string }>;
}

/**
 * Recursively collect `.md` files under `dir`. Hidden directories (`.git`,
 * `.bwrb`, …) are skipped. Standalone helper so discover can run on an
 * arbitrary folder without the vault's schema-aware discovery machinery.
 *
 * The ROOT directory being unreadable is a hard error: `readdir` throws and
 * the error propagates to the caller (which maps it to a non-zero exit). An
 * unreadable NESTED subdirectory is recoverable — it is recorded in
 * `unreadableDirs` and the rest of the tree is still scanned, so one locked
 * subfolder does not make the whole run silently report "0 files".
 *
 * @param isRoot whether `dir` is the originally scanned root (default true).
 *   Recursive calls pass `false` so their failures are recorded, not thrown.
 */
async function collectMarkdownFiles(
  dir: string,
  isRoot = true
): Promise<MarkdownWalkResult> {
  const files: string[] = [];
  const unreadableDirs: Array<{ dir: string; error: string }> = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Root unreadable → hard error (exit 2). Nested → record and skip.
    if (isRoot) throw err;
    unreadableDirs.push({
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { files, unreadableDirs };
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(full, false);
      files.push(...nested.files);
      unreadableDirs.push(...nested.unreadableDirs);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }

  return {
    files: files.sort((a, b) => a.localeCompare(b)),
    unreadableDirs,
  };
}

// ============================================================================
// Schema field collation
// ============================================================================

/**
 * Field names that are recognized but are not schema-declared fields: the
 * `type` discriminator and bwrb built-ins (`id`, `name`). They count as
 * "defined" for the used-but-undefined check, but are excluded from the
 * defined-but-unused check (they are not fields a user designs).
 */
const ALWAYS_DEFINED_FIELDS = new Set(['type', 'id', 'name']);

interface SchemaFieldInfo {
  /** Field names declared by any concrete type (excludes built-ins). */
  schemaFields: Set<string>;
  /** Names treated as "defined" — schema fields plus recognized built-ins. */
  definedFields: Set<string>;
  /** field name -> declared `select` option values (only fields with options). */
  optionsByField: Map<string, Set<string>>;
}

/**
 * Collate the union of declared field names and declared `select` options
 * across all concrete types. Discover aggregates by bare field name (it has no
 * per-note type discriminator guarantee), so this intentionally flattens
 * across types. If two types declare the same field name with different option
 * sets, the union of their options is used (a value is "diverging" only if it
 * matches no type's declaration).
 */
function collateSchemaFields(schema: LoadedSchema): SchemaFieldInfo {
  const schemaFields = new Set<string>(getAllOwnFieldNames(schema));
  const optionsByField = new Map<string, Set<string>>();

  for (const typeName of getConcreteTypeNames(schema)) {
    const fields = getFieldsForType(schema, typeName);
    for (const [fieldName, field] of Object.entries(fields)) {
      schemaFields.add(fieldName);
      const opts = getDeclaredOptions(field);
      if (opts.length > 0) {
        const existing = optionsByField.get(fieldName) ?? new Set<string>();
        for (const opt of opts) existing.add(opt);
        optionsByField.set(fieldName, existing);
      }
    }
  }

  const definedFields = new Set<string>(schemaFields);
  for (const builtin of ALWAYS_DEFINED_FIELDS) definedFields.add(builtin);

  return { schemaFields, definedFields, optionsByField };
}

function getDeclaredOptions(field: Field): string[] {
  if (!field.options) return [];
  return getOptionValues(field.options);
}

// ============================================================================
// Aggregation
// ============================================================================

interface FieldAccumulator {
  count: number;
  typeCounts: Map<ValueType, number>;
  /** relativePath -> the (non-empty) value-type observed there. */
  fileTypes: Map<string, ValueType>;
  /** option value -> relativePaths that used it (only for declared-option fields). */
  divergingOptionFiles: Map<string, Set<string>>;
}

export interface BuildReportOptions {
  /** Loaded schema for drift detection, or undefined for the pre-schema role. */
  schema?: LoadedSchema | undefined;
}

/**
 * Build a {@link DiscoverReport} over all Markdown notes under `root`.
 *
 * Purely descriptive: it never throws on "non-conforming" data and never
 * returns a pass/fail verdict. Unreadable individual files are recorded in
 * `unreadable` and skipped, not thrown.
 */
export async function buildDiscoverReport(
  root: string,
  options: BuildReportOptions = {}
): Promise<DiscoverReport> {
  const { schema } = options;
  // An unreadable ROOT throws here and propagates to the command layer, which
  // maps it to a non-zero (IO_ERROR) exit. Nested unreadable dirs are returned
  // and surfaced below rather than aborting the scan.
  const { files, unreadableDirs } = await collectMarkdownFiles(root);

  const accumulators = new Map<string, FieldAccumulator>();
  const unreadable: Array<{ file: string; error: string }> = unreadableDirs.map(
    (d) => ({ file: relative(root, d.dir), error: d.error })
  );
  let filesWithFrontmatter = 0;

  const schemaInfo = schema ? collateSchemaFields(schema) : undefined;

  for (const filePath of files) {
    const rel = relative(root, filePath);
    let frontmatter: Record<string, unknown>;
    try {
      ({ frontmatter } = await parseNote(filePath));
    } catch (err) {
      unreadable.push({
        file: rel,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const keys = Object.keys(frontmatter);
    if (keys.length > 0) filesWithFrontmatter++;

    for (const key of keys) {
      const value = frontmatter[key];
      const valueType = classifyValue(value);

      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          count: 0,
          typeCounts: new Map(),
          fileTypes: new Map(),
          divergingOptionFiles: new Map(),
        };
        accumulators.set(key, acc);
      }
      acc.count++;
      acc.typeCounts.set(valueType, (acc.typeCounts.get(valueType) ?? 0) + 1);
      // Only track non-empty value-types for divergence (empty is not a "type").
      if (valueType !== 'empty') {
        acc.fileTypes.set(rel, valueType);
      }

      // Option divergence (schema role only).
      const declaredOptions = schemaInfo?.optionsByField.get(key);
      if (declaredOptions) {
        for (const candidate of collectComparableValues(value)) {
          if (!declaredOptions.has(candidate)) {
            const set = acc.divergingOptionFiles.get(candidate) ?? new Set<string>();
            set.add(rel);
            acc.divergingOptionFiles.set(candidate, set);
          }
        }
      }
    }
  }

  const fields = buildFieldFacts(accumulators, filesWithFrontmatter, schemaInfo);

  const report: DiscoverReport = {
    root,
    totalFiles: files.length,
    filesWithFrontmatter,
    unreadable,
    schemaPresent: Boolean(schema),
    fields,
  };

  if (schemaInfo) {
    report.drift = buildDriftFacts(fields, schemaInfo);
  }

  return report;
}

function buildFieldFacts(
  accumulators: Map<string, FieldAccumulator>,
  filesWithFrontmatter: number,
  schemaInfo: SchemaFieldInfo | undefined
): FieldFacts[] {
  const facts: FieldFacts[] = [];

  for (const [field, acc] of accumulators) {
    const types = Array.from(acc.typeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    const nonEmptyTypes = types.filter((t) => t.type !== 'empty');
    const mixedTypes = nonEmptyTypes.length > 1;

    // Most common non-empty value-type is the "baseline"; others diverge.
    const baseline = nonEmptyTypes[0]?.type;
    const divergingFiles = baseline
      ? Array.from(acc.fileTypes.entries())
          .filter(([, t]) => t !== baseline)
          .map(([file]) => file)
          .sort((a, b) => a.localeCompare(b))
      : [];

    const factEntry: FieldFacts = {
      field,
      count: acc.count,
      frequency: filesWithFrontmatter > 0 ? acc.count / filesWithFrontmatter : 0,
      types,
      mixedTypes,
      divergingFiles,
    };

    if (schemaInfo) {
      factEntry.defined = schemaInfo.definedFields.has(field);
      if (schemaInfo.optionsByField.has(field)) {
        factEntry.divergingOptions = Array.from(acc.divergingOptionFiles.entries())
          .map(([value, files]) => ({
            value,
            files: Array.from(files).sort((a, b) => a.localeCompare(b)),
          }))
          .sort((a, b) => a.value.localeCompare(b.value));
      }
    }

    facts.push(factEntry);
  }

  return facts.sort(
    (a, b) => b.count - a.count || a.field.localeCompare(b.field)
  );
}

function buildDriftFacts(
  fields: FieldFacts[],
  schemaInfo: SchemaFieldInfo
): DriftFacts {
  const usedFieldNames = new Set(fields.map((f) => f.field));

  const usedButUndefined = fields
    .filter((f) => f.defined === false)
    .map((f) => f.field)
    .sort((a, b) => a.localeCompare(b));

  const definedButUnused = Array.from(schemaInfo.schemaFields)
    .filter((name) => !usedFieldNames.has(name))
    .sort((a, b) => a.localeCompare(b));

  const optionDivergences = fields
    .filter((f) => f.divergingOptions && f.divergingOptions.length > 0)
    .map((f) => ({ field: f.field, values: f.divergingOptions! }))
    .sort((a, b) => a.field.localeCompare(b.field));

  return { usedButUndefined, definedButUnused, optionDivergences };
}
