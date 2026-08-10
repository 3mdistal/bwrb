import { z } from 'zod';

// ============================================================================
// Field Definition
// ============================================================================

// Filter condition for type-based source queries
export const FilterConditionSchema = z.object({
  equals: z.string().optional().describe('Field must equal this value'),
  not_equals: z.string().optional().describe('Field must not equal this value'),
  in: z.array(z.string()).optional().describe('Field must be one of these values'),
  not_in: z.array(z.string()).optional().describe('Field must not be one of these values'),
});

export const CalendarEraSchema = z.object({
  name: z.string().describe('Era name'),
  shortName: z.string().min(1).describe('Short era token used in date strings'),
  backwards: z
    .boolean()
    .optional()
    .describe('Whether years count down toward the era boundary'),
});

export const CalendarMonthSchema = z.object({
  name: z.string().describe('Month name'),
  shortName: z.string().min(1).optional().describe('Short month label'),
  days: z.number().int().min(1).describe('Number of days in this month'),
});

export const CalendarSchema = z
  .object({
    label: z.string().optional().describe('Human-readable calendar label'),
    hoursInDay: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Number of hours in a calendar day; defaults to 24'),
    eras: z.array(CalendarEraSchema).min(1).describe('Calendar eras'),
    months: z.array(CalendarMonthSchema).min(1).describe('Calendar months'),
  })
  .superRefine((calendar, ctx) => {
    const backwardsCount = calendar.eras.filter((era) => era.backwards === true).length;

    if (calendar.eras.length > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eras'],
        message:
          'Custom calendar eras support at most 2 eras: one backwards era and one forward era.',
      });
    }

    if (backwardsCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eras'],
        message: 'Custom calendar eras support at most one backwards: true era.',
      });
    }

    if (calendar.eras.length === 2 && backwardsCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eras'],
        message:
          'Custom calendars with 2 eras must define exactly one backwards: true era and one forward era.',
      });
    }
  });

/**
 * A single select option.
 * Either a bare value ("active") or an object that pairs the value with a
 * description ({ value: "active", description: "currently being worked on" }).
 * The object form lets the schema document what each option means; the bare
 * string form is preserved so existing schemas stay valid untouched.
 */
export const FieldOptionSchema = z.union([
  z.string(),
  z.object({
    value: z.string().describe('The option value stored in frontmatter'),
    description: z.string().optional().describe('What this option means / when to choose it'),
  }),
]);

/**
 * A virtual, record-local field calculated from other effective fields.
 * Derived values are projected at query time and are never written to note
 * frontmatter.
 */
export const DerivedFieldSchema = z.object({
  expression: z.string().min(1).describe('Expression evaluated for this record'),
  type: z
    .enum(['string', 'number', 'boolean', 'date'])
    .describe('Required result type for the derived expression'),
});

/**
 * Field definition for type frontmatter.
 * Fields can be static values, prompted inputs, relation queries, or virtual
 * record-local derivations.
 */
