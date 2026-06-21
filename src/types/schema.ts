import { z } from 'zod';

// ============================================================================
// Field Definition
// ============================================================================

// Filter condition for type-based source queries
export const FilterConditionSchema = z.object({
  equals: z.string().optional(),
  not_equals: z.string().optional(),
  in: z.array(z.string()).optional(),
  not_in: z.array(z.string()).optional(),
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
    value: z.string(),
    description: z.string().optional(),
  }),
]);

/**
 * Field definition for type frontmatter.
 * Fields can be static values, prompted inputs, or relation queries.
 */
export const FieldSchema = z.object({
  // Prompt type (how the field is collected)
  prompt: z.enum(['text', 'select', 'list', 'date', 'relation', 'boolean', 'number']).optional(),
  // Coarsest date precision allowed for `date` fields (finer is always allowed).
  // - day (default): full YYYY-MM-DD only
  // - month: YYYY-MM or YYYY-MM-DD (e.g. last-contact known to the month)
  // - year: YYYY, YYYY-MM, or YYYY-MM-DD (e.g. "around 2021")
  // Overrides the global config.date_granularity for this field.
  granularity: z.enum(['day', 'month', 'year']).optional(),
  // Static value (no prompting)
  value: z.string().optional(),
  // Human-readable description of what this field is for and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON); distinct from `label`, which
  // is the imperative prompt shown during input.
  description: z.string().optional(),
  // Inline options for select prompts (replaces global enums).
  // Each option is a bare value or a { value, description } pair.
  options: z.array(FieldOptionSchema).optional(),
  // Type name(s) for relation prompts (e.g., "milestone", "objective")
  // When specified, queryByType() fetches notes of this type (and descendants)
  // Can be an array to allow multiple valid types (e.g., for recursive types with extends)
  source: z.union([z.string(), z.array(z.string())]).optional(),
  // Filter conditions for type-based source queries
  // Applies frontmatter conditions to filter results (e.g., { status: { not_in: ["settled"] } })
  filter: z.record(FilterConditionSchema).optional(),
  // Whether the field is required
  required: z.boolean().optional(),
  // Default value
  default: z.union([z.string(), z.array(z.string())]).optional(),
  // How list values are formatted in YAML
  list_format: z.enum(['yaml-array', 'comma-separated']).optional(),
  // Prompt label override
  label: z.string().optional(),
  // Whether this field can hold multiple values (for context fields)
  multiple: z.boolean().optional(),
  // Whether children referenced by this field are owned (colocate with parent)
  owned: z.boolean().optional(),
  // Field role: marks this field as holding the entity's aliases — alternate
  // names the entity is also known by. A recognized role (like `owned`) that
  // name-resolution and linking consult uniformly, so an entity is findable by
  // its aliases wherever it's findable by its name. The value must be an array
  // of non-empty, unique strings (Obsidian `aliases` format).
  alias: z.boolean().optional(),
});

// Body section definition
export const BodySectionSchema: z.ZodType<BodySection, z.ZodTypeDef, BodySectionInput> = z.lazy(() =>
  z.object({
    title: z.string(),
    level: z.number().optional().default(2),
    content_type: z.enum(['none', 'paragraphs', 'bullets', 'checkboxes']).optional(),
    prompt: z.enum(['none', 'list']).optional(),
    prompt_label: z.string().optional(),
    children: z.array(BodySectionSchema).optional(),
  })
);



// ============================================================================
// Trait Definition (Composition Model)
// ============================================================================

/**
 * A reusable bundle of fields composed into a type via `traits`.
 *
 * Traits are *composition* ("also-has") alongside `extends` *inheritance*
 * ("is-a"). Cross-cutting field bundles — status + due dates, scope, rating —
 * are the pattern inheritance models badly, so traits let you define them once
 * and mix them into unrelated type families.
 *
 * Traits are flat: a trait carries only `fields` (and an optional
 * `description`). A trait cannot extend a type or compose other traits, which
 * keeps resolution deterministic and easy to reason about.
 */
