import { readdir } from 'fs/promises';
import { join, basename, relative } from 'path';
import { existsSync } from 'fs';
import { parseNote, writeNote, generateBodySections } from './frontmatter.js';
import { TemplateFrontmatterSchema, type Template, type LoadedSchema, type Field, type Constraint, type InstanceScaffold, type ResolvedType } from '../types/schema.js';
import { getType, getFieldsForType, getFieldOptions } from './schema.js';
import { isBwrbBuiltinFrontmatterField } from './frontmatter/systemFields.js';
import { matchesExpression, parseExpression, type EvalContext } from './expression.js';
import { applyDefaults } from './validation.js';
import { evaluateTemplateDefault, validateDateExpression, isDateExpression } from './date-expression.js';
import { formatDateWithPattern, DEFAULT_DATE_FORMAT } from './local-date.js';
import {
  ensureIdInFieldOrder,
  generateUniqueNoteId,
  registerIssuedNoteId,
} from './note-id.js';

/**
 * Template Discovery and Parsing
 * ==============================
 * 
 * Templates are markdown files stored in .bwrb/templates/{type}/{subtype}/*.md
 * They provide defaults, body structure, and filename patterns for note creation.
 * 
 * Key design decisions:
 * - default.md inherits: Child types inherit default.md from ancestors if they don't have their own
 * - Named templates: Only apply to their exact type (no inheritance for named templates)
 * - Defaults cascade: When inheriting, ancestor defaults are merged with child overriding parent
 * - Visibility: Template source is always shown ("inherited from X") to avoid hidden behavior
 * - Multiple templates: User prompted to select (with "No template" option)
 */

// ============================================================================
// Template Directory Resolution
// ============================================================================

/**
 * Get the template directory for a type path.
 * Templates are stored at .bwrb/templates/{type}/{subtype}/...
 * 
 * @example
 * getTemplateDir('/vault', 'objective/task') => '/vault/.bwrb/templates/objective/task'
 * getTemplateDir('/vault', 'idea') => '/vault/.bwrb/templates/idea'
 */
export function getTemplateDir(vaultDir: string, typePath: string): string {
  const segments = typePath.split('/').filter(Boolean);
  return join(vaultDir, '.bwrb', 'templates', ...segments);
}

/**
 * Get the root templates directory for a vault.
 */
function getTemplatesRoot(vaultDir: string): string {
  return join(vaultDir, '.bwrb', 'templates');
}

// ============================================================================
// Template Parsing
// ============================================================================

/**
 * Parse a template file and validate its frontmatter.
 * Returns null if the file is not a valid template.
 * 
 * A valid template must have:
 * - type: "template"
 * - template-for: type path string
 */
export async function parseTemplate(filePath: string): Promise<Template | null> {
  try {
    const { frontmatter, body } = await parseNote(filePath);
    
    // Validate frontmatter against template schema
    const result = TemplateFrontmatterSchema.safeParse(frontmatter);
    if (!result.success) {
      return null;
    }
    
    const data = result.data;
    const name = basename(filePath, '.md');
    
    const template: Template = {
      path: filePath,
      name,
      templateFor: data['template-for'],
      body: body.trim(),
    };
    
    // Only add optional properties if they have values
    if (data.description !== undefined) {
      template.description = data.description;
    }
    if (data.defaults !== undefined) {
      template.defaults = data.defaults;
    }
    if (data.constraints !== undefined) {
      template.constraints = data.constraints;
    }
    if (data['prompt-fields'] !== undefined) {
      template.promptFields = data['prompt-fields'];
    }
    if (data['filename-pattern'] !== undefined) {
      template.filenamePattern = data['filename-pattern'];
    }
    if (data.instances !== undefined) {
      template.instances = data.instances;
    }
    
    return template;
  } catch {
    // File doesn't exist or can't be parsed
    return null;
  }
}

// ============================================================================
// Template Discovery
// ============================================================================

/**
 * Find all templates for a specific type path.
 * Only searches the exact template directory for the type (no inheritance).
 * 
 * @example
 * findTemplates('/vault', 'objective/task')
 * // Searches ONLY .bwrb/templates/objective/task/*.md
 * // Does NOT search .bwrb/templates/objective/*.md
 */
