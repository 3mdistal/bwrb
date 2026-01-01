import { z } from 'zod';

// ============================================================================
// Field Definition
// ============================================================================

/**
 * Field definition for type frontmatter.
 * Fields can be static values, prompted inputs, or dynamic queries.
 */
export const FieldSchema = z.object({
  // Prompt type (how the field is collected)
  prompt: z.enum(['input', 'select', 'multi-input', 'date', 'dynamic']).optional(),
  // Static value (no prompting)
  value: z.string().optional(),
  // Enum reference for select prompts
  enum: z.string().optional(),
  // Type name for dynamic prompts (replaces dynamic_sources)
  source: z.string().optional(),
  // Whether the field is required
  required: z.boolean().optional(),
  // Default value
  default: z.union([z.string(), z.array(z.string())]).optional(),
  // How list values are formatted in YAML
  list_format: z.enum(['yaml-array', 'comma-separated']).optional(),
  // Prompt label override
  label: z.string().optional(),
  // Wikilink formatting
  format: z.enum(['plain', 'wikilink', 'quoted-wikilink']).optional(),
  // Whether this field can hold multiple values (for context fields)
  multiple: z.boolean().optional(),
  // Whether children referenced by this field are owned (colocate with parent)
  owned: z.boolean().optional(),
});

// Body section definition
export const BodySectionSchema: z.ZodType<BodySection, z.ZodTypeDef, BodySectionInput> = z.lazy(() =>
  z.object({
    title: z.string(),
    level: z.number().optional().default(2),
    content_type: z.enum(['none', 'paragraphs', 'bullets', 'checkboxes']).optional(),
    prompt: z.enum(['none', 'multi-input']).optional(),
    prompt_label: z.string().optional(),
    children: z.array(BodySectionSchema).optional(),
  })
);

// ============================================================================
// Dynamic Sources (Legacy - to be deprecated)
// ============================================================================

// Filter condition for dynamic sources
export const FilterConditionSchema = z.object({
  equals: z.string().optional(),
  not_equals: z.string().optional(),
  in: z.array(z.string()).optional(),
  not_in: z.array(z.string()).optional(),
});

