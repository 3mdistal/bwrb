/**
 * Task recurrence: spawn-on-transition (#107).
 * =============================================
 *
 * The heart of the task system. Declaratively: "when a field transitions to a
 * value (e.g. `status` enters `done`), spawn a successor note from a template,
 * with the successor's date field offset from a predecessor date field." No
 * cron, no daemon, no LLM — the trigger is a field transition, not a clock.
 *
 * This module is the SINGLE source of truth shared by BOTH execution paths so
 * they produce identical successors:
 *
 * - Fast path: completing via `bwrb edit` / `bwrb bulk --set status=done`
 *   spawns the successor immediately as a deterministic side-effect of the
 *   write (see `maybeSpawnSuccessor`, called from the edit layer).
 * - Backstop: completing OUTSIDE bwrb (hand-edited frontmatter) is caught on
 *   the next `bwrb audit` — "trigger satisfied AND chain field empty AND type
 *   recurs" → `missing-successor`, auto-fixable via the same spawn.
 *
 * Idempotency is paramount: a successor is spawned ONLY when the chain field
 * (`next`) is empty. Re-completing a task that already has a `next` is a no-op
 * on either path.
 */

import { basename, join } from 'path';
import { existsSync } from 'fs';
import type { LoadedSchema } from '../types/schema.js';
import { getRecurrenceForType, getFieldsForType, getType, getOutputDir } from './schema.js';
import { parseDate } from './local-date.js';
import { formatDateWithPattern } from './local-date.js';
import { formatValue } from './vault.js';
import { getFilenamePattern } from './template.js';
import { createNoteFromJson } from '../commands/new/json-mode.js';
import { findDefaultTemplateWithInheritance } from './template.js';
import type { NoteCreationResult } from '../commands/new/types.js';

/** The forward chain field. Empty `next` is the idempotency guard. */
export const CHAIN_NEXT_FIELD = 'next';
/** The optional back-link chain field, set on the spawned successor. */
const CHAIN_PREV_FIELD = 'prev';

/**
 * A parsed `on:` trigger, e.g. `"status = done"` → { field: 'status', value: 'done' }.
 */
export interface RecurrenceTrigger {
  field: string;
  value: string;
}

/**
 * Parse an `on:` trigger expression of the form `<field> = <value>`.
 * Returns null when the expression is malformed.
 */
export function parseTrigger(on: string): RecurrenceTrigger | null {
  const eq = on.indexOf('=');
  if (eq === -1) return null;
  const field = on.slice(0, eq).trim();
  // Strip an optional surrounding pair of quotes from the value.
  let value = on.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!field || !value) return null;
  return { field, value };
}

/**
 * A parsed field-offset expression, e.g. `"deadline + 7d"`.
 */
export interface FieldOffset {
  baseField: string;
  sign: 1 | -1;
  amount: number;
  unit: OffsetUnit;
}

type OffsetUnit = 'min' | 'h' | 'd' | 'w' | 'mon' | 'y';

const OFFSET_PATTERN = /^([A-Za-z0-9_-]+)\s*([+-])\s*(\d+)(min|h|d|w|mon|m|y)$/;

/**
 * Parse a field-offset expression `<dateField> <+|-> <amount><unit>`.
 * Returns null when it isn't a field-offset expression.
 */
export function parseFieldOffset(expr: string): FieldOffset | null {
  const m = expr.trim().match(OFFSET_PATTERN);
  if (!m) return null;
  const rawUnit = m[4]!;
  const unit: OffsetUnit = rawUnit === 'm' ? 'mon' : (rawUnit as OffsetUnit);
  return {
    baseField: m[1]!,
    sign: m[2] === '-' ? -1 : 1,
    amount: parseInt(m[3]!, 10),
    unit,
  };
}

/**
 * Add a calendar offset to a Date. Days/weeks/hours/minutes use exact
 * arithmetic; months and years use calendar-aware addition so "deadline + 1mon"
 * lands on the same day-of-month next month rather than drifting by 30 days.
 */