export async function findTemplates(
  vaultDir: string,
  typePath: string
): Promise<Template[]> {
  const templateDir = getTemplateDir(vaultDir, typePath);
  
  if (!existsSync(templateDir)) {
    return [];
  }
  
  const templates: Template[] = [];
  
  try {
    const entries = await readdir(templateDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      
      const filePath = join(templateDir, entry.name);
      const template = await parseTemplate(filePath);
      
      // Only include templates that match the requested type path
      if (template && template.templateFor === typePath) {
        templates.push(template);
      }
    }
  } catch {
    // Directory read error - return empty array
    return [];
  }
  
  // Sort alphabetically by name, but put "default" first
  templates.sort((a, b) => {
    if (a.name === 'default') return -1;
    if (b.name === 'default') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return templates;
}

/**
 * Find the default template (default.md) for a type path.
 * Returns null if no default template exists.
 */
export async function findDefaultTemplate(
  vaultDir: string,
  typePath: string
): Promise<Template | null> {
  const templateDir = getTemplateDir(vaultDir, typePath);
  const defaultPath = join(templateDir, 'default.md');
  
  if (!existsSync(defaultPath)) {
    return null;
  }
  
  const template = await parseTemplate(defaultPath);
  
  // Verify it's actually for this type path
  if (template && template.templateFor === typePath) {
    return template;
  }
  
  return null;
}

/**
 * Find a specific template by name for a type path.
 * Returns null if the template doesn't exist or doesn't match the type path.
 */
export async function findTemplateByName(
  vaultDir: string,
  typePath: string,
  templateName: string
): Promise<Template | null> {
  const templateDir = getTemplateDir(vaultDir, typePath);
  
  // Normalize name - add .md if not present
  const fileName = templateName.endsWith('.md') ? templateName : `${templateName}.md`;
  const filePath = join(templateDir, fileName);
  
  if (!existsSync(filePath)) {
    return null;
  }
  
  const template = await parseTemplate(filePath);
  
  // Verify it's actually for this type path
  if (template && template.templateFor === typePath) {
    return template;
  }
  
  return null;
}

/**
 * Find ALL templates in the vault across all types.
 * Returns templates sorted by type path, then by name.
 */
export async function findAllTemplates(vaultDir: string): Promise<Template[]> {
  const templatesRoot = getTemplatesRoot(vaultDir);
  
  if (!existsSync(templatesRoot)) {
    return [];
  }
  
  const templates: Template[] = [];
  
  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const template = await parseTemplate(fullPath);
          if (template) {
            templates.push(template);
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  
  await scanDir(templatesRoot);
  
  // Sort by type path, then by name (with default first)
  templates.sort((a, b) => {
    const typeCompare = a.templateFor.localeCompare(b.templateFor);
    if (typeCompare !== 0) return typeCompare;
    if (a.name === 'default') return -1;
    if (b.name === 'default') return 1;
    return a.name.localeCompare(b.name);
  });
  
  return templates;
}

// ============================================================================
// Template Inheritance
// ============================================================================

/**
 * A template with information about its inheritance source.
 * Used to track where a template came from when it's inherited.
 */
export interface TemplateWithSource extends Template {
  /** 
   * The type that this template was inherited from.
   * undefined means exact match (template is for this type directly).
   */
  inheritedFrom: string | undefined;
}

/**
 * Find the default template for a type, walking the ancestor chain if needed.
 * 
 * Inheritance rules:
 * - Only default.md is inherited (named templates are not)
 * - Child's own default.md takes precedence over ancestors
 * - Search order: type → parent → grandparent → ... → meta
 * 
 * @param vaultDir - The vault directory
 * @param typePath - The type to find a default template for
 * @param schema - The loaded schema (needed for ancestor chain)
 * @returns The default template with source info, or null if none found
 * 
 * @example
 * // For type 'objective/task' with ancestors ['objective', 'meta']:
 * // 1. Check .bwrb/templates/objective/task/default.md
 * // 2. Check .bwrb/templates/objective/default.md  
 * // 3. Check .bwrb/templates/meta/default.md
 */
export async function findDefaultTemplateWithInheritance(
  vaultDir: string,
  typePath: string,
  schema: LoadedSchema
): Promise<TemplateWithSource | null> {
  // First check if the type itself has a default template
  const ownDefault = await findDefaultTemplate(vaultDir, typePath);
  if (ownDefault) {
    return { ...ownDefault, inheritedFrom: undefined };
  }
  
  // Get ancestors from the schema
  const typeDef = getType(schema, typePath);
  if (!typeDef) {
    return null;
  }
  
  // Walk ancestor chain looking for default.md
  for (const ancestorName of typeDef.ancestors) {
    const ancestorDefault = await findDefaultTemplate(vaultDir, ancestorName);
    if (ancestorDefault) {
      return { ...ancestorDefault, inheritedFrom: ancestorName };
    }
  }
  
  return null;
}

/**
 * Get all default templates in the inheritance chain for a type.
 * Returns templates ordered from root ancestor to the type itself.
 * Used for merging defaults (ancestor first, child overrides).
 * 
 * @param vaultDir - The vault directory
 * @param typePath - The type to get templates for
 * @param schema - The loaded schema
 * @returns Array of templates ordered root-first (for merging)
 */
export async function getDefaultTemplateChain(
  vaultDir: string,
  typePath: string,
  schema: LoadedSchema
): Promise<TemplateWithSource[]> {
  const templates: TemplateWithSource[] = [];
  
  const typeDef = getType(schema, typePath);
  if (!typeDef) {
    return templates;
  }
  
  // Build chain from ancestors (reversed to get root-first order)
  const chain = [...typeDef.ancestors].reverse();
  chain.push(typePath);
  
  for (const typeName of chain) {
    const defaultTemplate = await findDefaultTemplate(vaultDir, typeName);
    if (defaultTemplate) {
      templates.push({
        ...defaultTemplate,
        inheritedFrom: typeName === typePath ? undefined : typeName,
      });
    }
  }
  
  return templates;
}

/**
 * Merge template defaults from an inheritance chain.
 * Ancestor defaults come first, child defaults override.
 * 
 * @param templates - Templates ordered root-first (from getDefaultTemplateChain)
 * @param dateFormat - Date format for evaluating date expressions
 * @returns Merged defaults object
 * 
 * @example
 * // meta template: { creation_date: "@today", status: "draft" }
 * // task template: { status: "not-started", priority: "medium" }
 * // Result: { creation_date: "@today", status: "not-started", priority: "medium" }
 */
export function mergeTemplateDefaults(
  templates: TemplateWithSource[],
  dateFormat: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  
  for (const template of templates) {
    if (template.defaults) {
      for (const [key, value] of Object.entries(template.defaults)) {
        // Evaluate date expressions as we merge
        merged[key] = evaluateTemplateDefault(value, dateFormat);
      }
    }
  }
  
  return merged;
}

/**
 * Merge template constraints from an inheritance chain.
 * Child constraints override ancestor constraints for the same field.
 * 
 * @param templates - Templates ordered root-first
 * @returns Merged constraints object
 */
function mergeTemplateConstraints(
  templates: TemplateWithSource[]
): Record<string, Constraint> {
  const merged: Record<string, Constraint> = {};
  
  for (const template of templates) {
    if (template.constraints) {
      for (const [key, value] of Object.entries(template.constraints)) {
        merged[key] = value;
      }
    }
  }
  
  return merged;
}

/**
 * Merge prompt-fields from an inheritance chain.
 * All prompt-fields from all templates in the chain are combined.
 * 
 * @param templates - Templates ordered root-first
 * @returns Combined prompt-fields array (deduplicated)
 */
function mergeTemplatePromptFields(
  templates: TemplateWithSource[]
): string[] {
  const fields = new Set<string>();
  
  for (const template of templates) {
    if (template.promptFields) {
      for (const field of template.promptFields) {
        fields.add(field);
      }
    }
  }
  
  return Array.from(fields);
}

/**
 * Result of resolving a template with inheritance support.
 */
export interface InheritedTemplateResolution {
  /** The effective template (may be inherited) */
  template: TemplateWithSource | null;
  /** Merged defaults from entire inheritance chain */
  mergedDefaults: Record<string, unknown>;
  /** Merged constraints from entire inheritance chain */
  mergedConstraints: Record<string, Constraint>;
  /** Combined prompt-fields from entire inheritance chain */
  mergedPromptFields: string[];
  /** Whether user should be prompted to select a template */
  shouldPrompt: boolean;
  /** Available templates for this exact type (for prompting) */
  availableTemplates: Template[];
}

/**
 * Resolve template with inheritance support.
 * 
 * This is the main entry point for template resolution with inheritance.
 * It handles:
 * - Explicit template selection (--template flag)
 * - Skipping templates (--no-template flag)
 * - Auto-discovery with inheritance fallback
 * - Merging defaults from ancestor templates
 * 
 * @param vaultDir - The vault directory
 * @param typePath - The type to resolve template for
 * @param schema - The loaded schema
 * @param options - Resolution options
 * @returns Resolution result with template and merged inheritance data
 */
export async function resolveTemplateWithInheritance(
  vaultDir: string,
  typePath: string,
  schema: LoadedSchema,
  options: {
    noTemplate?: boolean;
    templateName?: string;
  }
): Promise<InheritedTemplateResolution> {
  // --no-template: Skip template system entirely
  if (options.noTemplate) {
    return {
      template: null,
      mergedDefaults: {},
      mergedConstraints: {},
      mergedPromptFields: [],
      shouldPrompt: false,
      availableTemplates: [],
    };
  }
  
  // --template <name>: Find specific template (no inheritance for named templates)
  if (options.templateName) {
    const template = await findTemplateByName(vaultDir, typePath, options.templateName);
    if (template) {
      // For explicit template selection, still merge with ancestor defaults
      const chain = await getDefaultTemplateChain(vaultDir, typePath, schema);
      // Filter out templates from the same type (we're using the named one instead)
      const ancestorChain = chain.filter(t => t.inheritedFrom !== undefined);
      
      // Merge ancestor defaults, then overlay the selected template's defaults
      const mergedDefaults = mergeTemplateDefaults(ancestorChain, schema.config.dateFormat);
      if (template.defaults) {
        for (const [key, value] of Object.entries(template.defaults)) {
          mergedDefaults[key] = evaluateTemplateDefault(value, schema.config.dateFormat);
        }
      }
      
      return {
        template: { ...template, inheritedFrom: undefined },
        mergedDefaults,
        mergedConstraints: template.constraints ?? {},
        mergedPromptFields: template.promptFields ?? [],
        shouldPrompt: false,
        availableTemplates: [],
      };
    }
    // Template not found - caller should handle as error
    return {
      template: null,
      mergedDefaults: {},
      mergedConstraints: {},
      mergedPromptFields: [],
      shouldPrompt: false,
      availableTemplates: [],
    };
  }
  
  // No flags: Auto-discover with inheritance
  const ownTemplates = await findTemplates(vaultDir, typePath);
  const chain = await getDefaultTemplateChain(vaultDir, typePath, schema);
  
  // Check for own default.md first
  const ownDefault = ownTemplates.find(t => t.name === 'default');
  if (ownDefault) {
    // Has own default - merge with ancestor chain
    const mergedDefaults = mergeTemplateDefaults(chain, schema.config.dateFormat);
    const mergedConstraints = mergeTemplateConstraints(chain);
    const mergedPromptFields = mergeTemplatePromptFields(chain);
    
    return {
      template: { ...ownDefault, inheritedFrom: undefined },
      mergedDefaults,
      mergedConstraints,
      mergedPromptFields,
      shouldPrompt: false,
      availableTemplates: ownTemplates,
    };
  }
  
  // No own default - check for inherited default
  const inheritedDefault = await findDefaultTemplateWithInheritance(vaultDir, typePath, schema);
  if (inheritedDefault) {
    // Using inherited template - merge with full chain
    const mergedDefaults = mergeTemplateDefaults(chain, schema.config.dateFormat);
    const mergedConstraints = mergeTemplateConstraints(chain);
    const mergedPromptFields = mergeTemplatePromptFields(chain);
    
    return {
      template: inheritedDefault,
      mergedDefaults,
      mergedConstraints,
      mergedPromptFields,
      shouldPrompt: false,
      availableTemplates: ownTemplates,
    };
  }
  
  // No default templates at all
  // If there are other templates for this type, prompt
  if (ownTemplates.length > 0) {
    return {
      template: null,
      mergedDefaults: {},
      mergedConstraints: {},
      mergedPromptFields: [],
      shouldPrompt: true,
      availableTemplates: ownTemplates,
    };
  }
  
  // No templates available
  return {
    template: null,
    mergedDefaults: {},
    mergedConstraints: {},
    mergedPromptFields: [],
    shouldPrompt: false,
    availableTemplates: [],
  };
}

/**
 * Get inherited templates for display in `bwrb template list`.
 * Returns default.md templates from ancestors that would be inherited.
 * 
 * @param vaultDir - The vault directory
 * @param typePath - The type to get inherited templates for
 * @param schema - The loaded schema
 * @returns Array of inherited templates with source info
 */
export async function getInheritedTemplates(
  vaultDir: string,
  typePath: string,
  schema: LoadedSchema
): Promise<TemplateWithSource[]> {
  const inherited: TemplateWithSource[] = [];
  
  const typeDef = getType(schema, typePath);
  if (!typeDef) {
    return inherited;
  }
  
  // Only include ancestors (not the type itself)
  for (const ancestorName of typeDef.ancestors) {
    const defaultTemplate = await findDefaultTemplate(vaultDir, ancestorName);
    if (defaultTemplate) {
      inherited.push({
        ...defaultTemplate,
        inheritedFrom: ancestorName,
      });
    }
  }
  
  return inherited;
}

// ============================================================================
// Template Body Processing
// ============================================================================

/**
 * Process template body, substituting variables with frontmatter values.
 * 
 * Supported variables:
 * - {fieldName} - Replaced with frontmatter[fieldName]
 * - {date} - Replaced with today's date (uses config.date_format or YYYY-MM-DD)
 * - {date:FORMAT} - Replaced with formatted date (explicit format overrides config)
 * 
 * @param body - The template body string
 * @param frontmatter - Frontmatter values for substitution
 * @param dateFormat - Date format to use for {date} substitution (defaults to YYYY-MM-DD)
 * 
 * @example
 * processTemplateBody("# {title}\n\nCreated: {date}", { title: "My Note" })
 * // => "# My Note\n\nCreated: 2025-01-15"
 * 
 * processTemplateBody("Created: {date}", {}, "MM/DD/YYYY")
 * // => "Created: 01/15/2025"
 */
export function processTemplateBody(
  body: string,
  frontmatter: Record<string, unknown>,
  dateFormat: string = DEFAULT_DATE_FORMAT
): string {
  let result = body;
  
  // Replace {date:format} patterns first (more specific)
  // Explicit format in template overrides config
  const now = new Date();
  result = result.replace(/{date:([^}]+)}/g, (_, format: string) => {
    return formatDate(now, format);
  });
  
  // Replace {date} with today's date using config format
  result = result.replace(/{date}/g, formatDateWithPattern(now, dateFormat));
  
  // Replace {fieldName} with frontmatter values
  for (const [key, value] of Object.entries(frontmatter)) {
    const placeholder = `{${key}}`;
    if (result.includes(placeholder)) {
      const stringValue = formatValueForBody(value);
      result = result.split(placeholder).join(stringValue);
    }
  }
  
  return result;
}

/**
 * Format a frontmatter value for body substitution.
 */
function formatValueForBody(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

/**
 * Format a date with a simple format string.
 * Supports: YYYY, MM, DD, HH, mm
 */
function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  
  return format
    .replace('YYYY', date.getFullYear().toString())
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()));
}

