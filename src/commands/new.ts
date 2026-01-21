import { Command } from 'commander';
import { join, relative, dirname } from 'path';
import { existsSync } from 'fs';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  discriminatorName,
  getFieldsForType,
  getFrontmatterOrder,
} from '../lib/schema.js';
import { writeNote, generateBodyWithContent, generateBodySections, mergeBodySectionContent, extractSectionItems, parseBodyInput } from '../lib/frontmatter.js';
import {
  resolveVaultDir,
  queryByType,
  formatValue,
  typeCanBeOwned,
  getPossibleOwnerTypes,
  findOwnerNotes,
  ensureOwnedOutputDir,
  type OwnerNoteRef,
} from '../lib/vault.js';
import { getGlobalOpts } from '../lib/command.js';
import {
  promptSelection,
  promptMultiSelect,
  promptInput,
  promptRequired,
  promptMultiInput,
  promptConfirm,
  printError,
  printSuccess,
  printInfo,
  printWarning,
} from '../lib/prompt.js';
import {
  validateFrontmatter,
  applyDefaults,
  validateContextFields,
} from '../lib/validation.js';
import {
  ensureIdInFieldOrder,
  generateUniqueNoteId,
  registerIssuedNoteId,
} from '../lib/note-id.js';
import { validateParentNoCycle } from '../lib/hierarchy.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
  type ExitCode,
  type JsonResult,
} from '../lib/output.js';
import {
  findTemplateByName,
  resolveTemplateWithInheritance,
  processTemplateBody,
  validateConstraints,
  createScaffoldedInstances,
  getFilenamePattern,
  resolveFilenamePattern,
  type ScaffoldResult,
  type InheritedTemplateResolution,
} from '../lib/template.js';
import { evaluateTemplateDefault } from '../lib/date-expression.js';
import { expandStaticValue } from '../lib/local-date.js';
import type { LoadedSchema, Field, BodySection, Template, ResolvedType } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';

// eslint-disable-next-line no-control-regex
const INVALID_ITEM_NAME_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;

function sanitizeItemNameForFilename(name: string): string {
  return name.replace(INVALID_ITEM_NAME_CHARS, '').trim();
}

interface NewCommandOptions {
  open?: boolean;
  json?: string;
  type?: string;
  template?: string;
  noTemplate?: boolean;
  instances?: boolean;  // Set to false when --no-instances is passed
  owner?: string;
  standalone?: boolean;
}

type CreationMode = 'interactive' | 'json';

type OwnershipMode =
  | { kind: 'pooled' }
  | { kind: 'owned'; owner: OwnerNoteRef };

interface PlannedNoteContent {
  frontmatter: Record<string, unknown>;
  body: string;
  orderedFields: string[];
  itemName: string;
}

/**
 * Result of creating a note in JSON mode (includes instance scaffolding info).
 */
interface NoteCreationResult {
  /** Path to the created parent note */
  path: string;
  /** Instance scaffolding results (if any) */
  instances?: {
    created: string[];
    skipped: string[];
    errors: Array<{ type: string; filename?: string | undefined; message: string }>;
  };
}

interface WritePlanArgs {
  schema: LoadedSchema;
  vaultDir: string;
  typePath: string;
  typeDef: ResolvedType;
  ownership: OwnershipMode;
  mode: CreationMode;
  content: PlannedNoteContent;
  template?: Template | null;
}

interface JsonNoteInputResult {
  frontmatter: Record<string, unknown>;
  bodyInput?: Record<string, unknown>;
}

interface FileExistsStrategy {
  onExists: (filePath: string, vaultDir: string) => Promise<void>;
}

class JsonCommandError extends Error {
  result: JsonResult;
  exitCode: ExitCode;

  constructor(result: JsonResult, exitCode: ExitCode) {
    super('JSON command error');
    this.name = 'JsonCommandError';
    this.result = result;
    this.exitCode = exitCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, JsonCommandError);
    }
  }
}