export const FieldSchema = z.object({
  // Virtual field calculated from the record's effective fields. The
  // dependency graph and expression semantics are validated after inheritance
  // and trait composition resolve the effective type.
  derived: DerivedFieldSchema.optional(),
  // Prompt type (how the field is collected)
  prompt: z
    .enum(['text', 'select', 'list', 'date', 'relative-date', 'relation', 'boolean', 'number'])
    .optional()
    .describe(
      'Type of prompt: text (free text), select (from options), relation (from vault query), list (comma-separated list), date (date picker), relative-date (constraints relative to another note date), boolean (yes/no), number (numeric input)'
    ),
  // Coarsest date precision allowed for `date` fields (finer is always allowed).
  // - day (default): full YYYY-MM-DD only
  // - month: YYYY-MM or YYYY-MM-DD (e.g. last-contact known to the month)
  // - year: YYYY, YYYY-MM, or YYYY-MM-DD (e.g. "around 2021")
  // Overrides the global config.date_granularity for this field.
  granularity: z
    .enum(['day', 'month', 'year'])
    .optional()
    .describe(
      'Coarsest date precision allowed for this `date` field, finer is always allowed (day = full YYYY-MM-DD, month = YYYY-MM or finer, year = YYYY or finer). Overrides the global config.date_granularity for this field.'
    ),
  calendar: z
    .string()
    .optional()
    .describe('Calendar id for date fields using config.calendars'),
  // Static value (no prompting)
  value: z
    .string()
    .optional()
    .describe('Static value (use $NOW for current datetime, $TODAY for date, or $ACTOR for logical runner provenance)'),
  // Human-readable description of what this field is for and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON); distinct from `label`, which
  // is the imperative prompt shown during input.
  description: z
    .string()
    .optional()
    .describe(
      'Human-readable description of what this field is for and when to use it. Surfaced by `bwrb schema list`; distinct from `label`.'
    ),
  // Inline options for select prompts (replaces global enums).
  // Each option is a bare value or a { value, description } pair.
  options: z
    .array(FieldOptionSchema)
    .optional()
    .describe(
      'Allowed values for select fields (inline options). Each entry is a bare value or a { value, description } pair that documents what the option means.'
    ),
  // Type name(s) for relation prompts (e.g., "milestone", "objective")
  // When specified, queryByType() fetches notes of this type (and descendants)
  // Can be an array to allow multiple valid types (e.g., for recursive types with extends)
  source: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Type name(s) for relation and relative-date prompts. When a relation\'s value is ambiguous because two notes share a name, path-qualify the link (e.g. `[[contexts/Betson]]`); see the canonical list resolution docs for the shortest-unambiguous-form rule.'
    ),
  // Filter conditions for type-based source queries
  // Applies frontmatter conditions to filter results (e.g., { status: { not_in: ["settled"] } })
  filter: z
    .record(FilterConditionSchema)
    .optional()
    .describe('Filter conditions for type-based source queries'),
  // Whether the field is required
  required: z
    .boolean()
    .optional()
    .describe('Whether this field is required (user cannot skip)'),
  // Default value
  default: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Default value if user skips the prompt'),
  // How list values are formatted in YAML
  list_format: z
    .enum(['yaml-array', 'comma-separated'])
    .optional()
    .describe('For list fields, how to format the list'),
  // Prompt label override
  label: z
    .string()
    .optional()
    .describe(
      'Label shown to user for input prompts (the imperative prompt text, e.g. "Select status"). Distinct from `description`, which explains what the field is for.'
    ),
  // Whether this field can hold multiple values (for context fields)
  multiple: z
    .boolean()
    .optional()
    .describe('Whether this field can hold multiple values'),
  // Whether children referenced by this field are owned (colocate with parent)
  owned: z
    .boolean()
    .optional()
    .describe('Whether children referenced by this field are owned (colocate with parent)'),
  // Field role: marks this field as holding the entity's aliases — alternate
  // names the entity is also known by. A recognized role (like `owned`) that
  // name-resolution and linking consult uniformly, so an entity is findable by
  // its aliases wherever it's findable by its name. The value must be an array
  // of non-empty, unique strings (Obsidian `aliases` format).
  alias: z
    .boolean()
    .optional()
    .describe(
      'Field role: marks this field as holding the entity\'s aliases (alternate names). bwrb consults aliases during name resolution and linking, so an entity is findable by its aliases wherever it is findable by its name. The value must be an array of non-empty, unique strings (Obsidian `aliases` format).'
    ),
  reset_on_fork: z
    .boolean()
    .optional()
    .describe(
      'When true, omit this field when copying a note into a fork so schema defaults can be applied to the new note.'
    ),
});

/**
 * Field names authored in a vault schema.
 *
 * `forked-from` is injected only by lineage-aware system workflows. Keeping the
 * restriction in the record key schema rejects it for both type and trait
 * fields and also carries the contract into the generated JSON Schema via
 * `propertyNames.pattern`.
 *
 * `id` is intentionally not restricted here: this change preserves the
 * existing schema contract for that older system field.
 */
const SchemaFieldNameSchema = z
  .string()
  .regex(
    /^(?!forked-from$).*$/,
    '"forked-from" is reserved and cannot be declared as a schema field'
  )
  .describe('Schema field name; "forked-from" is reserved for system-managed lineage');

// Body section definition
export const BodySectionSchema: z.ZodType<BodySection, z.ZodTypeDef, BodySectionInput> = z.lazy(() =>
  z.object({
    title: z.string().describe('Section heading text'),
    level: z
      .number()
      .int()
      .min(2)
      .max(6)
      .optional()
      .default(2)
      .describe('Heading level (2 = ##, 3 = ###, etc.)'),
    content_type: z
      .enum(['none', 'paragraphs', 'bullets', 'checkboxes'])
      .optional()
      .describe('Type of content placeholder to add'),
    prompt: z
      .enum(['none', 'list'])
      .optional()
      .describe('If set, prompts user for initial content during creation'),
    prompt_label: z.string().optional().describe('Label for the content prompt'),
    children: z.array(BodySectionSchema).optional().describe('Nested subsections'),
  })
);



// ============================================================================
// Trait Definition (Composition Model)
// ============================================================================

/**
 * Recurrence configuration carried by a trait (the `recurring` trait, #107).
 *
 * Declares event-driven, spawn-on-transition recurrence: "when a field
 * transitions to a value (e.g. `status` enters `done`), spawn a successor note
 * from a template, with the successor's date field offset from a predecessor
 * date field." No cron, no daemon, no LLM — the trigger is a field transition,
 * not a clock.
 *
 * Date rule is FIELD-OFFSET ONLY: `successor.<dateField> = <predecessor date
 * field> + <offset>` (e.g. `deadline + 7d`). The base must be a DATE field.
 * Transition-time offsets and calendar-anchored bases are intentionally not
 * supported (they cannot be reproduced identically across both execution paths).
 */