// ============================================================================
// Filename Pattern Resolution
// ============================================================================

/**
 * Characters that are invalid in filenames across common filesystems.
 * Includes: / \ : * ? " < > | and control characters (0x00-0x1F)
 */
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;

/**
 * Sanitize a string for use as a filename.
 * Removes invalid characters and trims whitespace.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(INVALID_FILENAME_CHARS, '')
    .trim();
}

/**
 * Result of attempting to resolve a filename pattern.
 */
export interface FilenamePatternResult {
  /** Whether the pattern was fully resolved (all placeholders substituted) */
  resolved: boolean;
  /** The resolved filename (without .md extension), or null if unresolved */
  filename: string | null;
  /** Fields that were referenced but had no value */
  missingFields: string[];
}

/**
 * Get the filename pattern to use for a note, with proper precedence.
 * 
 * Precedence (highest to lowest):
 * 1. Template's filename-pattern
 * 2. Type-level filename pattern from schema
 * 3. null (no pattern defined)
 * 
 * @param template The template being used (if any)
 * @param typeDef The resolved type definition
 * @returns The filename pattern string, or null if none defined
 */
export function getFilenamePattern(
  template: Template | null | undefined,
  typeDef: ResolvedType
): string | null {
  // Template pattern takes precedence
  if (template?.filenamePattern) {
    return template.filenamePattern;
  }
  
  // Fall back to type-level pattern
  if (typeDef.filename) {
    return typeDef.filename;
  }
  
  return null;
}