// Dynamic source definition (legacy - will be replaced by type-based sources)
export const DynamicSourceSchema = z.object({
  dir: z.string(),
  filter: z.record(FilterConditionSchema).optional(),
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
// Root Schema
// ============================================================================

/**
 * Pika schema - the root configuration for a vault.
 * 
 * Version 2 uses the new inheritance model:
 * - Flat types with 'extends' for inheritance
 * - 'fields' instead of 'frontmatter'
 * - Implicit 'meta' root type
 */
export const PikaSchema = z.object({
  // Schema version (2 = inheritance model)
  version: z.number().optional().default(2),
  // Enum definitions
  enums: z.record(z.array(z.string())).optional(),
  // Dynamic sources (legacy - for backward compatibility)
  dynamic_sources: z.record(DynamicSourceSchema).optional(),
  // Type definitions (flat with 'extends')
  types: z.record(TypeSchema),
  // Audit configuration
  audit: AuditConfigSchema.optional(),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type Field = z.infer<typeof FieldSchema>;
export type BodySection = {
  title: string;
  level?: number | undefined;
  content_type?: 'none' | 'paragraphs' | 'bullets' | 'checkboxes' | undefined;
  prompt?: 'none' | 'multi-input' | undefined;
  prompt_label?: string | undefined;
  children?: BodySection[] | undefined;
};
export type BodySectionInput = {
  title: string;
  level?: number | undefined;
  content_type?: 'none' | 'paragraphs' | 'bullets' | 'checkboxes' | undefined;
  prompt?: 'none' | 'multi-input' | undefined;
  prompt_label?: string | undefined;
  children?: BodySectionInput[] | undefined;
};
export type FilterCondition = z.infer<typeof FilterConditionSchema>;
export type DynamicSource = z.infer<typeof DynamicSourceSchema>;
export type Type = z.infer<typeof TypeSchema>;
export type Schema = z.infer<typeof PikaSchema>;

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
  /** Parent type name (undefined only for 'meta') */
  parent: string | undefined;
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
 * A loaded schema with resolved inheritance tree.
 */
export interface LoadedSchema {
  /** Original raw schema */
  raw: Schema;
  /** Resolved types indexed by name */
  types: Map<string, ResolvedType>;
  /** Enum definitions */
  enums: Map<string, string[]>;
  /** Dynamic sources (legacy) */
  dynamicSources: Map<string, DynamicSource>;
  /** Ownership relationships: which types can own which child types */
  ownership: OwnershipMap;
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
// Legacy Types (For Migration Support)
// ============================================================================

/**
 * Field override definition (legacy - for old shared_fields model).
 * @deprecated Use field inheritance instead
 */
export const FieldOverrideSchema = z.object({
  default: z.union([z.string(), z.array(z.string())]).optional(),
  required: z.boolean().optional(),
  label: z.string().optional(),
});

export type FieldOverride = z.infer<typeof FieldOverrideSchema>;

/**
 * Legacy subtype definition (for v1 schema migration).
 * @deprecated Use flat types with 'extends' instead
 */
export const LegacySubtypeSchema: z.ZodType<LegacySubtype, z.ZodTypeDef, LegacySubtypeInput> = z.lazy(() =>
  z.object({
    output_dir: z.string().optional(),
    filename: z.string().optional(),
    shared_fields: z.array(z.string()).optional(),
    field_overrides: z.record(FieldOverrideSchema).optional(),
    frontmatter: z.record(FieldSchema).optional(),
    frontmatter_order: z.array(z.string()).optional(),
    body_sections: z.array(BodySectionSchema).optional(),
    subtypes: z.record(LegacySubtypeSchema).optional(),
  })
);

/**
 * Legacy type definition (for v1 schema migration).
 * @deprecated Use flat types with 'extends' instead
 */
export const LegacyTypeSchema = z.object({
  output_dir: z.string().optional(),
  dir_mode: z.enum(['pooled', 'instance-grouped']).optional().default('pooled'),
  shared_fields: z.array(z.string()).optional(),
  field_overrides: z.record(FieldOverrideSchema).optional(),
  frontmatter: z.record(FieldSchema).optional(),
  frontmatter_order: z.array(z.string()).optional(),
  body_sections: z.array(BodySectionSchema).optional(),
  subtypes: z.record(LegacySubtypeSchema).optional(),
});

/**
 * Legacy schema (v1 format with nested subtypes).
 * @deprecated Use PikaSchema (v2) instead
 */
export const LegacyPikaSchema = z.object({
  version: z.literal(1).optional(),
  shared_fields: z.record(FieldSchema).optional(),
  enums: z.record(z.array(z.string())).optional(),
  dynamic_sources: z.record(DynamicSourceSchema).optional(),
  types: z.record(LegacyTypeSchema),
  audit: AuditConfigSchema.optional(),
});

export type LegacySubtype = {
  output_dir?: string | undefined;
  filename?: string | undefined;
  shared_fields?: string[] | undefined;
  field_overrides?: Record<string, FieldOverride> | undefined;
  frontmatter?: Record<string, Field> | undefined;
  frontmatter_order?: string[] | undefined;
  body_sections?: BodySection[] | undefined;
  subtypes?: Record<string, LegacySubtype> | undefined;
};
export type LegacySubtypeInput = {
  output_dir?: string | undefined;
  filename?: string | undefined;
  shared_fields?: string[] | undefined;
  field_overrides?: Record<string, FieldOverride> | undefined;
  frontmatter?: Record<string, Field> | undefined;
  frontmatter_order?: string[] | undefined;
  body_sections?: BodySectionInput[] | undefined;
  subtypes?: Record<string, LegacySubtypeInput> | undefined;
};
export type LegacyType = z.infer<typeof LegacyTypeSchema>;
export type LegacySchema = z.infer<typeof LegacyPikaSchema>;

// Type definition union for backward compatibility
export type TypeDef = Type | LegacyType | LegacySubtype;