function throwJsonError(result: JsonResult, exitCode: ExitCode): never {
  throw new JsonCommandError(result, exitCode);
}

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, task)')
  .option('-t, --type <type>', 'Type of note to create (alternative to positional argument)')
  .option('-o, --open', 'Open the note after creation (uses BWRB_DEFAULT_APP or Obsidian)')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--template <name>', 'Use a specific template (use "default" for default.md)')
  .option('--no-template', 'Skip template selection, use schema only')
  .option('--no-instances', 'Skip instance scaffolding (when template has instances)')
  .option('--owner <wikilink>', 'Owner note for owned types (e.g., "[[My Novel]]")')
  .option('--standalone', 'Create as standalone (skip owner selection for ownable types)')
  .addHelpText('after', `
Examples:
  bwrb new                    # Interactive type selection
  bwrb new idea               # Create an idea
  bwrb new task               # Create a task
  bwrb new draft --open       # Create and open (respects BWRB_DEFAULT_APP)

Templates:
  bwrb new task --template bug-report  # Use specific template
  bwrb new task --template default     # Use default.md template explicitly
  bwrb new task --no-template          # Skip templates, use schema only

Ownership:
  bwrb new research                        # Prompted: standalone or owned?
  bwrb new research --standalone           # Create in shared location
  bwrb new research --owner "[[My Novel]]" # Create owned by specific note

Instance scaffolding:
  bwrb new draft --template project        # Creates parent + child instances
  bwrb new draft --template project --no-instances  # Skip instances

Non-interactive (JSON) mode:
  bwrb new idea --json '{"name": "My Idea", "status": "raw"}'
  bwrb new task --json '{"name": "Fix bug", "status": "in-progress"}'
  bwrb new task --json '{"name": "Bug"}' --template bug-report

Body sections (JSON mode):
  bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'
  The _body field accepts section names as keys, with string or string[] values.

Template management:
  Templates are managed with 'bwrb template' - see 'bwrb template --help'.

`)
  .action(async (positionalType: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;
    // Merge --type flag with positional argument (flag takes precedence)
    const typePath = options.type ?? positionalType;
    
    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      // JSON mode: non-interactive creation
      if (jsonMode) {
        if (!typePath) {
          const error = 'Type path is required in JSON mode';
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }

        // Resolve template for JSON mode
        let template: Template | null = null;
        if (!options.noTemplate && options.template) {
          template = await findTemplateByName(vaultDir, typePath, options.template);
          if (!template) {
            printJson(jsonError(`Template not found: ${options.template}`));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
        }

        const result = await createNoteFromJson(
          schema,
          vaultDir,
          typePath,
          options.json!,
          template,
          { owner: options.owner, standalone: options.standalone, noInstances: options.instances === false }
        );
        
        // Build JSON output with instances info
        const jsonOutput: Record<string, unknown> = { path: relative(vaultDir, result.path) };
        if (result.instances) {
          jsonOutput.instances = {
            created: result.instances.created.map(p => relative(vaultDir, p)),
            skipped: result.instances.skipped.map(p => relative(vaultDir, p)),
            errors: result.instances.errors,
          };
        }
        printJson(jsonSuccess(jsonOutput));
        
        // Open if requested (uses config.open_with as default)
        if (options.open && result.path) {
          const { openNote, resolveAppMode } = await import('./open.js');
          await openNote(vaultDir, result.path, resolveAppMode(undefined, schema.config), schema.config, false);
        }
        return;
      }

      // Interactive mode: original behavior
      const resolvedPath = await resolveTypePath(schema, typePath);
      if (!resolvedPath) {
        printError('No type selected. Exiting.');
        process.exit(1);
      }

      const typeDef = getTypeDefByPath(schema, resolvedPath);
      if (!typeDef) {
        printError(`Unknown type: ${resolvedPath}`);
        process.exit(1);
      }

      // Resolve template for interactive mode (with inheritance support)
      let templateResolution: InheritedTemplateResolution = {
        template: null,
        mergedDefaults: {},
        mergedConstraints: {},
        mergedPromptFields: [],
        shouldPrompt: false,
        availableTemplates: [],
      };
      
      if (!options.noTemplate) {
        if (options.template) {
          // --template <name>: Find specific template
          templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {
            templateName: options.template,
          });
          if (!templateResolution.template) {
            printError(`Template not found: ${options.template}`);
            process.exit(1);
          }
        } else {
          // No flags: Auto-discover templates with inheritance
          templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {});
          
          if (templateResolution.shouldPrompt && templateResolution.availableTemplates.length > 0) {
            // Multiple templates for this exact type, no default - prompt user
            const templateOptions = [
              ...templateResolution.availableTemplates.map((t: Template) => 
                t.description ? `${t.name} - ${t.description}` : t.name
              ),
              '[No template]'
            ];
            const selected = await promptSelection('Select template:', templateOptions);
            if (selected === null) {
              throw new UserCancelledError();
            }
            if (!selected.startsWith('[No template]')) {
              const selectedName = selected.split(' - ')[0]!;
              const selectedTemplate = templateResolution.availableTemplates.find((t: Template) => t.name === selectedName);
              if (selectedTemplate) {
                // Re-resolve with the selected template to get proper inheritance merging
                templateResolution = await resolveTemplateWithInheritance(vaultDir, resolvedPath, schema, {
                  templateName: selectedName,
                });
              }
            } else {
              // User chose no template - reset to empty resolution
              templateResolution = {
                template: null,
                mergedDefaults: {},
                mergedConstraints: {},
                mergedPromptFields: [],
                shouldPrompt: false,
                availableTemplates: [],
              };
            }
          }
        }
      }

      const filePath = await createNote(schema, vaultDir, resolvedPath, typeDef, templateResolution, {
        owner: options.owner,
        standalone: options.standalone,
        noInstances: options.instances === false,
      });

      // Open if requested (uses config.open_with as default)
      if (options.open && filePath) {
        const { openNote, resolveAppMode } = await import('./open.js');
        await openNote(vaultDir, filePath, resolveAppMode(undefined, schema.config), schema.config, false);
      }
    } catch (err) {
      // Handle user cancellation cleanly
      if (err instanceof UserCancelledError) {
        console.log('Cancelled.');
        process.exit(1);
      }

      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

/**
 * Create a note from JSON input (non-interactive mode).
 */
async function createNoteFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  jsonInput: string,
  template?: Template | null,
  ownershipOptions?: { owner?: string | undefined; standalone?: boolean | undefined; noInstances?: boolean | undefined }
): Promise<NoteCreationResult> {
  try {
    const typeDef = getTypeDefByPath(schema, typePath);
    if (!typeDef) {
      throwJsonError(jsonError(`Unknown type: ${typePath}`), ExitCodes.VALIDATION_ERROR);
    }

    const ownership = await resolveJsonOwnership(schema, vaultDir, typePath, typeDef, ownershipOptions);
    const resolvedTemplate = template ?? null;
    const content = await buildJsonNoteContent(schema, vaultDir, typePath, typeDef, jsonInput, resolvedTemplate);

    const result = await writeNotePlan({
      schema,
      vaultDir,
      typePath,
      typeDef,
      ownership,
      mode: 'json',
      content,
      template: resolvedTemplate,
    },
    {
      onExists: (filePath, baseDir) => {
        throwJsonError(jsonError(`File already exists: ${relative(baseDir, filePath)}`), ExitCodes.IO_ERROR);
      },
    },
    ownershipOptions?.noInstances ?? false);

    return result;
  } catch (err) {
    if (err instanceof JsonCommandError) {
      if (!err.result.success) {
        err.result.code = err.exitCode;
      }
      printJson(err.result);
      process.exit(err.exitCode);
    }
    throw err;
  }
}