/**
 * Resolve a filename pattern by substituting placeholders with values.
 * 
 * Supports the same placeholder syntax as template body:
 * - {date} - Today's date in configured format
 * - {date:FORMAT} - Today's date in specified format (e.g., {date:YYYY-MM-DD})
 * - {fieldName} - Value from frontmatter
 * 
 * @param pattern The filename pattern (e.g., "{date} - {title}")
 * @param frontmatter The frontmatter values to substitute
 * @param dateFormat The date format to use for {date} placeholder
 * @returns Result indicating whether resolution succeeded and the filename
 * 
 * @example
 * resolveFilenamePattern("{date} - {title}", { title: "My Note" }, "YYYY-MM-DD")
 * // => { resolved: true, filename: "2025-01-07 - My Note", missingFields: [] }
 * 
 * resolveFilenamePattern("{title}", {}, "YYYY-MM-DD")
 * // => { resolved: false, filename: null, missingFields: ["title"] }
 */
export function resolveFilenamePattern(
  pattern: string,
  frontmatter: Record<string, unknown>,
  dateFormat: string = DEFAULT_DATE_FORMAT
): FilenamePatternResult {
  let result = pattern;
  const missingFields: string[] = [];
  
  // Replace {date:format} patterns first (more specific)
  const now = new Date();
  result = result.replace(/{date:([^}]+)}/g, (_, format: string) => {
    return formatDate(now, format);
  });
  
  // Replace {date} with today's date
  result = result.replace(/{date}/g, formatDateWithPattern(now, dateFormat));
  
  // Find all remaining placeholders to check for missing fields
  const remainingPlaceholders = result.match(/\{([^}:]+)\}/g) || [];
  
  // Replace {fieldName} with frontmatter values
  for (const placeholder of remainingPlaceholders) {
    const fieldName = placeholder.slice(1, -1); // Remove { and }
    const value = frontmatter[fieldName];
    
    if (value === undefined || value === null || value === '') {
      missingFields.push(fieldName);
    } else {
      const stringValue = formatValueForBody(value);
      result = result.split(placeholder).join(stringValue);
    }
  }
  
  // If any fields are missing, we can't resolve the pattern
  if (missingFields.length > 0) {
    return {
      resolved: false,
      filename: null,
      missingFields,
    };
  }
  
  // Sanitize the result for use as a filename
  const sanitized = sanitizeFilename(result);
  
  // If sanitization resulted in empty string, treat as unresolved
  if (!sanitized) {
    return {
      resolved: false,
      filename: null,
      missingFields: [],
    };
  }
  
  return {
    resolved: true,
    filename: sanitized,
    missingFields: [],
  };
}

