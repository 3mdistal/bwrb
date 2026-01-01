import { z } from 'zod';

// Field definition for frontmatter
export const FieldSchema = z.object({
  prompt: z.enum(['input', 'select', 'multi-input', 'date', 'dynamic']).optional(),
  value: z.string().optional(),
  enum: z.string().optional(),
  source: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
  list_format: z.enum(['yaml-array', 'comma-separated']).optional(),
  label: z.string().optional(),
  format: z.enum(['plain', 'wikilink', 'quoted-wikilink']).optional(),
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

// Filter condition for dynamic sources
export const FilterConditionSchema = z.object({
  equals: z.string().optional(),
  not_equals: z.string().optional(),
  in: z.array(z.string()).optional(),
  not_in: z.array(z.string()).optional(),
});

// Dynamic source definition
export const DynamicSourceSchema = z.object({
  dir: z.string(),
  filter: z.record(FilterConditionSchema).optional(),
});

// Field override definition (for overriding shared field properties)
export const FieldOverrideSchema = z.object({
  default: z.union([z.string(), z.array(z.string())]).optional(),
  required: z.boolean().optional(),
  label: z.string().optional(),
});

// Subtype definition (recursive via Type)
export const SubtypeSchema: z.ZodType<Subtype, z.ZodTypeDef, SubtypeInput> = z.lazy(() =>
  z.object({
    output_dir: z.string().optional(),
    filename: z.string().optional(),
    shared_fields: z.array(z.string()).optional(), // Opt-in to shared fields
    field_overrides: z.record(FieldOverrideSchema).optional(), // Override shared field properties
    frontmatter: z.record(FieldSchema).optional(),
    frontmatter_order: z.array(z.string()).optional(),
    body_sections: z.array(BodySectionSchema).optional(),
    subtypes: z.record(SubtypeSchema).optional(),
  })
);

// Type definition
export const TypeSchema = z.object({
  output_dir: z.string().optional(), // Optional for parent types with subtypes
  dir_mode: z.enum(['pooled', 'instance-grouped']).optional().default('pooled'),
  shared_fields: z.array(z.string()).optional(), // Opt-in to shared fields
  field_overrides: z.record(FieldOverrideSchema).optional(), // Override shared field properties
  frontmatter: z.record(FieldSchema).optional(),
  frontmatter_order: z.array(z.string()).optional(),
  body_sections: z.array(BodySectionSchema).optional(),
  subtypes: z.record(SubtypeSchema).optional(),
});

// Audit configuration schema
export const AuditConfigSchema = z.object({
  ignored_directories: z.array(z.string()).optional(),
  allowed_extra_fields: z.array(z.string()).optional(),
});

// Root schema
export const PikaSchema = z.object({
  version: z.number().optional().default(1),
  shared_fields: z.record(FieldSchema).optional(),
  enums: z.record(z.array(z.string())).optional(),
  dynamic_sources: z.record(DynamicSourceSchema).optional(),
  types: z.record(TypeSchema),
  audit: AuditConfigSchema.optional(),
});

// Inferred types
export type Field = z.infer<typeof FieldSchema>;
export type FieldOverride = z.infer<typeof FieldOverrideSchema>;
export type BodySection = {
  title: string;
  level?: number | undefined;
  content_type?: 'none' | 'paragraphs' | 'bullets' | 'checkboxes' | undefined;
  prompt?: 'none' | 'multi-input' | undefined;
  prompt_label?: string | undefined;
  children?: BodySection[] | undefined;
};
// Input type for BodySection (allows missing level which gets defaulted)
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
export type Subtype = {
  output_dir?: string | undefined;
  filename?: string | undefined;
  shared_fields?: string[] | undefined;
  field_overrides?: Record<string, FieldOverride> | undefined;
  frontmatter?: Record<string, Field> | undefined;
  frontmatter_order?: string[] | undefined;
  body_sections?: BodySection[] | undefined;
  subtypes?: Record<string, Subtype> | undefined;
};
// Input type for Subtype
export type SubtypeInput = {
  output_dir?: string | undefined;
  filename?: string | undefined;
  shared_fields?: string[] | undefined;
  field_overrides?: Record<string, FieldOverride> | undefined;
  frontmatter?: Record<string, Field> | undefined;
  frontmatter_order?: string[] | undefined;
  body_sections?: BodySectionInput[] | undefined;
  subtypes?: Record<string, SubtypeInput> | undefined;
};
export type Type = z.infer<typeof TypeSchema>;
export type Schema = z.infer<typeof PikaSchema>;

// Type definition union (either a full Type or a Subtype)
export type TypeDef = Type | Subtype;

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
  /** Which subtype to create (e.g., "version", "research") */
  subtype: z.string(),
  /** Override the default filename */
  filename: z.string().optional(),
  /** Template name to use for this instance (resolved against subtype's template dir) */
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
  'template-for': z.string(), // Type path (e.g., "objective/task")
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
  /** Type path this template is for (e.g., "objective/task") */
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