/**
 * Generate body content for JSON mode.
 * 
 * Priority:
 * 1. If bodyInput provided: use it to populate sections
 * 2. If template body exists: merge bodyInput into template
 * 3. Fall back to empty schema body_sections
 */
function generateBodyForJson(
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  template?: Template | null,
  bodyInput?: Record<string, unknown>,
  dateFormat?: string
): string {
  const sections = typeDef.bodySections ?? [];
  
  // Parse body input if provided
  let sectionContent: Map<string, string[]> | undefined;
  if (bodyInput && Object.keys(bodyInput).length > 0) {
    // This may throw an error for unknown sections, which will be caught
    // by the try/catch in the action handler and returned as JSON error
    sectionContent = parseBodyInput(bodyInput, sections);
  }

  // Generate body based on what we have
  if (template?.body && sectionContent && sectionContent.size > 0) {
    // Template + body input: start with template, merge in body content
    let body = processTemplateBody(template.body, frontmatter, dateFormat);
    body = mergeBodySectionContent(body, sections, sectionContent);
    return body;
  } else if (template?.body) {
    // Template only: use processed template body
    return processTemplateBody(template.body, frontmatter, dateFormat);
  } else if (sectionContent && sectionContent.size > 0) {
    // Body input only: generate sections with content
    return generateBodyWithContent(sections, sectionContent);
  } else {
    // Neither: generate empty sections from schema
    if (sections.length === 0) {
      return '';
    }
    return generateBodySections(sections);
  }
}

/**
 * Interactively resolve a full type path, navigating through subtypes.
 */
async function resolveTypePath(
  schema: LoadedSchema,
  initialPath?: string
): Promise<string | undefined> {
  let typePath = initialPath;

  // If no type specified, prompt for top-level family
  if (!typePath) {
    const families = getTypeFamilies(schema);
    const selected = await promptSelection('What would you like to create?', families);
    if (!selected) return undefined;
    typePath = selected;
  }

  // Navigate through subtypes (children in v2)
  let typeDef = getTypeDefByPath(schema, typePath);
  let currentTypeName = typePath;

  while (typeDef && hasSubtypes(typeDef)) {
    const subtypes = getSubtypeKeys(typeDef);
    const discLabel = discriminatorName(currentTypeName);
    const selected = await promptSelection(
      `Select ${currentTypeName} subtype (${discLabel}):`,
      subtypes
    );
    if (!selected) return undefined;

    // In v2, children are just type names, not paths
    currentTypeName = selected;
    typeDef = getTypeDefByPath(schema, currentTypeName);
  }

  return currentTypeName;
}

/**
 * Ownership decision result from user prompt or flags.
 */
interface OwnershipDecision {
  /** Whether the note will be owned */
  isOwned: boolean;
  /** The owner note reference (if owned) */
  owner?: OwnerNoteRef;
}

/**
 * Create a new note with the given type.
 * Returns the file path of the created note.
 */
async function createNote(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution,
  options?: { owner?: string | undefined; standalone?: boolean | undefined; noInstances?: boolean | undefined }
): Promise<string> {
  const segments = typePath.split('/');
  const displayTypeName = segments[0] ?? typePath;  // For header display
  const typeName = typeDef.name;  // For ownership checks

  printInfo(`\n=== New ${displayTypeName} ===`);
  
  // Show template info if using one (with inheritance source)
  const template = templateResolution.template;
  if (template) {
    const inheritedSuffix = template.inheritedFrom 
      ? ` (inherited from ${template.inheritedFrom})`
      : '';
    printInfo(`Using template: ${template.name}${template.description ? ` - ${template.description}` : ''}${inheritedSuffix}`);
  }

  const ownership = await resolveInteractiveOwnership(schema, vaultDir, typeName, options?.owner, options?.standalone);
  if (ownership.kind === 'owned') {
    printInfo(`Creating ${typeName} owned by ${ownership.owner.ownerName}`);
  }

  const content = await buildInteractiveNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
  const fileExistsStrategy: FileExistsStrategy = {
    onExists: async (filePath: string) => {
      printWarning(`\nWarning: File already exists: ${filePath}`);
      const overwrite = await promptConfirm('Overwrite?');
      if (overwrite === null) {
        throw new UserCancelledError();
      }
      if (overwrite === false) {
        console.log('Aborted.');
        process.exit(1);
      }
    },
  };

  const result = await writeNotePlan({
    schema,
    vaultDir,
    typePath,
    typeDef,
    ownership,
    mode: 'interactive',
    content,
    template,
  },
  fileExistsStrategy,
  options?.noInstances ?? false);

  if (ownership.kind === 'owned') {
    printSuccess(`\n✓ Created: ${relative(vaultDir, result.path)}`);
    printInfo(`  Owned by: ${ownership.owner.ownerName}`);
  } else {
    printSuccess(`\n✓ Created: ${result.path}`);
  }

  return result.path;
}