function addOffset(date: Date, offset: FieldOffset): Date {
  const d = new Date(date.getTime());
  const n = offset.sign * offset.amount;
  switch (offset.unit) {
    case 'min':
      d.setMinutes(d.getMinutes() + n);
      break;
    case 'h':
      d.setHours(d.getHours() + n);
      break;
    case 'd':
      d.setDate(d.getDate() + n);
      break;
    case 'w':
      d.setDate(d.getDate() + n * 7);
      break;
    case 'mon':
      d.setMonth(d.getMonth() + n);
      break;
    case 'y':
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return d;
}

/**
 * Result of validating a recurrence rule against the schema. Used by the audit
 * template/offset validation so a broken rule is a deterministic error.
 */
export interface RecurrenceValidationIssue {
  message: string;
}

/**
 * Validate a recurrence rule statically against the schema (no vault I/O):
 * - the trigger parses,
 * - every `set` value is a field-offset expression whose base is a DATE field,
 * - the target field of each `set` exists on the spawned type.
 *
 * Template existence is checked separately (it needs vault I/O) by the audit.
 */
export function validateRecurrenceRule(
  schema: LoadedSchema,
  typeName: string
): RecurrenceValidationIssue[] {
  const issues: RecurrenceValidationIssue[] = [];
  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved) return issues;

  const { recurrence, trait } = resolved;

  const trigger = parseTrigger(recurrence.on);
  if (!trigger) {
    issues.push({
      message: `Recurrence trait '${trait}' on type '${typeName}' has an invalid 'on' trigger: "${recurrence.on}". Expected "<field> = <value>".`,
    });
  }

  // The successor's type is the spawned type. Without a named template we spawn
  // the same type (a task begets a task), so validate offsets against this type.
  const targetFields = getFieldsForType(schema, typeName);

  for (const [field, expr] of Object.entries(recurrence.set ?? {})) {
    const offset = parseFieldOffset(expr);
    if (!offset) {
      issues.push({
        message: `Recurrence trait '${trait}' on type '${typeName}': set.${field} = "${expr}" is not a field-offset expression. Use "<dateField> + <duration>" (e.g. "deadline + 7d").`,
      });
      continue;
    }
    const baseFieldDef = targetFields[offset.baseField];
    if (!baseFieldDef) {
      issues.push({
        message: `Recurrence trait '${trait}' on type '${typeName}': set.${field} references unknown base field '${offset.baseField}'.`,
      });
      continue;
    }
    if (baseFieldDef.prompt !== 'date') {
      issues.push({
        message: `Recurrence trait '${trait}' on type '${typeName}': set.${field} base '${offset.baseField}' must be a date field (offset base must be a date).`,
      });
    }
  }

  return issues;
}

/**
 * Whether a note (by its current frontmatter) currently satisfies the trigger
 * AND has not yet spawned a successor (chain field empty). This is exactly the
 * backstop predicate: "trigger satisfied AND `next` empty AND type recurs".
 */
export function needsSuccessor(
  schema: LoadedSchema,
  typeName: string,
  frontmatter: Record<string, unknown>
): boolean {
  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved) return false;

  const trigger = parseTrigger(resolved.recurrence.on);
  if (!trigger) return false;

  if (!valueEquals(frontmatter[trigger.field], trigger.value)) return false;

  return isChainFieldEmpty(frontmatter[CHAIN_NEXT_FIELD]);
}

/**
 * Detect whether a write transitions the trigger field INTO its trigger value
 * (old != trigger, new == trigger). Used by the fast path.
 */
export function isTriggerTransition(
  trigger: RecurrenceTrigger,
  oldValue: unknown,
  newValue: unknown
): boolean {
  return !valueEquals(oldValue, trigger.value) && valueEquals(newValue, trigger.value);
}

function valueEquals(value: unknown, target: string): boolean {
  if (value === undefined || value === null) return false;
  return String(value) === target;
}

function isChainFieldEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Compute the successor's field-offset assignments from the predecessor
 * frontmatter. Throws when a base date field is missing or unparseable — these
 * are surfaced to the caller (fast path → error; backstop → fix failure).
 *
 * Returned values are formatted with the vault's date format, so they match the
 * normalization both creation paths apply.
 */