export const RecurrenceSchema = z.object({
  // The trigger transition, written as `<field> = <value>` (e.g. "status = done").
  // The successor is spawned when the trigger field transitions INTO this value.
  on: z
    .string()
    .describe(
      'Trigger transition, written as `<field> = <value>` (e.g. "status = done"). The successor is spawned when the trigger field transitions INTO this value.'
    ),
  // Template name to spawn the successor from. Defaults to the completed note's
  // type default template (a task begets a task). Naming a template can spawn a
  // different type (finish "draft" → spawn "review").
  template: z
    .string()
    .optional()
    .describe(
      'Template to spawn the successor from. Defaults to the completed note\'s type default template (a task begets a task). A named template can spawn a different type (finish "draft" -> spawn "review").'
    ),
  // Optional name template for the successor. When set, the successor's name is
  // this string interpolated with the SAME tokens used elsewhere — `{name}` (the
  // predecessor's name), `{date}` / `{date:FORMAT}` (today), and any predecessor
  // field `{field}` — then sanitized for a filename (e.g. "Review: {name}" →
  // "Review Chapter One"). This gives a cross-type successor a meaningful,
  // distinct name instead of a numeric suffix (#679). When unset, the
  // predecessor's name is carried forward as before. Vault-global basename
  // uniqueness (#632) is still enforced on the RESULT — if the interpolated name
  // also collides, a numeric suffix is appended on top.
  name_template: z
    .string()
    .optional()
    .describe(
      'Optional name template for the successor (#679). Interpolated with the same tokens as filename patterns -- {name} (the predecessor\'s name), {date} / {date:FORMAT} (today), and any predecessor field {field} -- then sanitized for a filename (e.g. "Review: {name}" -> "Review Chapter One"). Gives a cross-type successor a meaningful, distinct name instead of a numeric suffix. When omitted, the predecessor\'s name is carried forward. Vault-global basename uniqueness is still enforced on the result -- if the interpolated name also collides, a numeric suffix is appended on top.'
    ),
  // Field-offset assignments for the successor. Each value is a field-offset
  // expression `<dateField> <+|-> <duration>` (e.g. "deadline + 7d"). The base
  // must be a date field on the predecessor.
  set: z
    .record(z.string())
    .optional()
    .describe(
      'Field-offset assignments for the successor. Each value is a field-offset expression `<dateField> <+|-> <duration>` (e.g. "deadline + 7d"). The base must be a date field on the predecessor. Transition-time offsets and calendar-anchored bases are not supported.'
    ),
});

export type Recurrence = z.infer<typeof RecurrenceSchema>;

const TransitionPredicateSchema = z.object({
  field: SchemaFieldNameSchema,
  equals: z.string().optional(),
  in: z.array(z.string()).min(1).optional(),
}).refine((value) => (value.equals === undefined) !== (value.in === undefined), {
  message: 'A transition predicate requires exactly one of equals or in',
});

const TransitionRequirementSchema = z.object({
  relation: SchemaFieldNameSchema,
  min: z.number().int().min(1).optional(),
  all: TransitionPredicateSchema,
  failed_when: TransitionPredicateSchema.optional(),
  stale_when: TransitionPredicateSchema.optional(),
});

export const TransitionGuardSchema = z.object({
  on: z.string().min(1),
  requires: z.array(TransitionRequirementSchema).min(1),
});
export type TransitionGuard = z.infer<typeof TransitionGuardSchema>;

/** A bounded direct-relation patch applied when a source field enters a value. */
export const TransitionEffectSchema = z.object({
  on: z.string().min(1),
  relation: SchemaFieldNameSchema,
  // String-only means patches stay flat literals. The transition executor
  // expands only $ACTOR, $NOW, and $TODAY at commit time.
  set: z.record(z.string(), z.string()).refine((set) => Object.keys(set).length > 0, {
    message: 'A transition effect requires at least one field assignment',
  }),
});
export type TransitionEffect = z.infer<typeof TransitionEffectSchema>;

/** A type-local, explicit policy for records that have reached their end of life. */
export const RetentionSchema = z.object({
  when: z.record(z.object({ in: z.array(z.string()).min(1) })).refine(v => Object.keys(v).length > 0, {
    message: 'Retention when requires at least one field condition',
  }),
  clock: z.object({
    field: SchemaFieldNameSchema,
    after: z.string().regex(/^([1-9]\d*)d$/, 'Retention clock.after must be a positive whole-day duration such as "180d"'),
  }),
  resolved_when: z.record(z.object({ in: z.array(z.string()).min(1) })).optional(),
  actions: z.array(z.union([
    z.object({ kind: z.literal('archive'), directory: z.string().min(1) }),
    z.object({ kind: z.literal('tombstone'), set: z.record(z.string(), z.string()).refine(v => Object.keys(v).length > 0) }),
    z.object({ kind: z.literal('delete') }),
  ])).min(1),
});
export type Retention = z.infer<typeof RetentionSchema>;