/**
 * Create a note in pooled mode (standard flat directory).
 */

/**
 * Build frontmatter and body content for a note.
 * 
 * When a template resolution is provided:
 * - Merged defaults from inheritance chain are used (skip prompting)
 * - Fields in merged promptFields are still prompted
 * - Template body is used instead of schema body_sections
 */
async function buildNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution
): Promise<{ frontmatter: Record<string, unknown>; body: string; orderedFields: string[] }> {
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  // Always inject the type field with the type name
  // In the new inheritance model, type is auto-injected, not a field definition
  frontmatter['type'] = typeDef.name;

  // Get merged defaults and prompt-fields from template inheritance chain
  const template = templateResolution.template;
  const mergedDefaults = templateResolution.mergedDefaults;
  const promptFields = new Set(templateResolution.mergedPromptFields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    // Check if merged defaults provide a value for this field
    // (already evaluated during resolution)
    const mergedDefault = mergedDefaults[fieldName];
    const hasDefault = mergedDefault !== undefined;
    const shouldPrompt = !hasDefault || promptFields.has(fieldName);

    if (hasDefault && !shouldPrompt) {
      // Use merged default without prompting (already evaluated)
      frontmatter[fieldName] = mergedDefault;
    } else {
      // Prompt as normal
      const value = await promptField(schema, vaultDir, fieldName, field);
      if (value !== undefined && value !== '') {
        frontmatter[fieldName] = value;
      }
    }
  }

  // Validate merged template constraints (after all prompts, before creating note)
  const mergedConstraints = templateResolution.mergedConstraints;
  if (Object.keys(mergedConstraints).length > 0) {
    const constraintResult = validateConstraints(frontmatter, mergedConstraints);
    if (!constraintResult.valid) {
      printError('\nTemplate constraint validation failed:');
      for (const error of constraintResult.errors) {
        printError(`  - ${error.field}: ${error.message}`);
      }
      throw new Error('Template constraints not satisfied');
    }
  }

  // Generate body content
  // If we have a template body, use it as the base and merge in prompted sections
  // If no template, prompt for schema body_sections from scratch
  let body = '';
  const bodySections = typeDef.bodySections;
  const promptableSections = bodySections?.filter(s => s.prompt === 'list') ?? [];
  
  if (template?.body) {
    // Start with processed template body
    body = processTemplateBody(template.body, frontmatter, schema.config.dateFormat);
    
    // If there are promptable body sections, prompt for additional items
    if (promptableSections.length > 0) {
      const sectionContent = await promptBodySections(promptableSections, body);
      if (sectionContent.size > 0) {
        body = mergeBodySectionContent(body, promptableSections, sectionContent);
      }
    }
  } else if (bodySections && bodySections.length > 0) {
    // No template - prompt for body sections from schema
    const sectionContent = await promptBodySections(promptableSections, undefined);
    body = generateBodyWithContent(bodySections, sectionContent);
  }

  return { frontmatter, body, orderedFields };
}

async function buildInteractiveNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution
): Promise<PlannedNoteContent> {
  const template = templateResolution.template;
  const filenamePattern = getFilenamePattern(template ?? null, typeDef);

  if (filenamePattern) {
    const content = await buildNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
    const patternResult = resolveFilenamePattern(filenamePattern, content.frontmatter, schema.config.dateFormat);

    if (patternResult.resolved && patternResult.filename) {
      return {
        ...content,
        itemName: patternResult.filename,
      };
    }

    if (patternResult.missingFields.length > 0) {
      printWarning(`Filename pattern references missing fields: ${patternResult.missingFields.join(', ')}`);
    }

    const prompted = await promptRequired('Name');
    if (prompted === null) {
      throw new UserCancelledError();
    }

    return {
      ...content,
      itemName: prompted,
    };
  }

  const prompted = await promptRequired('Name');
  if (prompted === null) {
    throw new UserCancelledError();
  }

  const content = await buildNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
  return {
    ...content,
    itemName: prompted,
  };
}

async function buildJsonNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  jsonInput: string,
  template?: Template | null
): Promise<PlannedNoteContent> {
  const { frontmatter, bodyInput } = parseJsonNoteInput(jsonInput);
  const mergedInput = mergeJsonTemplateDefaults(schema, frontmatter, template);
  await validateJsonFrontmatter(schema, vaultDir, typePath, typeDef, mergedInput, template);
  const resolvedFrontmatter = applyDefaults(schema, typePath, mergedInput);

  const itemName = resolveJsonItemName(schema, typeDef, resolvedFrontmatter, template);
  const body = generateBodyForJson(typeDef, resolvedFrontmatter, template, bodyInput, schema.config.dateFormat);
  const orderedFields = resolveOrderedFields(typeDef, resolvedFrontmatter);

  return {
    frontmatter: resolvedFrontmatter,
    body,
    orderedFields,
    itemName,
  };
}