export function computeOffsetFields(
  schema: LoadedSchema,
  typeName: string,
  predecessor: Record<string, unknown>
): Record<string, string> {
  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved?.recurrence.set) return {};

  const out: Record<string, string> = {};
  for (const [field, expr] of Object.entries(resolved.recurrence.set)) {
    const offset = parseFieldOffset(expr);
    if (!offset) {
      throw new Error(`Recurrence set.${field} = "${expr}" is not a valid field-offset expression.`);
    }
    const baseRaw = predecessor[offset.baseField];
    if (baseRaw === undefined || baseRaw === null || String(baseRaw).trim() === '') {
      throw new Error(`Recurrence set.${field}: base date field '${offset.baseField}' is empty on the predecessor.`);
    }
    const parsed = parseDate(String(baseRaw));
    if (!parsed.valid || !parsed.date) {
      throw new Error(`Recurrence set.${field}: base date field '${offset.baseField}' value "${String(baseRaw)}" is not a valid date.`);
    }
    const next = addOffset(parsed.date, offset);
    out[field] = formatDateWithPattern(next, schema.config.dateFormat);
  }
  return out;
}

/**
 * The successor note's basename (used to write the predecessor's `next` link).
 * Derived from the created file path.
 */
function basenameNoExt(filePath: string): string {
  return basename(filePath, '.md');
}

/**
 * Build the successor frontmatter input (the JSON given to the real creation
 * path), shared by both execution paths so they produce identical successors.
 *
 * - `name` is carried over from the predecessor (so the chain reads naturally),
 *   unless a filename pattern makes it unnecessary; we always pass it as a safe
 *   fallback.
 * - The trigger field is reset so the successor starts fresh (never spawned
 *   already-done → no infinite chain).
 * - `prev` points back at the predecessor; `next` is left empty.
 * - Offset date fields are computed from the predecessor.
 */
function buildSuccessorInput(
  schema: LoadedSchema,
  recurringTypeName: string,
  spawnTypeName: string,
  predecessorName: string,
  successorName: string,
  offsetFields: Record<string, string>
): Record<string, unknown> {
  const resolved = getRecurrenceForType(schema, recurringTypeName)!;
  const trigger = parseTrigger(resolved.recurrence.on)!;
  const fields = getFieldsForType(schema, spawnTypeName);

  const input: Record<string, unknown> = {};

  // The successor's name (disambiguated by the caller so it never collides with
  // the predecessor's filename).
  input['name'] = successorName;

  // Reset the trigger field so the successor starts fresh (not already-done).
  // Prefer the field's schema default; otherwise drop it so defaults apply.
  const triggerFieldDef = fields[trigger.field];
  if (triggerFieldDef?.default !== undefined) {
    input[trigger.field] = triggerFieldDef.default;
  }
  // (If there's no default, omit it: applyDefaults / schema handle the rest, and
  // crucially we never set it to the trigger value.)

  // Apply computed offset date fields.
  for (const [field, value] of Object.entries(offsetFields)) {
    input[field] = value;
  }

  // Back-link to the predecessor; leave the forward link empty.
  if (fields[CHAIN_PREV_FIELD]) {
    input[CHAIN_PREV_FIELD] = formatValue(predecessorName, schema.config.linkFormat);
  }

  return input;
}

/**
 * Resolve which template the successor is spawned from. Defaults to the
 * completed note's type default template; a named template (`recurrence.template`)
 * can spawn a different type. Returns the resolved template and the type to
 * create. Throws when a named template is missing or its `template-for` type is
 * unknown (deterministic config error).
 */
async function resolveSuccessorTemplate(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string
): Promise<{ template: import('../types/schema.js').Template | null; spawnType: string }> {
  const resolved = getRecurrenceForType(schema, typeName)!;
  const named = resolved.recurrence.template;

  if (named) {
    // A named template can spawn a DIFFERENT type. Search the whole vault for a
    // template with this name, regardless of the type it targets.
    const { findAllTemplates } = await import('./template.js');
    const all = await findAllTemplates(vaultDir);
    const match = all.find((t) => t.name === named);
    if (!match) {
      throw new Error(`Recurrence template '${named}' (type '${typeName}') was not found in the vault.`);
    }
    const spawnType = match.templateFor;
    if (!getType(schema, spawnType)) {
      throw new Error(`Recurrence template '${named}' targets unknown type '${spawnType}'.`);
    }
    return { template: match, spawnType };
  }

  // Default: the type's own default template (a task begets a task).
  const def = await findDefaultTemplateWithInheritance(vaultDir, typeName, schema);
  return { template: def, spawnType: typeName };
}