/**
 * A reusable bundle of fields composed into a type via `traits`.
 *
 * Traits are *composition* ("also-has") alongside `extends` *inheritance*
 * ("is-a"). Cross-cutting field bundles — status + due dates, scope, rating —
 * are the pattern inheritance models badly, so traits let you define them once
 * and mix them into unrelated type families.
 *
 * Traits are flat: a trait carries only `fields` (and an optional
 * `description`), plus — for the `recurring` trait — an optional `recurrence`
 * block (#107). A trait cannot extend a type or compose other traits, which
 * keeps resolution deterministic and easy to reason about.
 */
export const TraitSchema = z.object({
  // Human-readable description of what this trait bundles and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON).
  description: z
    .string()
    .optional()
    .describe(
      'Human-readable description of what this trait bundles and when to use it. Surfaced by `bwrb schema list`.'
    ),
  // Field definitions contributed by this trait.
  fields: z
    .record(SchemaFieldNameSchema, FieldSchema)
    .optional()
    .describe('Field definitions contributed by this trait'),
  // Recurrence configuration (spawn-on-transition). When present, types that
  // compose this trait gain event-driven successor spawning. See RecurrenceSchema.
  recurrence: RecurrenceSchema.optional(),
  // Relation-backed invariants evaluated when a note enters a configured value.
  transition_guards: z.array(TransitionGuardSchema).optional(),
  // Direct related-note patches evaluated when a note enters a configured value.
  transition_effects: z.array(TransitionEffectSchema).optional(),
});

// ============================================================================
// Type Definition (New Inheritance Model)
// ============================================================================

/**
 * Type definition with inheritance support.
 * 
 * Key differences from legacy model:
 * - Flat structure with 'extends' instead of nested 'subtypes'
 * - 'fields' instead of 'frontmatter'
 * - 'field_order' instead of 'frontmatter_order'
 * - Single 'type' field in frontmatter (no more '{type}-type' pattern)
 */
export const TypeSchema = z.object({
  // Parent type name (implicit 'meta' if not specified)
  extends: z
    .string()
    .optional()
    .describe(
      "Parent type name (implicit 'meta' if not specified). Single-parent is-a inheritance."
    ),
  // Trait names composed into this type (composition, alongside `extends`).
  // `extends` is *is-a* (single-parent inheritance); `traits` are *also-has*
  // (multiple reusable field bundles). Resolved at load time into the type's
  // effective fields. See `TraitSchema` and the resolver for precedence.
  traits: z
    .array(z.string())
    .optional()
    .describe(
      'Trait names composed into this type (composition alongside `extends`). Precedence: own fields > traits > inherited; later traits in the array win over earlier ones.'
    ),
  // Human-readable description of what this type is for and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON).
  description: z
    .string()
    .optional()
    .describe(
      'Human-readable description of what this type is for and when to use it. Surfaced by `bwrb schema list`.'
    ),
  // Field definitions (merged with ancestors at load time)
  fields: z
    .record(SchemaFieldNameSchema, FieldSchema)
    .optional()
    .describe('Field definitions, merged with ancestors and traits at load time'),
  calendar_default: z
    .string()
    .optional()
    .describe('Default calendar id for date fields on this type'),
  // Explicit field ordering (optional - defaults to definition order)
  field_order: z
    .array(z.string())
    .optional()
    .describe('Explicit field ordering (optional; defaults to definition order)'),
  // Body section definitions
  body_sections: z
    .array(BodySectionSchema)
    .optional()
    .describe('Body section definitions generated after frontmatter'),
  // Whether this type can contain instances of itself
  recursive: z
    .boolean()
    .optional()
    .describe('Whether this type can contain instances of itself'),
  // Output directory (computed from hierarchy if not specified)
  output_dir: z
    .string()
    .optional()
    .describe(
      'Directory path relative to vault root where files of this type are created (computed from hierarchy if not specified)'
    ),
  // Filename pattern
  filename: z.string().optional().describe('Filename pattern'),
  // Custom plural form for folder naming (e.g., "research" instead of "researches")
  // If not specified, auto-pluralization is used (add 's', handle 'y' -> 'ies', etc.)
  plural: z
    .string()
    .optional()
    .describe(
      "Custom plural form for folder naming (e.g., 'research' instead of 'researches'). Auto-pluralized if not specified."
    ),
  retention: RetentionSchema.optional().describe('Type-local retention policy evaluated by audit'),
});

// ============================================================================
// Audit Configuration
// ============================================================================

export const AuditConfigSchema = z.object({
  allowed_extra_fields: z
    .array(z.string())
    .optional()
    .describe('Extra frontmatter fields that are allowed without warning'),
});

// ============================================================================
// Vault Configuration
// ============================================================================