export const TraitSchema = z.object({
  // Human-readable description of what this trait bundles and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON).
  description: z.string().optional(),
  // Field definitions contributed by this trait.
  fields: z.record(FieldSchema).optional(),
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
  extends: z.string().optional(),
  // Trait names composed into this type (composition, alongside `extends`).
  // `extends` is *is-a* (single-parent inheritance); `traits` are *also-has*
  // (multiple reusable field bundles). Resolved at load time into the type's
  // effective fields. See `TraitSchema` and the resolver for precedence.
  traits: z.array(z.string()).optional(),
  // Human-readable description of what this type is for and when to use it.
  // Surfaced by `bwrb schema list` (text + JSON).
  description: z.string().optional(),
  // Field definitions (merged with ancestors at load time)
  fields: z.record(FieldSchema).optional(),
  // Explicit field ordering (optional - defaults to definition order)
  field_order: z.array(z.string()).optional(),
  // Body section definitions
  body_sections: z.array(BodySectionSchema).optional(),
  // Whether this type can contain instances of itself
  recursive: z.boolean().optional(),
  // Output directory (computed from hierarchy if not specified)
  output_dir: z.string().optional(),
  // Filename pattern
  filename: z.string().optional(),
  // Custom plural form for folder naming (e.g., "research" instead of "researches")
  // If not specified, auto-pluralization is used (add 's', handle 'y' -> 'ies', etc.)
  plural: z.string().optional(),
});

// ============================================================================
// Audit Configuration
// ============================================================================

export const AuditConfigSchema = z.object({
  ignored_directories: z.array(z.string()).optional(),
  allowed_extra_fields: z.array(z.string()).optional(),
});

// ============================================================================
// Vault Configuration
// ============================================================================

/**
 * Vault-wide configuration options.
 * These settings apply to the entire vault and control CLI behavior.
 */
export const ConfigSchema = z.object({
  // Link format for relation fields in frontmatter
  // wikilink: "[[Note Name]]" (default, Obsidian-compatible)
  // markdown: "[Note Name](Note Name.md)"
  link_format: z.enum(['wikilink', 'markdown']).optional(),
  // Terminal editor command (defaults to $EDITOR)
  editor: z.string().optional(),
  // GUI editor command (defaults to $VISUAL)
  visual: z.string().optional(),
  // Default behavior for --open flag
  // system: Open with OS default handler (default)
  // editor: Open in terminal editor ($EDITOR)
  // visual: Open in GUI editor ($VISUAL)
  // obsidian: Open via Obsidian URI
  open_with: z.enum(['system', 'editor', 'visual', 'obsidian']).optional(),
  // Obsidian vault name for URI scheme (auto-detected from .obsidian if not set)
  obsidian_vault: z.string().optional(),
  // Default dashboard to run when `bwrb dashboard` is called without arguments
  default_dashboard: z.string().optional(),
  // Directories to exclude from all discovery/targeting operations
  // Values are vault-root-relative directory prefixes (e.g., "Archive", "Templates", "Archive/Old")
  excluded_directories: z.array(z.string()).optional(),
  // Date format for date fields in frontmatter
  // YYYY-MM-DD: ISO 8601 format (default)
  // MM/DD/YYYY: US format
  // DD/MM/YYYY: EU format
  // DD-MM-YYYY: EU format with dashes
  // Custom patterns using YYYY, MM, DD tokens are also supported
  date_format: z.string().optional(),
  // Default coarsest date precision allowed for all `date` fields.
  // - day (default): full YYYY-MM-DD only
  // - month: YYYY-MM or finer
  // - year: YYYY or finer
  // Per-field `granularity` overrides this default.
  date_granularity: z.enum(['day', 'month', 'year']).optional(),
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
  $schema: z.string().optional(),
  // Schema format version (2 = inheritance model)
  version: z.number().optional().default(2),
  // User-controlled schema content version for migrations (semver)
  // This tracks the evolution of your schema over time
  schemaVersion: z.string().optional(),
  // Vault-wide configuration
  config: ConfigSchema.optional(),
  // Reusable field bundles composed into types via each type's `traits` array.
  // Optional: schemas without traits are unchanged.
  traits: z.record(TraitSchema).optional(),
  // Type definitions (flat with 'extends')
  types: z.record(TypeSchema),
  // Audit configuration
  audit: AuditConfigSchema.optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type Field = z.infer<typeof FieldSchema>;
export type FieldOption = z.infer<typeof FieldOptionSchema>;

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
  output: z.enum(['default', 'text', 'paths', 'tree', 'link', 'json']).optional(),
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