/**
 * Resolve a collision-free successor name.
 *
 * If the spawn type (or its template) defines a filename pattern, that pattern
 * disambiguates the filename (commonly via a date), so the carried-forward name
 * is returned unchanged. Otherwise the successor would be filed as
 * `<name>.md` — identical to the predecessor — so we suffix ` 2`, ` 3`, ...
 * against the spawn type's output directory until a free name is found.
 */
function resolveSuccessorName(
  schema: LoadedSchema,
  vaultDir: string,
  spawnType: string,
  template: import('../types/schema.js').Template | null,
  baseName: string
): string {
  const typeDef = getType(schema, spawnType);
  const pattern = typeDef ? getFilenamePattern(template, typeDef) : null;
  if (pattern) {
    return baseName;
  }

  const outputDir = getOutputDir(schema, spawnType);
  const dir = outputDir ? join(vaultDir, outputDir) : vaultDir;

  const exists = (name: string): boolean => existsSync(join(dir, `${name}.md`));
  if (!exists(baseName)) return baseName;

  let counter = 2;
  while (exists(`${baseName} ${counter}`)) counter++;
  return `${baseName} ${counter}`;
}

/**
 * Spawn a successor for a recurring note, then back-link the predecessor's
 * `next` field to it. Shared by the fast path and the backstop so both produce
 * identical successors.
 *
 * IDEMPOTENCY: callers MUST confirm the chain field is empty before calling
 * (the fast path checks the transition; the backstop checks `needsSuccessor`).
 * This function does not re-check, so it is the single spawn primitive.
 *
 * Returns the created successor path, or null when the rule produces no
 * successor (e.g. type does not recur).
 *
 * @param writePredecessorNext - callback to persist the predecessor's `next`
 *   link. The two paths persist differently (edit layer rewrites the note it
 *   already holds; the backstop writes the file directly), so the caller owns
 *   the write while this function owns the value.
 */
export async function spawnSuccessor(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  predecessor: Record<string, unknown>,
  predecessorName: string,
  writePredecessorNext: (nextLink: string) => Promise<void>
): Promise<string | null> {
  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved) return null;

  const { template, spawnType } = await resolveSuccessorTemplate(schema, vaultDir, typeName);

  // Offset fields are computed against the recurring type's date fields.
  const offsetFields = computeOffsetFields(schema, typeName, predecessor);

  // Resolve a successor name that won't collide with the predecessor's filename.
  // When the spawn type uses a filename pattern, the pattern disambiguates (so we
  // keep the carried-forward name); otherwise we suffix a counter against the
  // spawn type's output directory.
  const carriedName =
    typeof predecessor['name'] === 'string' && predecessor['name'].trim() !== ''
      ? (predecessor['name'] as string)
      : predecessorName;
  const successorName = resolveSuccessorName(schema, vaultDir, spawnType, template, carriedName);

  const input = buildSuccessorInput(
    schema,
    typeName,
    spawnType,
    predecessorName,
    successorName,
    offsetFields
  );

  let result: NoteCreationResult;
  try {
    result = await createNoteFromJson(
      schema,
      vaultDir,
      spawnType,
      JSON.stringify(input),
      template,
      { noInstances: true }
    );
  } catch (err) {
    throw new Error(`Failed to spawn recurrence successor for '${predecessorName}': ${(err as Error).message}`);
  }

  // Back-link the predecessor's `next` to the freshly created successor (using
  // the actual created filename, in case a filename pattern reshaped it).
  const createdName = basenameNoExt(result.path);
  const nextLink = formatValue(createdName, schema.config.linkFormat);
  await writePredecessorNext(nextLink);

  return result.path;
}