/**
 * Vault-wide configuration options.
 * These settings apply to the entire vault and control CLI behavior.
 */
export const ConfigSchema = z.object({
  identity_store: z
    .enum(['registry-v1', 'frontmatter-v1'])
    .optional()
    .describe(
      'Stable note identity storage: legacy shared registry or authoritative per-note frontmatter'
    ),
  // Link format for relation fields in frontmatter
  // wikilink: "[[Note Name]]" (default, Obsidian-compatible)
  // markdown: "[Note Name](Note Name.md)"
  link_format: z
    .enum(['wikilink', 'markdown'])
    .optional()
    .describe(
      'Link format for relation fields: wikilink ("[[Note]]") or markdown ("[Note](Note.md)")'
    ),
  // Terminal editor command (defaults to $EDITOR)
  editor: z.string().optional().describe('Terminal editor command (defaults to $EDITOR)'),
  // GUI editor command (defaults to $VISUAL)
  visual: z.string().optional().describe('GUI editor command (defaults to $VISUAL)'),
  // Default behavior for --open flag
  // system: Open with OS default handler (default)
  // editor: Open in terminal editor ($EDITOR)
  // visual: Open in GUI editor ($VISUAL)
  // obsidian: Open via Obsidian URI
  open_with: z
    .enum(['system', 'editor', 'visual', 'obsidian'])
    .optional()
    .describe('Default behavior for --open flag'),
  // Obsidian vault name for URI scheme (auto-detected from .obsidian if not set)
  obsidian_vault: z
    .string()
    .optional()
    .describe('Obsidian vault name for URI scheme (auto-detected if not set)'),
  // Default dashboard to run when `bwrb dashboard` is called without arguments
  default_dashboard: z
    .string()
    .optional()
    .describe('Dashboard to run when `bwrb dashboard` is called without arguments'),
  // Directories to exclude from all discovery/targeting operations
  // Values are vault-root-relative directory prefixes (e.g., "Archive", "Templates", "Archive/Old")
  excluded_directories: z
    .array(z.string())
    .optional()
    .describe(
      'Vault-root-relative directory prefixes excluded from all discovery/targeting operations (e.g., "Archive", "Templates")'
    ),
  // Date format for date fields in frontmatter
  // YYYY-MM-DD: ISO 8601 format (default)
  // MM/DD/YYYY: US format
  // DD/MM/YYYY: EU format
  // DD-MM-YYYY: EU format with dashes
  // Custom patterns using YYYY, MM, DD tokens are also supported
  date_format: z
    .string()
    .optional()
    .describe(
      'Generated full-date and parsing pattern (YYYY, MM, DD tokens); Gregorian date fields are stored canonically as ISO, e.g. YYYY-MM-DD (default), MM/DD/YYYY, DD-MM-YYYY'
    ),
  // Default coarsest date precision allowed for all `date` fields.
  // - day (default): full YYYY-MM-DD only
  // - month: YYYY-MM or finer
  // - year: YYYY or finer
  // Per-field `granularity` overrides this default.
  date_granularity: z
    .enum(['day', 'month', 'year'])
    .optional()
    .describe(
      'Default coarsest date precision allowed for all date fields (day = full YYYY-MM-DD, month = YYYY-MM or finer, year = YYYY or finer). Per-field `granularity` overrides this default.'
    ),
  calendars: z
    .record(CalendarSchema)
    .optional()
    .describe('Named custom calendars available to date fields'),
  // Max Levenshtein distance cap for the `unlinked-mention` audit fuzzy ("did
  // you mean?") tier (#622). Integer 0-5; default 2. The effective distance is
  // also length-scaled. 0 disables the fuzzy tier. Overridden per run by
  // `--mention-fuzzy-threshold` / `--no-mention-fuzzy`.
  mention_fuzzy_threshold: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(
      'Max Levenshtein distance cap for the `unlinked-mention` audit fuzzy ("did you mean?") tier (#622). Integer 0-5; default 2. The effective distance is also length-scaled. 0 disables the fuzzy tier. Overridden per run by `--mention-fuzzy-threshold` / `--no-mention-fuzzy`.'
    ),
  // Corpus-calibrated commonness for single-word note names (#783). Enabled by
  // default: during audit, bwrb counts each word's prose casing across the full
  // vault snapshot and drops single-word name surfaces that are common in this
  // vault mostly without proper-noun casing. Aliases remain exempt.
  mention_corpus_calibration: z
    .boolean()
    .optional()
    .describe(
      'Enable corpus-calibrated commonness damping for single-word `unlinked-mention` note names (#783). Defaults to true. When enabled, audit uses full-vault prose casing stats to drop vault-common name surfaces while leaving declared aliases exempt.'
    ),
  mention_corpus_min_notes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Minimum distinct non-self notes whose prose must contain a single-word note name before corpus-calibrated commonness damping can apply (#783). Defaults to 3.'
    ),
  mention_corpus_noncanonical_ratio: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Strict non-canonical-case occurrence share threshold for corpus-calibrated commonness damping (#783). Defaults to 0.5, so exactly half non-canonical keeps the surface.'
    ),
  // First-occurrence-only auto-link mode for `unlinked-mention` fixes (#785).
  // Detection remains exhaustive; this only limits `audit --fix --auto` writes.
  mention_link_once: z
    .boolean()
    .optional()
    .describe(
      'When true, `audit --fix --auto` writes at most one new `unlinked-mention` wikilink per note/target pair, and writes none when the note already contains a wikilink to that target. Defaults to false; overridden per run by `--mention-link-once` / `--no-mention-link-once`.'
    ),
  // Type names to exclude as targets from the mention safety-net index. Notes
  // whose resolved type is listed, or extends a listed type, are still scanned
  // as source documents, but their names and aliases are not link targets,
  // fuzzy suggestions, or frequent-unlinked-term nudges.
  mention_exclude_types: z
    .array(z.string())
    .optional()
    .describe(
      'Type names to exclude as targets from the mention safety-net index. Notes whose resolved type is listed, or extends a listed type, are still scanned as source documents, but their names and aliases are not link targets, fuzzy suggestions, or frequent-unlinked-term nudges.'
    ),
  // Vault-relative glob patterns to exclude as targets from the mention
  // safety-net index. Matching notes are still scanned as source documents, but
  // their names and aliases are not link targets, fuzzy suggestions, or
  // frequent-unlinked-term nudges.
  mention_exclude_paths: z
    .array(z.string())
    .optional()
    .describe(
      'Vault-relative glob patterns to exclude as targets from the mention safety-net index. Matching notes are still scanned as source documents, but their names and aliases are not link targets, fuzzy suggestions, or frequent-unlinked-term nudges.'
    ),
});