function parseJsonNoteInput(jsonInput: string): JsonNoteInputResult {
  let inputData: Record<string, unknown>;
  try {
    inputData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    throwJsonError(jsonError(error), ExitCodes.VALIDATION_ERROR);
  }

  const { _body: rawBodyInput, ...frontmatterInput } = inputData;
  if ('id' in frontmatterInput) {
    throwJsonError(
      jsonError("Frontmatter field 'id' is reserved and cannot be set in --json mode"),
      ExitCodes.VALIDATION_ERROR
    );
  }

  let bodyInput: Record<string, unknown> | undefined;
  if (rawBodyInput !== undefined && rawBodyInput !== null) {
    if (typeof rawBodyInput !== 'object' || Array.isArray(rawBodyInput)) {
      throwJsonError(jsonError('_body must be an object with section names as keys'), ExitCodes.VALIDATION_ERROR);
    }
    bodyInput = rawBodyInput as Record<string, unknown>;
  }

  if (bodyInput === undefined) {
    return { frontmatter: frontmatterInput };
  }

  return { frontmatter: frontmatterInput, bodyInput };
}

function mergeJsonTemplateDefaults(
  schema: LoadedSchema,
  frontmatterInput: Record<string, unknown>,
  template?: Template | null
): Record<string, unknown> {
  if (!template?.defaults) {
    return { ...frontmatterInput };
  }

  const evaluatedDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template.defaults)) {
    evaluatedDefaults[key] = evaluateTemplateDefault(value, schema.config.dateFormat);
  }

  return { ...evaluatedDefaults, ...frontmatterInput };
}

async function validateJsonFrontmatter(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  mergedInput: Record<string, unknown>,
  template?: Template | null
): Promise<void> {
  const validation = validateFrontmatter(schema, typePath, mergedInput);
  if (!validation.valid) {
    throwJsonError({
      success: false,
      error: 'Validation failed',
      errors: validation.errors.map(e => ({
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
        ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
      })),
    }, ExitCodes.VALIDATION_ERROR);
  }

  const contextValidation = await validateContextFields(schema, vaultDir, typePath, mergedInput);
  if (!contextValidation.valid) {
    throwJsonError({
      success: false,
      error: 'Context field validation failed',
      errors: contextValidation.errors.map(e => ({
        type: e.type,
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
      })),
    }, ExitCodes.VALIDATION_ERROR);
  }

  if (template?.constraints) {
    const constraintResult = validateConstraints(mergedInput, template.constraints);
    if (!constraintResult.valid) {
      throwJsonError({
        success: false,
        error: 'Template constraint validation failed',
        errors: constraintResult.errors.map(e => ({
          field: e.field,
          message: e.message,
          constraint: e.constraint,
        })),
      }, ExitCodes.VALIDATION_ERROR);
    }
  }

  if (typeDef.recursive && mergedInput['parent']) {
    const cycleError = await validateParentNoCycle(
      schema,
      vaultDir,
      mergedInput['name'] as string,
      mergedInput['parent'] as string
    );
    if (cycleError) {
      throwJsonError({
        success: false,
        error: cycleError.message,
        errors: [{
          field: cycleError.field,
          message: cycleError.message,
        }],
      }, ExitCodes.VALIDATION_ERROR);
    }
  }
}

function resolveJsonItemName(
  schema: LoadedSchema,
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  template?: Template | null
): string {
  const filenamePattern = getFilenamePattern(template ?? null, typeDef);

  if (filenamePattern) {
    const patternResult = resolveFilenamePattern(filenamePattern, frontmatter, schema.config.dateFormat);

    if (patternResult.resolved && patternResult.filename) {
      return patternResult.filename;
    }

    const nameField = frontmatter['name'];
    if (!nameField || typeof nameField !== 'string') {
      const missingInfo = patternResult.missingFields.length > 0
        ? ` Pattern references missing fields: ${patternResult.missingFields.join(', ')}.`
        : '';
      throwJsonError(
        jsonError(`Filename pattern could not be resolved.${missingInfo} Provide a 'name' field as fallback.`),
        ExitCodes.VALIDATION_ERROR
      );
    }
    return nameField;
  }

  const nameField = frontmatter['name'];
  if (!nameField || typeof nameField !== 'string') {
    throwJsonError(jsonError('Missing or invalid \'name\' field'), ExitCodes.VALIDATION_ERROR);
  }

  return nameField;
}

function resolveOrderedFields(typeDef: ResolvedType, frontmatter: Record<string, unknown>): string[] {
  const fieldOrder = getFrontmatterOrder(typeDef);
  return fieldOrder.length > 0 ? fieldOrder : Object.keys(frontmatter);
}

// ============================================================================
// Ownership Flow
// ============================================================================

async function resolveInteractiveOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  ownerArg?: string,
  standaloneArg?: boolean
): Promise<OwnershipMode> {
  const canBeOwned = typeCanBeOwned(schema, typeName);
  if (canBeOwned && !standaloneArg) {
    const ownershipDecision = await resolveOwnership(schema, vaultDir, typeName, ownerArg);
    if (ownershipDecision.isOwned && ownershipDecision.owner) {
      return { kind: 'owned', owner: ownershipDecision.owner };
    }
  }

  return { kind: 'pooled' };
}