// ============================================================================
// Template Selection Helpers
// ============================================================================

/**
 * Result of template resolution for the new command.
 */
export interface TemplateResolutionResult {
  /** The selected template, or null if no template should be used */
  template: Template | null;
  /** Whether the user should be prompted to select */
  shouldPrompt: boolean;
  /** Available templates for prompting */
  availableTemplates: Template[];
}

/**
 * Resolve which template to use based on CLI flags and available templates.
 * 
 * Logic:
 * - --no-template: Return null template, no prompt
 * - --template <name>: Find and return that template (error if not found)
 * - No flags:
 *   - If default.md exists: Use it automatically
 *   - If multiple templates: Prompt user to select
 *   - If no templates: No template, no prompt
 */
export async function resolveTemplate(
  vaultDir: string,
  typePath: string,
  options: {
    noTemplate?: boolean;
    templateName?: string;
  }
): Promise<TemplateResolutionResult> {
  // --no-template: Skip template system entirely
  if (options.noTemplate) {
    return { template: null, shouldPrompt: false, availableTemplates: [] };
  }
  
  // --template <name>: Find specific template
  if (options.templateName) {
    const template = await findTemplateByName(vaultDir, typePath, options.templateName);
    // Note: Caller should handle null case as an error
    return { template, shouldPrompt: false, availableTemplates: [] };
  }
  
  // No flags: Auto-discover templates
  const templates = await findTemplates(vaultDir, typePath);
  
  if (templates.length === 0) {
    // No templates available
    return { template: null, shouldPrompt: false, availableTemplates: [] };
  }
  
  // Check for default.md
  const defaultTemplate = templates.find(t => t.name === 'default');
  if (defaultTemplate) {
    // Auto-use default.md
    return { template: defaultTemplate, shouldPrompt: false, availableTemplates: templates };
  }
  
  // Multiple templates, no default - need to prompt
  return { template: null, shouldPrompt: true, availableTemplates: templates };
}

// ============================================================================
// Template Validation
// ============================================================================

/**
 * A validation issue found in a template.
 */
export interface TemplateValidationIssue {
  /** Issue severity: error prevents use, warning is informational */
  severity: 'error' | 'warning';
  /** Error message */
  message: string;
  /** Field name if applicable */
  field?: string;
  /** Suggestion for fixing the issue */
  suggestion?: string;
}

/**
 * Result of validating a template.
 */
export interface TemplateValidationResult {
  /** Path to the template file */
  path: string;
  /** Relative path for display */
  relativePath: string;
  /** Template name */
  name: string;
  /** Type path the template is for */
  templateFor: string;
  /** Whether the template is valid (no errors) */
  valid: boolean;
  /** All validation issues found */
  issues: TemplateValidationIssue[];
}

/**
 * Calculate Levenshtein distance between two strings.
 * Used for typo suggestions.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        );
      }
    }
  }
  
  return matrix[b.length]![a.length]!;
}

/**
 * Find the closest match to a string from a list of options.
 * Returns undefined if no close match found (distance > 3).
 */
function findClosestMatch(target: string, options: string[]): string | undefined {
  let closest: string | undefined;
  let minDistance = 4; // Max distance for suggestions
  
  for (const option of options) {
    const distance = levenshteinDistance(target.toLowerCase(), option.toLowerCase());
    if (distance < minDistance) {
      minDistance = distance;
      closest = option;
    }
  }
  
  return closest;
}

/**
 * Validate field value against its field definition.
 */