// ============================================================================
// Root Schema
// ============================================================================

/**
 * Bowerbird schema - the root configuration for a vault.
 * 
 * Version 2 uses the new inheritance model:
 * - Flat types with 'extends' for inheritance
 * - 'fields' instead of 'frontmatter'
 * - Implicit 'meta' root type
 * - Type-based 'source' on fields (no more dynamic_sources)
 */
export const BwrbSchema = z.object({
  // JSON Schema reference for editor support
  $schema: z
    .string()
    .optional()
    .describe('Reference to this JSON Schema for editor support'),
  // Schema format version (2 = inheritance model)
  version: z
    .number()
    .int()
    .optional()
    .default(2)
    .describe('Schema format version (2 = inheritance model)'),
  // User-controlled schema content version for migrations (semver)
  // This tracks the evolution of your schema over time
  schemaVersion: z
    .string()
    .optional()
    .describe('User-controlled schema content version for migrations (semver)'),
  // Vault-wide configuration
  config: ConfigSchema.optional(),
  // Reusable field bundles composed into types via each type's `traits` array.
  // Optional: schemas without traits are unchanged.
  traits: z
    .record(TraitSchema)
    .optional()
    .describe(
      "Reusable field bundles composed into types via each type's `traits` array. Composition (`also-has`) alongside `extends` inheritance (`is-a`). Optional; schemas without traits are unchanged."
    ),
  // Type definitions (flat with 'extends')
  types: z.record(TypeSchema).describe('Type definitions with inheritance support'),
  // Audit configuration
  audit: AuditConfigSchema.optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type Field = z.infer<typeof FieldSchema>;
export type DerivedField = z.infer<typeof DerivedFieldSchema>;
export type FieldOption = z.infer<typeof FieldOptionSchema>;
export type Calendar = z.infer<typeof CalendarSchema>;
export type CalendarEra = z.infer<typeof CalendarEraSchema>;
export type CalendarMonth = z.infer<typeof CalendarMonthSchema>;

/**
 * Extract the bare value strings from a field's options, regardless of whether
 * each option is a plain string or a { value, description } object.
 */
export function getOptionValues(options: FieldOption[] | undefined): string[] {
  if (!options) return [];
  return options.map((option) => (typeof option === 'string' ? option : option.value));
}

/**
 * Look up the description for a specific option value, if one was provided.
 * Returns undefined for bare-string options or unknown values.
 */
export function getOptionDescription(
  options: FieldOption[] | undefined,
  value: string
): string | undefined {
  if (!options) return undefined;
  for (const option of options) {
    if (typeof option !== 'string' && option.value === value) {
      return option.description;
    }
  }
  return undefined;
}
export type BodySection = {
  title: string;
  level?: number | undefined;
  content_type?: 'none' | 'paragraphs' | 'bullets' | 'checkboxes' | undefined;
  prompt?: 'none' | 'list' | undefined;
  prompt_label?: string | undefined;
  children?: BodySection[] | undefined;
};
export type BodySectionInput = {
  title: string;
  level?: number | undefined;
  content_type?: 'none' | 'paragraphs' | 'bullets' | 'checkboxes' | undefined;
  prompt?: 'none' | 'list' | undefined;
  prompt_label?: string | undefined;
  children?: BodySectionInput[] | undefined;
};
export type FilterCondition = z.infer<typeof FilterConditionSchema>;
export type Trait = z.infer<typeof TraitSchema>;
export type Type = z.infer<typeof TypeSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type Schema = z.infer<typeof BwrbSchema>;

// ============================================================================
// Resolved Type (Computed at Load Time)
// ============================================================================

/**
 * A resolved type with computed inheritance.
 * This is created by the schema loader after parsing the raw schema.
 */
export interface ResolvedType {
  /** Type name (unique identifier) */
  name: string;
  /** Human-readable description of what this type is for, if declared */
  description: string | undefined;
  /** Parent type name (undefined only for 'meta') */
  parent: string | undefined;
  /** Trait names composed into this type, in declaration order */
  traits: string[];
  /** Direct child type names */
  children: string[];
  /** Computed effective fields (merged from ancestors) */
  fields: Record<string, Field>;
  /** Field ordering */
  fieldOrder: string[];
  /** Default calendar id for this type's date fields */
  calendarDefault: string | undefined;
  /** Body section definitions */
  bodySections: BodySection[];
  /** Whether this type can self-nest */
  recursive: boolean;
  /** Output directory (explicit or computed) */
  outputDir: string | undefined;
  /** Filename pattern */
  filename: string | undefined;
  /** List of ancestor type names (parent first, meta last) */
  ancestors: string[];
  /** Plural form for folder naming (computed: custom or auto-pluralized) */
  plural: string;
}

/**
 * Resolved configuration with defaults applied.
 */
export interface ResolvedConfig {
  /** Stable note identity storage (omitted legacy vaults remain registry-v1). */
  identityStore: 'registry-v1' | 'frontmatter-v1';
  /** Link format for relation fields: 'wikilink' or 'markdown' */
  linkFormat: 'wikilink' | 'markdown';
  /** Terminal editor command (from config or $EDITOR) */
  editor: string | undefined;
  /** GUI editor command (from config or $VISUAL) */
  visual: string | undefined;
  /** Default behavior for --open flag */
  openWith: 'system' | 'editor' | 'visual' | 'obsidian';
  /** Obsidian vault name (from config or auto-detected) */
  obsidianVault: string | undefined;
  /** Default dashboard to run when `bwrb dashboard` is called without arguments */
  defaultDashboard: string | undefined;
  /** Date format for date fields (defaults to 'YYYY-MM-DD') */
  dateFormat: string;
  /** Default coarsest date precision allowed for date fields (defaults to 'day') */
  dateGranularity: 'day' | 'month' | 'year';
  /** Named custom calendars available to date fields */
  calendars: Record<string, Calendar>;
  /**
   * Max Levenshtein distance cap for the `unlinked-mention` audit fuzzy tier
   * (#622). Defaults to 2. A CLI flag (`--mention-fuzzy-threshold`) overrides
   * this; candidate length also caps the effective distance.
   */
  mentionFuzzyThreshold: number;
  /**
   * Enable corpus-calibrated commonness damping for single-word
   * `unlinked-mention` note names (#783). Defaults to true.
   */
  mentionCorpusCalibration: boolean;
  /**
   * Minimum distinct non-self notes containing a word before corpus damping can
   * apply. Defaults to 3.
   */
  mentionCorpusMinNotes: number;
  /**
   * Strict non-canonical-case share threshold for corpus damping. Defaults to
   * 0.5, so exactly half non-canonical keeps the surface.
   */
  mentionCorpusNonCanonicalRatio: number;
  /**
   * When true, `audit --fix --auto` writes at most one new unlinked-mention
   * wikilink per note/target pair and treats pre-existing wikilinks as covered.
   * Defaults to false to preserve historical "link every eligible occurrence"
   * behavior.
   */
  mentionLinkOnce: boolean;
  /**
   * Canonical type names excluded as mention targets. Descendants of these
   * types are excluded by the mention index builder.
   */
  mentionExcludeTypes: string[];
  /**
   * Vault-relative path globs excluded as mention targets.
   */
  mentionExcludePaths: string[];
}

/**
 * A loaded schema with resolved inheritance tree.
 */
export interface LoadedSchema {
  /** Original raw schema */
  raw: Schema;
  /** Resolved types indexed by name */
  types: Map<string, ResolvedType>;
  /** Ownership relationships: which types can own which child types */
  ownership: OwnershipMap;
  /** Resolved configuration with defaults */
  config: ResolvedConfig;
}

// ============================================================================
// Ownership Types
// ============================================================================

/**
 * Information about an owned field on a parent type.
 * The parent declares ownership via `owned: true` on a field.
 */
export interface OwnedFieldInfo {
  /** The field name on the owner type (e.g., "research") */
  fieldName: string;
  /** The owner type name (e.g., "draft") */
  ownerType: string;
  /** The child type that can be owned (from field.source) */
  childType: string;
  /** Whether the field can hold multiple values */
  multiple: boolean;
}

/**
 * Information about how a child type can be owned.
 * Computed from schema for quick lookup.
 */
export interface OwnerInfo {
  /** Type that can own this child type */
  ownerType: string;
  /** Field on owner that declares ownership */
  fieldName: string;
  /** Whether the owner can have multiple of this child */
  multiple: boolean;
}

/**
 * Map of ownership relationships in the schema.
 * Enables quick lookup of "who can own this type?" and "what does this type own?"
 */
export interface OwnershipMap {
  /** Map from child type → list of possible owners */
  canBeOwnedBy: Map<string, OwnerInfo[]>;
  /** Map from owner type → list of owned field info */
  owns: Map<string, OwnedFieldInfo[]>;
}

// ============================================================================
// Template Types
// ============================================================================

/**
 * Constraint definition for template fields.
 * Constraints allow templates to enforce stricter validation than the base schema.
 */
export const ConstraintSchema = z.object({
  /** Make an optional field required for this template */
  required: z.boolean().optional(),
  /** Expression that must evaluate to true; 'this' refers to the field value */
  validate: z.string().optional(),
  /** Custom error message when validation fails */
  error: z.string().optional(),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

/**
 * Instance scaffold definition for parent templates.
 * Allows creating multiple related files when creating an instance-grouped parent.
 */
export const InstanceScaffoldSchema = z.object({
  /** Which type to create (e.g., "chapter", "research") */
  type: z.string(),
  /** Override the default filename */
  filename: z.string().optional(),
  /** Template name to use for this instance */
  template: z.string().optional(),
  /** Additional defaults for this instance */
  defaults: z.record(z.unknown()).optional(),
});

export type InstanceScaffold = z.infer<typeof InstanceScaffoldSchema>;

/**
 * Template frontmatter schema.
 * Templates are markdown files with special frontmatter that define defaults,
 * body structure, and other properties for note creation.
 */
export const TemplateFrontmatterSchema = z.object({
  type: z.literal('template'),
  // Type name this template is for (e.g., "task")
  'template-for': z.string(),
  description: z.string().optional(),
  defaults: z.record(z.unknown()).optional(),
  constraints: z.record(ConstraintSchema).optional(),
  'prompt-fields': z.array(z.string()).optional(),
  'filename-pattern': z.string().optional(),
  instances: z.array(InstanceScaffoldSchema).optional(),
});

export type TemplateFrontmatter = z.infer<typeof TemplateFrontmatterSchema>;

/**
 * Parsed template with all relevant data.
 */
export interface Template {
  /** Full file path to the template */
  path: string;
  /** Template name (filename without .md) */
  name: string;
  /** Type name this template is for (e.g., "task") */
  templateFor: string;
  /** Human-readable description */
  description?: string;
  /** Default field values */
  defaults?: Record<string, unknown>;
  /** Field constraints (validation rules stricter than schema) */
  constraints?: Record<string, Constraint>;
  /** Fields to always prompt for, even with defaults */
  promptFields?: string[];
  /** Override filename pattern */
  filenamePattern?: string;
  /** Instance scaffolding for parent templates */
  instances?: InstanceScaffold[];
  /** Template body content (markdown after frontmatter) */
  body: string;
}

// ============================================================================
// Dashboard Types
// ============================================================================

/**
 * Dashboard definition - a saved list query.
 * All fields are optional; a dashboard with no fields will list all notes.
 */
export const DashboardDefinitionSchema = z.object({
  /** Type filter (e.g., "task", "objective/milestone") */
  type: z.string().optional(),
  /** Glob pattern for file paths (e.g., "Projects/**") */
  path: z.string().optional(),
  /** Filter expressions (same as --where in list command) */
  where: z.array(z.string()).optional(),
  /** Body content search query */
  body: z.string().optional(),
  /** Default output format */
  output: z.enum(['default', 'text', 'paths', 'tree', 'link', 'content', 'json']).optional(),
  /** Fields to display in table output */
  fields: z.array(z.string()).optional(),
  /** Limit output to the first n matching notes */
  limit: z.number().int().positive().optional(),
  /** Print only the number of matching notes */
  count: z.boolean().optional(),
  /** Sort output by a frontmatter/display field */
  sort: z.string().optional(),
  /** Sort descending when sort is present */
  desc: z.boolean().optional(),
});

export type DashboardDefinition = z.infer<typeof DashboardDefinitionSchema>;

/**
 * Dashboards file schema (.bwrb/dashboards.json).
 * Contains all saved dashboards for a vault.
 */
export const DashboardsFileSchema = z.object({
  dashboards: z.record(DashboardDefinitionSchema),
});

export type DashboardsFile = z.infer<typeof DashboardsFileSchema>;