async function resolveJsonOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  ownershipOptions?: { owner?: string | undefined; standalone?: boolean | undefined }
): Promise<OwnershipMode> {
  const ownerArg = ownershipOptions?.owner;
  const standaloneArg = ownershipOptions?.standalone;

  if (ownerArg && standaloneArg) {
    throwJsonError(jsonError('Cannot use both --owner and --standalone flags together'), ExitCodes.VALIDATION_ERROR);
  }

  const typeName = typeDef.name;
  const canBeOwned = typeCanBeOwned(schema, typeName);

  if (standaloneArg && !canBeOwned) {
    throwJsonError(
      jsonError(`Type '${typePath}' cannot be owned, so --standalone is not applicable.`),
      ExitCodes.VALIDATION_ERROR
    );
  }

  if (ownerArg) {
    if (!canBeOwned) {
      throwJsonError(
        jsonError(`Type '${typePath}' cannot be owned. Remove the --owner flag.`),
        ExitCodes.VALIDATION_ERROR
      );
    }

    const owner = await findOwnerFromArg(schema, vaultDir, typeName, ownerArg);
    if (!owner) {
      throwJsonError(jsonError(`Owner not found: ${ownerArg}`), ExitCodes.VALIDATION_ERROR);
    }
    return { kind: 'owned', owner };
  }

  return { kind: 'pooled' };
}

/**
 * Resolve ownership for a note that can be owned.
 * Either uses --owner flag, or prompts interactively.
 */
async function resolveOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  ownerArg?: string
): Promise<OwnershipDecision> {
  // If --owner flag provided, parse and find the owner
  if (ownerArg) {
    const owner = await findOwnerFromArg(schema, vaultDir, typeName, ownerArg);
    if (!owner) {
      throw new Error(`Owner not found: ${ownerArg}`);
    }
    return { isOwned: true, owner };
  }
  
  // Get possible owner types for this child type
  const ownerTypes = getPossibleOwnerTypes(schema, typeName);
  if (ownerTypes.length === 0) {
    // No owner types defined - shouldn't happen if canBeOwned was true
    return { isOwned: false };
  }
  
  // Check if any owners exist
  let hasAnyOwners = false;
  for (const ownerInfo of ownerTypes) {
    const owners = await findOwnerNotes(schema, vaultDir, ownerInfo.ownerType);
    if (owners.length > 0) {
      hasAnyOwners = true;
      break;
    }
  }
  
  // If no owners exist, default to standalone
  if (!hasAnyOwners) {
    return { isOwned: false };
  }
  
  // Build ownership options for prompt
  // Format: "Standalone (shared)" and "Owned by a {type}" for each owner type
  const options: string[] = ['Standalone (shared)'];
  for (const ownerInfo of ownerTypes) {
    options.push(`Owned by a ${ownerInfo.ownerType}`);
  }
  
  const selected = await promptSelection('This type can be owned. Create as:', options);
  if (selected === null) {
    throw new UserCancelledError();
  }
  
  if (selected === 'Standalone (shared)') {
    return { isOwned: false };
  }
  
  // Extract owner type from selection
  const match = selected.match(/^Owned by a (.+)$/);
  if (!match) {
    return { isOwned: false };
  }
  
  const selectedOwnerType = match[1]!;
  
  // Now prompt for which specific owner instance
  const owners = await findOwnerNotes(schema, vaultDir, selectedOwnerType);
  if (owners.length === 0) {
    printWarning(`No ${selectedOwnerType} notes found. Creating as standalone.`);
    return { isOwned: false };
  }
  
  const ownerOptions = owners.map(o => o.ownerName);
  const selectedOwner = await promptSelection(`Select ${selectedOwnerType}:`, ownerOptions);
  if (selectedOwner === null) {
    throw new UserCancelledError();
  }
  
  const owner = owners.find(o => o.ownerName === selectedOwner);
  if (!owner) {
    throw new Error(`Owner not found: ${selectedOwner}`);
  }
  
  return { isOwned: true, owner };
}

/**
 * Find an owner from a --owner argument (wikilink format).
 */
async function findOwnerFromArg(
  schema: LoadedSchema,
  vaultDir: string,
  childTypeName: string,
  ownerArg: string
): Promise<OwnerNoteRef | undefined> {
  // Parse wikilink format: "[[Note Name]]", [[Note Name]], or just "Note Name"
  // Strip quotes first (they may wrap the entire wikilink), then brackets
  const ownerName = ownerArg
    .replace(/^"/, '').replace(/"$/, '')   // Strip surrounding quotes first
    .replace(/^\[\[/, '').replace(/\]\]$/, '');  // Then strip wikilink brackets
  
  // Get possible owner types
  const ownerTypes = getPossibleOwnerTypes(schema, childTypeName);
  
  // Search for the owner in each possible owner type
  for (const ownerInfo of ownerTypes) {
    const owners = await findOwnerNotes(schema, vaultDir, ownerInfo.ownerType);
    const match = owners.find(o => o.ownerName === ownerName);
    if (match) {
      return match;
    }
  }
  
  return undefined;
}


/**
 * Get output directory for a type, walking up the hierarchy.
 */