function validateFieldValue(
  fieldName: string,
  field: Field,
  value: unknown
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  
  // Skip validation for null/undefined values (not set)
  if (value === null || value === undefined) {
    return issues;
  }
  
  // Validate options values
  const fieldOptions = getFieldOptions(field);
  if (fieldOptions.length > 0) {
    if (Array.isArray(value)) {
      // Multi-value field
      for (const v of value) {
        if (typeof v === 'string' && !fieldOptions.includes(v)) {
          const suggestion = findClosestMatch(v, fieldOptions);
          issues.push({
            severity: 'error',
            message: `Invalid value '${v}' for field '${fieldName}'`,
            field: fieldName,
            suggestion: suggestion 
              ? `Did you mean '${suggestion}'?`
              : `Expected one of: ${fieldOptions.join(', ')}`,
          });
        }
      }
    } else if (typeof value === 'string') {
      if (!fieldOptions.includes(value)) {
        const suggestion = findClosestMatch(value, fieldOptions);
        issues.push({
          severity: 'error',
          message: `Invalid value '${value}' for field '${fieldName}'`,
          field: fieldName,
          suggestion: suggestion 
            ? `Did you mean '${suggestion}'?`
            : `Expected one of: ${fieldOptions.join(', ')}`,
        });
      }
    }
  }
  
  // Validate prompt type compatibility
  if (field.prompt === 'list' && !Array.isArray(value)) {
    issues.push({
      severity: 'warning',
      message: `Field '${fieldName}' expects an array but got ${typeof value}`,
      field: fieldName,
    });
  }
  
  return issues;
}

/**
 * Validate a template against the schema.
 * 
 * Performs full validation:
 * 1. Frontmatter schema validity
 * 2. Type name exists in schema
 * 3. Defaults reference valid fields
 * 4. Default values match field types/enums
 * 5. prompt-fields reference valid fields
 * 6. filename-pattern references valid fields
 */
export async function validateTemplate(
  vaultDir: string,
  template: Template,
  schema: LoadedSchema
): Promise<TemplateValidationResult> {
  const issues: TemplateValidationIssue[] = [];
  const relativePath = relative(vaultDir, template.path);
  
  // 1. Check type exists
  const typeDef = getType(schema, template.templateFor);
  if (!typeDef) {
    issues.push({
      severity: 'error',
      message: `Type '${template.templateFor}' not found in schema`,
      suggestion: 'Check the template-for field matches a valid type name',
    });
    
    // Can't do further validation without a valid type
    return {
      path: template.path,
      relativePath,
      name: template.name,
      templateFor: template.templateFor,
      valid: false,
      issues,
    };
  }
  
  // Get all fields for this type
  const fields = getFieldsForType(schema, template.templateFor);
  const validFieldNames = Object.keys(fields);
  const isKnownField = (fieldName: string): boolean =>
    validFieldNames.includes(fieldName) || isBwrbBuiltinFrontmatterField(fieldName);
  
  // 2. Validate defaults
  if (template.defaults) {
    for (const [fieldName, value] of Object.entries(template.defaults)) {
      // Check field exists
      if (!isKnownField(fieldName)) {
        const suggestion = findClosestMatch(fieldName, validFieldNames);
        const issue: TemplateValidationIssue = {
          severity: 'error',
          message: `Unknown field '${fieldName}' in defaults`,
          field: fieldName,
        };
        if (suggestion) {
          issue.suggestion = `Did you mean '${suggestion}'?`;
        }
        issues.push(issue);
        continue;
      }
      
      // Validate date expression syntax if it looks like one
      if (typeof value === 'string') {
        const dateExprError = validateDateExpression(value);
        if (dateExprError) {
          issues.push({
            severity: 'error',
            message: dateExprError,
            field: fieldName,
          });
          continue;
        }
      }
      
      // Validate value against field definition (skip for date expressions)
      const field = fields[fieldName];
      if (field && !(typeof value === 'string' && isDateExpression(value))) {
        const valueIssues = validateFieldValue(fieldName, field, value);
        issues.push(...valueIssues);
      }
    }
  }
  
  // 3. Validate prompt-fields
  if (template.promptFields) {
    for (const fieldName of template.promptFields) {
      if (!isKnownField(fieldName)) {
        const suggestion = findClosestMatch(fieldName, validFieldNames);
        const issue: TemplateValidationIssue = {
          severity: 'error',
          message: `Unknown field '${fieldName}' in prompt-fields`,
          field: fieldName,
        };
        if (suggestion) {
          issue.suggestion = `Did you mean '${suggestion}'?`;
        }
        issues.push(issue);
      }
    }
  }
  
  // 4. Validate filename-pattern
  if (template.filenamePattern) {
    // Extract field references from pattern
    const fieldRefs = template.filenamePattern.match(/\{([^}:]+)(?::[^}]*)?\}/g);
    if (fieldRefs) {
      for (const ref of fieldRefs) {
        // Extract field name from {fieldName} or {fieldName:format}
        const match = ref.match(/\{([^}:]+)/);
        const fieldName = match?.[1];
        
        // Skip special fields
        if (fieldName === 'date' || fieldName === 'title') continue;
        
        if (fieldName && !isKnownField(fieldName)) {
          const suggestion = findClosestMatch(fieldName, validFieldNames);
          const issue: TemplateValidationIssue = {
            severity: 'warning',
            message: `Unknown field '${fieldName}' referenced in filename-pattern`,
            field: fieldName,
          };
          if (suggestion) {
            issue.suggestion = `Did you mean '${suggestion}'?`;
          }
          issues.push(issue);
        }
      }
    }
  }
  
  // 5. Check body placeholders
  const bodyFieldRefs = template.body.match(/\{([^}:]+)(?::[^}]*)?\}/g);
  if (bodyFieldRefs) {
    for (const ref of bodyFieldRefs) {
      const match = ref.match(/\{([^}:]+)/);
      const fieldName = match?.[1];
      
      // Skip special fields
      if (fieldName === 'date' || fieldName === 'title') continue;
      
      if (fieldName && !isKnownField(fieldName)) {
        const suggestion = findClosestMatch(fieldName, validFieldNames);
        const issue: TemplateValidationIssue = {
          severity: 'warning',
          message: `Unknown field '${fieldName}' referenced in body`,
          field: fieldName,
        };
        if (suggestion) {
          issue.suggestion = `Did you mean '${suggestion}'?`;
        }
        issues.push(issue);
      }
    }
  }
  
  // 6. Validate constraints
  if (template.constraints) {
    for (const [fieldName, constraint] of Object.entries(template.constraints)) {
      // Check field exists
      if (!isKnownField(fieldName)) {
        const suggestion = findClosestMatch(fieldName, validFieldNames);
        const issue: TemplateValidationIssue = {
          severity: 'error',
          message: `Unknown field '${fieldName}' in constraints`,
          field: fieldName,
        };
        if (suggestion) {
          issue.suggestion = `Did you mean '${suggestion}'?`;
        }
        issues.push(issue);
        continue;
      }
      
      // Validate expression syntax
      if (constraint.validate) {
        try {
          parseExpression(constraint.validate);
        } catch (e) {
          issues.push({
            severity: 'error',
            message: `Invalid constraint expression for '${fieldName}': ${(e as Error).message}`,
            field: fieldName,
          });
        }
      }
    }
  }
  
  // 7. Validate instances (for parent templates)
  if (template.instances) {
    // Get valid child types for this parent
    const validChildTypes = typeDef.children;
    
    for (const instance of template.instances) {
      // Check instance type exists
      const instanceType = getType(schema, instance.type);
      if (!instanceType) {
        const suggestion = findClosestMatch(instance.type, validChildTypes);
        const issue: TemplateValidationIssue = {
          severity: 'error',
          message: `Unknown type '${instance.type}' in instances`,
        };
        if (suggestion) {
          issue.suggestion = `Did you mean '${suggestion}'?`;
        } else if (validChildTypes.length > 0) {
          issue.suggestion = `Valid child types: ${validChildTypes.join(', ')}`;
        } else {
          issue.suggestion = `Type '${template.templateFor}' has no child types`;
        }
        issues.push(issue);
        continue;
      }
      
      // Validate template name if specified (just check it's not empty)
      if (instance.template !== undefined && instance.template.trim() === '') {
        issues.push({
          severity: 'warning',
          message: `Empty template name for instance type '${instance.type}'`,
        });
      }
      
      // Validate defaults against instance type schema if provided
      if (instance.defaults) {
        const instanceFields = getFieldsForType(schema, instance.type);
        const instanceFieldNames = Object.keys(instanceFields);
        const isKnownInstanceField = (fieldName: string): boolean =>
          instanceFieldNames.includes(fieldName) || isBwrbBuiltinFrontmatterField(fieldName);
        
        for (const fieldName of Object.keys(instance.defaults)) {
          if (!isKnownInstanceField(fieldName)) {
            const suggestion = findClosestMatch(fieldName, instanceFieldNames);
            const issue: TemplateValidationIssue = {
              severity: 'warning',
              message: `Unknown field '${fieldName}' in instance defaults for '${instance.type}'`,
              field: fieldName,
            };
            if (suggestion) {
              issue.suggestion = `Did you mean '${suggestion}'?`;
            }
            issues.push(issue);
          }
        }
      }
    }
  }
  
  const hasErrors = issues.some(i => i.severity === 'error');
  
  return {
    path: template.path,
    relativePath,
    name: template.name,
    templateFor: template.templateFor,
    valid: !hasErrors,
    issues,
  };
}

/**
 * Validate all templates in a vault.
 */
export async function validateAllTemplates(
  vaultDir: string,
  schema: LoadedSchema,
  typeName?: string
): Promise<TemplateValidationResult[]> {
  const templates = typeName 
    ? await findTemplates(vaultDir, typeName)
    : await findAllTemplates(vaultDir);
  
  const results: TemplateValidationResult[] = [];
  
  for (const template of templates) {
    const result = await validateTemplate(vaultDir, template, schema);
    results.push(result);
  }
  
  return results;
}

// ============================================================================
// Constraint Validation
// ============================================================================

/**
 * Error from constraint validation.
 */
export interface ConstraintValidationError {
  /** Field name that failed validation */
  field: string;
  /** Error message */
  message: string;
  /** Which constraint failed: 'required' or 'validate' */
  constraint: 'required' | 'validate';
}

/**
 * Result of validating frontmatter against template constraints.
 */
export interface ConstraintValidationResult {
  /** Whether all constraints passed */
  valid: boolean;
  /** List of validation errors */
  errors: ConstraintValidationError[];
}

/**
 * Validate frontmatter against template constraints.
 * 
 * Constraints allow templates to enforce stricter rules than the base schema:
 * - required: true - Make an optional field required
 * - validate: expression - Expression must evaluate to true (using 'this' for field value)
 * - error: message - Custom error message
 * 
 * @param frontmatter - The frontmatter values to validate
 * @param constraints - Template constraints to apply
 * @returns Validation result with any errors
 * 
 * @example
 * const constraints = {
 *   deadline: {
 *     required: true,
 *     validate: "this < today() + '7d'",
 *     error: "Deadline must be within 7 days"
 *   }
 * };
 * const result = validateConstraints({ deadline: '2025-01-15' }, constraints);
 */