function getOutputDirForType(schema: LoadedSchema, typePath: string): string | undefined {
  // Use the type's outputDir from the resolved type
  const typeDef = getTypeDefByPath(schema, typePath);
  return typeDef?.outputDir;
}

async function writeNotePlan(
  args: WritePlanArgs,
  fileExistsStrategy: FileExistsStrategy,
  skipInstances: boolean
): Promise<NoteCreationResult> {
  const outputDir = await resolveOutputDir(args.schema, args.vaultDir, args.typePath, args.typeDef, args.ownership, args.mode);
  const filePath = buildNotePath(outputDir, args.content.itemName, args.mode);

  if (existsSync(filePath)) {
    await fileExistsStrategy.onExists(filePath, args.vaultDir);
  }

  const noteId = await generateUniqueNoteId(args.vaultDir);
  args.content.frontmatter['id'] = noteId;
  const orderedFields = ensureIdInFieldOrder(args.content.orderedFields);

  await writeNote(filePath, args.content.frontmatter, args.content.body, orderedFields);
  await registerIssuedNoteId(args.vaultDir, noteId, filePath);

  let scaffoldResult: ScaffoldResult | null = null;
  if (args.template) {
    scaffoldResult = await handleInstanceScaffolding(
      args.schema,
      args.vaultDir,
      filePath,
      args.typeDef.name,
      args.template,
      args.content.frontmatter,
      skipInstances,
      args.mode === 'json'
    );
  }

  const result: NoteCreationResult = { path: filePath };
  if (args.mode === 'json' && scaffoldResult) {
    result.instances = {
      created: scaffoldResult.created,
      skipped: scaffoldResult.skipped,
      errors: scaffoldResult.errors.map(e => ({
        type: e.subtype,
        filename: e.filename,
        message: e.message,
      })),
    };
  }

  return result;
}

async function resolveOutputDir(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  ownership: OwnershipMode,
  mode: CreationMode
): Promise<string> {
  if (ownership.kind === 'owned') {
    return ensureOwnedOutputDir(ownership.owner.ownerPath, typeDef.name);
  }

  const outputDir = getOutputDirForType(schema, typePath);
  if (!outputDir) {
    if (mode === 'json') {
      throwJsonError(jsonError(`No output_dir defined for type: ${typePath}`), ExitCodes.SCHEMA_ERROR);
    }
    printError(`No output_dir defined for type: ${typePath}`);
    process.exit(1);
  }

  return join(vaultDir, outputDir);
}

function buildNotePath(outputDir: string, itemName: string, mode: CreationMode): string {
  const sanitizedItemName = sanitizeItemNameForFilename(itemName);
  if (!sanitizedItemName) {
    if (mode === 'json') {
      throwJsonError(jsonError('Invalid note name (empty after sanitizing)'), ExitCodes.VALIDATION_ERROR);
    }
    printError('Invalid name (empty after sanitizing)');
    process.exit(1);
  }

  return join(outputDir, `${sanitizedItemName}.md`);
}


/**
 * Prompt for a single frontmatter field value.
 * Throws UserCancelledError if user cancels any prompt.
 */