export function validateConstraints(
  frontmatter: Record<string, unknown>,
  constraints: Record<string, Constraint>
): ConstraintValidationResult {
  const errors: ConstraintValidationError[] = [];
  
  for (const [fieldName, constraint] of Object.entries(constraints)) {
    const value = frontmatter[fieldName];
    
    // Check required constraint
    if (constraint.required) {
      const isEmpty = value === undefined || value === null || value === '';
      if (isEmpty) {
        errors.push({
          field: fieldName,
          message: constraint.error ?? `Field '${fieldName}' is required by this template`,
          constraint: 'required',
        });
        continue; // Skip validate check if required failed
      }
    }
    
    // Check validate expression
    if (constraint.validate && value !== undefined && value !== null && value !== '') {
      // Build context with 'this' set to the field value
      const context: EvalContext = {
        frontmatter: { ...frontmatter, this: value },
      };
      
      try {
        const result = matchesExpression(constraint.validate, context);
        if (!result) {
          errors.push({
            field: fieldName,
            message: constraint.error ?? `Field '${fieldName}' failed validation: ${constraint.validate}`,
            constraint: 'validate',
          });
        }
      } catch (e) {
        errors.push({
          field: fieldName,
          message: `Invalid constraint expression for '${fieldName}': ${(e as Error).message}`,
          constraint: 'validate',
        });
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate that constraint expressions are syntactically valid.
 * This is used during template validation to catch errors early.
 * 
 * @param constraints - Template constraints to validate
 * @returns Array of syntax errors found
 */
export function validateConstraintSyntax(
  constraints: Record<string, Constraint>
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  
  for (const [fieldName, constraint] of Object.entries(constraints)) {
    if (constraint.validate) {
      try {
        parseExpression(constraint.validate);
      } catch (e) {
        errors.push({
          field: fieldName,
          message: `Invalid expression: ${(e as Error).message}`,
        });
      }
    }
  }
  
  return errors;
}

// ============================================================================
// Instance Scaffolding
// ============================================================================

/**
 * Error from instance scaffolding.
 */
export interface ScaffoldError {
  /** Type that failed (kept as 'subtype' for API compatibility) */
  subtype: string;
  /** Filename if specified */
  filename?: string | undefined;
  /** Error message */
  message: string;
}

/**
 * Result of creating scaffolded instances.
 */
export interface ScaffoldResult {
  /** Paths of successfully created files */
  created: string[];
  /** Files that were skipped (already exist) */
  skipped: string[];
  /** Errors encountered */
  errors: ScaffoldError[];
}

/**
 * Create scaffolded instance files from a parent template.
 * 
 * When a parent template has an `instances` array, this function creates
 * all the specified type files within the instance folder.
 * 
 * @param schema - The vault schema
 * @param vaultDir - Path to vault directory
 * @param _parentTypeName - Type name of parent (e.g., "draft") - unused in new model
 * @param instanceDir - Path to instance folder
 * @param instances - Instance definitions from template
 * @param parentFrontmatter - Frontmatter from parent note (for variable substitution)
 * @returns Result with created files, skipped files, and any errors
 * 
 * @example
 * const result = await createScaffoldedInstances(
 *   schema,
 *   '/vault',
 *   'draft',
 *   '/vault/Drafts/My Project',
 *   [
 *     { type: 'version', filename: 'Draft v1.md' },
 *     { type: 'research', filename: 'SEO.md', template: 'seo' },
 *   ],
 *   { Name: 'My Project', status: 'draft' }
 * );
 */
export async function createScaffoldedInstances(
  schema: LoadedSchema,
  vaultDir: string,
  _parentTypeName: string,
  instanceDir: string,
  instances: InstanceScaffold[],
  parentFrontmatter: Record<string, unknown>
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: ScaffoldError[] = [];
  
  for (const instance of instances) {
    try {
      // Validate type exists
      const instanceType = getType(schema, instance.type);
      if (!instanceType) {
        errors.push({
          subtype: instance.type,
          filename: instance.filename,
          message: `Unknown type: ${instance.type}`,
        });
        continue;
      }
      
      // Determine filename
      const filename = instance.filename ?? `${instance.type}.md`;
      const filePath = join(instanceDir, filename);
      
      // Skip if file exists (warn but continue)
      if (existsSync(filePath)) {
        skipped.push(filePath);
        continue;
      }
      
      // Load instance template if specified
      let instanceTemplate: Template | null = null;
      if (instance.template) {
        instanceTemplate = await findTemplateByName(vaultDir, instance.type, instance.template);
        // If not found, don't error - just continue without template
      }
      
      // Build frontmatter with defaults
      let frontmatter: Record<string, unknown> = {};
      
      // Apply instance-specific defaults first, evaluating date expressions
      if (instance.defaults) {
        for (const [key, value] of Object.entries(instance.defaults)) {
          frontmatter[key] = evaluateTemplateDefault(value, schema.config.dateFormat);
        }
      }
      
      // Apply template defaults (template overrides instance defaults)
      // Also evaluate date expressions
      if (instanceTemplate?.defaults) {
        for (const [key, value] of Object.entries(instanceTemplate.defaults)) {
          frontmatter[key] = evaluateTemplateDefault(value, schema.config.dateFormat);
        }
      }
      
      // Apply schema defaults for any missing required fields
      frontmatter = applyDefaults(schema, instance.type, frontmatter);

      // System-managed stable note id (v1.0)
      const noteId = await generateUniqueNoteId(vaultDir);
      frontmatter['id'] = noteId;

      // Generate body
      let body = '';
      if (instanceTemplate?.body) {
        body = processTemplateBody(
          instanceTemplate.body,
          {
            ...parentFrontmatter,
            ...frontmatter,
          },
          schema.config.dateFormat
        );
      } else if (instanceType.bodySections && instanceType.bodySections.length > 0) {
        body = generateBodySections(instanceType.bodySections);
      }

      // Get field order from type definition
      const orderedFields = ensureIdInFieldOrder(
        instanceType.fieldOrder.length > 0 ? instanceType.fieldOrder : Object.keys(frontmatter)
      );

      // Write file
      await writeNote(filePath, frontmatter, body, orderedFields);
      await registerIssuedNoteId(vaultDir, noteId, filePath);
      created.push(filePath);
      
    } catch (e) {
      errors.push({
        subtype: instance.type,
        filename: instance.filename,
        message: (e as Error).message,
      });
    }
  }
  
  return { created, skipped, errors };
}