async function promptField(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field
): Promise<unknown> {
  // Static value
  if (field.value !== undefined) {
    return expandStaticValue(field.value, new Date(), schema.config.dateFormat);
  }

  // Prompt-based value
  switch (field.prompt) {
    case 'select': {
      if (!field.options || field.options.length === 0) return field.default;
      const selectOptions = field.options;
      
      // Multi-select mode
      if (field.multiple) {
        const selected = await promptMultiSelect(`Select ${fieldName}:`, selectOptions);
        if (selected === null) {
          throw new UserCancelledError();
        }
        // Return array (may be empty if nothing selected)
        return selected.length > 0 ? selected : (field.default ?? []);
      }
      
      // Single-select mode
      // For optional fields, add a skip option
      let options: string[];
      let skipLabel: string | undefined;
      if (!field.required) {
        const defaultStr = field.default !== undefined ? String(field.default) : undefined;
        skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
        options = [skipLabel, ...selectOptions];
      } else {
        options = selectOptions;
      }
      
      const selected = await promptSelection(`Select ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected skip, return the default value
      if (skipLabel && selected === skipLabel) {
        return field.default ?? '';
      }
      return selected;
    }

    case 'relation': {
      if (!field.source) return field.default;
      const dynamicOptions = await queryByType(schema, vaultDir, field.source, field.filter);
      if (dynamicOptions.length === 0) {
        printWarning(`No options available for ${fieldName}`);
        return field.default ?? '';
      }
      
      // For optional fields, add a skip option
      let options: string[];
      let skipLabel: string | undefined;
      if (!field.required) {
        const defaultStr = field.default !== undefined ? String(field.default) : undefined;
        skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
        options = [skipLabel, ...dynamicOptions];
      } else {
        options = dynamicOptions;
      }
      
      const selected = await promptSelection(`Select ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected skip, return the default value
      if (skipLabel && selected === skipLabel) {
        return field.default ?? '';
      }
      return formatValue(selected, schema.config.linkFormat);
    }

    case 'text': {
      const label = field.label ?? fieldName;
      if (field.required) {
        const value = await promptRequired(label);
        if (value === null) {
          throw new UserCancelledError();
        }
        return value;
      }
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      const value = await promptInput(label, defaultVal);
      if (value === null) {
        throw new UserCancelledError();
      }
      return value;
    }

    case 'list': {
      const label = field.label ?? fieldName;
      const items = await promptMultiInput(label);
      if (items === null) {
        throw new UserCancelledError();
      }
      if (field.list_format === 'comma-separated') {
        return items.join(', ');
      }
      return items;
    }

    case 'date': {
      const label = field.label ?? fieldName;
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      const value = await promptInput(label, defaultVal);
      if (value === null) {
        throw new UserCancelledError();
      }
      return value;
    }

    case 'boolean': {
      const label = field.label ?? fieldName;
      const result = await promptConfirm(label);
      if (result === null) {
        throw new UserCancelledError();
      }
      return result;
    }

    case 'number': {
      const label = field.label ?? fieldName;
      const defaultVal = field.default !== undefined ? String(field.default) : undefined;
      // Loop until valid input
      while (true) {
        const value = await promptInput(label, defaultVal);
        if (value === null) {
          throw new UserCancelledError();
        }
        if (value === '') {
          return field.default;
        }
        const parsed = parseFloat(value);
        if (isNaN(parsed)) {
          printWarning(`Invalid number: "${value}". Please enter a valid number.`);
          continue;
        }
        return parsed;
      }
    }

    default:
      return field.default;
  }
}

// ============================================================================
// Instance Scaffolding
// ============================================================================

/**
 * Handle instance scaffolding for a parent template.
 * Creates all specified child instances in the parent's directory.
 * 
 * @returns The scaffold result with created/skipped/errors
 */
async function handleInstanceScaffolding(
  schema: LoadedSchema,
  vaultDir: string,
  parentFilePath: string,
  parentTypeName: string,
  template: Template,
  frontmatter: Record<string, unknown>,
  skipInstances: boolean,
  isJsonMode: boolean
): Promise<ScaffoldResult | null> {
  // Skip if --no-instances flag is set
  if (skipInstances) {
    return null;
  }
  
  // Skip if no instances defined
  if (!template.instances || template.instances.length === 0) {
    return null;
  }
  
  // Determine instance directory (same folder as parent note)
  const instanceDir = dirname(parentFilePath);
  
  // Create scaffolded instances
  const result = await createScaffoldedInstances(
    schema,
    vaultDir,
    parentTypeName,
    instanceDir,
    template.instances,
    frontmatter
  );
  
  // Print output for interactive mode
  if (!isJsonMode && (result.created.length > 0 || result.skipped.length > 0 || result.errors.length > 0)) {
    printInstanceScaffoldOutput(vaultDir, result);
  }
  
  return result;
}

/**
 * Print CLI output for instance scaffolding.
 */
function printInstanceScaffoldOutput(vaultDir: string, result: ScaffoldResult): void {
  
  // Print created files
  if (result.created.length > 0) {
    printInfo(`\nInstances created:`);
    for (const path of result.created) {
      printSuccess(`  ✓ ${relative(vaultDir, path)}`);
    }
  }
  
  // Print skipped files
  if (result.skipped.length > 0) {
    printInfo(`\nInstances skipped (already exist):`);
    for (const path of result.skipped) {
      printWarning(`  - ${relative(vaultDir, path)}`);
    }
  }
  
  // Print errors
  if (result.errors.length > 0) {
    printError(`\nInstance errors:`);
    for (const err of result.errors) {
      printError(`  ✗ ${err.subtype}${err.filename ? ` (${err.filename})` : ''}: ${err.message}`);
    }
  }
  
  // Print summary
  if (result.created.length > 0) {
    printInfo(`\n✓ Created ${result.created.length + 1} files (1 parent + ${result.created.length} instances)`);
  }
}

/**
 * Prompt for body section content.
 * If templateBody is provided, shows existing items and asks for additions.
 * Throws UserCancelledError if user cancels any prompt.
 */
async function promptBodySections(
  sections: BodySection[],
  templateBody?: string
): Promise<Map<string, string[]>> {
  const content = new Map<string, string[]>();

  for (const section of sections) {
    if (section.prompt === 'list' && section.prompt_label) {
      // If we have a template body, extract existing items and show them
      if (templateBody) {
        const existingItems = extractSectionItems(
          templateBody,
          section.title,
          section.content_type
        );
        
        if (existingItems.length > 0) {
          // Show existing items from template
          printInfo(`\n${section.title} (from template):`);
          for (const item of existingItems) {
            const prefix = section.content_type === 'checkboxes' ? '  - [ ]' : '  -';
            console.log(`${prefix} ${item}`);
          }
        }
        
        // Ask for additional items
        const label = `Additional ${section.prompt_label}`;
        const items = await promptMultiInput(label);
        if (items === null) {
          throw new UserCancelledError();
        }
        if (items.length > 0) {
          content.set(section.title, items);
        }
      } else {
        // No template - just prompt normally
        const items = await promptMultiInput(section.prompt_label);
        if (items === null) {
          throw new UserCancelledError();
        }
        if (items.length > 0) {
          content.set(section.title, items);
        }
      }
    }

    // Recursively handle children
    if (section.children && section.children.length > 0) {
      const childContent = await promptBodySections(section.children, templateBody);
      for (const [key, value] of childContent) {
        content.set(key, value);
      }
    }
  }

  return content;
}
