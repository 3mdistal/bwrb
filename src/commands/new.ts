import { Command } from 'commander';
import { join, relative } from 'path';
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
  getEnumValues,
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
import {
  promptSelection,
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
import { validateParentNoCycle } from '../lib/hierarchy.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import {
  findTemplateByName,
  resolveTemplate,
  processTemplateBody,
  validateConstraints,
} from '../lib/template.js';
import { evaluateTemplateDefault } from '../lib/date-expression.js';
import type { LoadedSchema, Field, BodySection, Template, ResolvedType } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';

interface NewCommandOptions {
  open?: boolean;
  json?: string;
  type?: string;
  template?: string;
  noTemplate?: boolean;
  owner?: string;
  standalone?: boolean;
}

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, objective/task)')
  .option('-t, --type <type>', 'Type of note to create (alternative to positional argument)')
  .option('--open', 'Open the note after creation (uses BWRB_DEFAULT_APP or Obsidian)')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--template <name>', 'Use a specific template (use "default" for default.md)')
  .option('--no-template', 'Skip template selection, use schema only')
  .option('--owner <wikilink>', 'Owner note for owned types (e.g., "[[My Novel]]")')
  .option('--standalone', 'Create as standalone (skip owner selection for ownable types)')
  .addHelpText('after', `
Examples:
  bwrb new                    # Interactive type selection
  bwrb new idea               # Create an idea
  bwrb new objective/task     # Create a task
  bwrb new draft --open       # Create and open (respects BWRB_DEFAULT_APP)

Templates:
  bwrb new task --template bug-report  # Use specific template
  bwrb new task --template default     # Use default.md template explicitly
  bwrb new task --no-template          # Skip templates, use schema only

Ownership:
  bwrb new research                        # Prompted: standalone or owned?
  bwrb new research --standalone           # Create in shared location
  bwrb new research --owner "[[My Novel]]" # Create owned by specific note

Non-interactive (JSON) mode:
  bwrb new idea --json '{"name": "My Idea", "status": "raw"}'
  bwrb new objective/task --json '{"name": "Fix bug", "status": "in-progress"}'
  bwrb new task --json '{"name": "Bug"}' --template bug-report

Body sections (JSON mode):
  bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'
  The _body field accepts section names as keys, with string or string[] values.

Template Discovery:
  Templates are stored in Templates/{type}/{subtype}/*.md
  If default.md exists, it's used automatically (unless --no-template).
  If multiple templates exist without default.md, you'll be prompted to select.

`)
  .action(async (positionalType: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;
    // Merge --type flag with positional argument (flag takes precedence)
    const typePath = options.type ?? positionalType;
    
    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
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

        const filePath = await createNoteFromJson(
          schema,
          vaultDir,
          typePath,
          options.json!,
          template,
          { owner: options.owner, standalone: options.standalone }
        );
        
        printJson(jsonSuccess({ path: relative(vaultDir, filePath) }));
        
        // Open if requested (respects BWRB_DEFAULT_APP)
        if (options.open && filePath) {
          const { openNote, parseAppMode } = await import('./open.js');
          await openNote(vaultDir, filePath, parseAppMode(), false);
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

      // Resolve template for interactive mode
      let template: Template | null = null;
      if (!options.noTemplate) {
        if (options.template) {
          // --template <name>: Find specific template (use "default" for default.md)
          template = await findTemplateByName(vaultDir, resolvedPath, options.template);
          if (!template) {
            printError(`Template not found: ${options.template}`);
            process.exit(1);
          }
        } else {
          // No flags: Auto-discover templates
          const resolution = await resolveTemplate(vaultDir, resolvedPath, {});
          template = resolution.template;
          
          if (resolution.shouldPrompt && resolution.availableTemplates.length > 0) {
            // Multiple templates, no default - prompt user
            const templateOptions = [
              ...resolution.availableTemplates.map(t => 
                t.description ? `${t.name} - ${t.description}` : t.name
              ),
              '[No template]'
            ];
            const selected = await promptSelection('Select template:', templateOptions);
            if (selected === null) {
              throw new UserCancelledError();
            }
            if (!selected.startsWith('[No template]')) {
              const selectedName = selected.split(' - ')[0];
              template = resolution.availableTemplates.find(t => t.name === selectedName) ?? null;
            }
          }
        }
      }

      const filePath = await createNote(schema, vaultDir, resolvedPath, typeDef, template, {
        owner: options.owner,
        standalone: options.standalone,
      });

      // Open if requested (respects BWRB_DEFAULT_APP)
      if (options.open && filePath) {
        const { openNote, parseAppMode } = await import('./open.js');
        await openNote(vaultDir, filePath, parseAppMode(), false);
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
  ownershipOptions?: { owner?: string | undefined; standalone?: boolean | undefined }
): Promise<string> {
  // Parse JSON input
  let inputData: Record<string, unknown>;
  try {
    inputData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Get type definition
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printJson(jsonError(`Unknown type: ${typePath}`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Validate ownership flags
  const ownerArg = ownershipOptions?.owner;
  const standaloneArg = ownershipOptions?.standalone;
  
  // Error if both --owner and --standalone are provided
  if (ownerArg && standaloneArg) {
    printJson(jsonError('Cannot use both --owner and --standalone flags together'));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }
  
  const typeName = typeDef.name;
  const canBeOwned = typeCanBeOwned(schema, typeName);
  
  // Error if --standalone is used on a type that cannot be owned (meaningless flag)
  if (standaloneArg && !canBeOwned) {
    printJson(jsonError(`Type '${typePath}' cannot be owned, so --standalone is not applicable.`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }
  
  // Resolve ownership if --owner is provided
  let owner: OwnerNoteRef | undefined;
  if (ownerArg) {
    if (!canBeOwned) {
      printJson(jsonError(`Type '${typePath}' cannot be owned. Remove the --owner flag.`));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    
    owner = await findOwnerFromArg(schema, vaultDir, typeName, ownerArg);
    if (!owner) {
      printJson(jsonError(`Owner not found: ${ownerArg}`));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  }

  // Extract _body from input (special field for body section content)
  const { _body: rawBodyInput, ...frontmatterInput } = inputData;
  
  // Validate _body if provided
  let bodyInput: Record<string, unknown> | undefined;
  if (rawBodyInput !== undefined && rawBodyInput !== null) {
    if (typeof rawBodyInput !== 'object' || Array.isArray(rawBodyInput)) {
      printJson(jsonError('_body must be an object with section names as keys'));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    bodyInput = rawBodyInput as Record<string, unknown>;
  }

  // Apply template defaults first, then JSON input overrides them
  let mergedInput = { ...frontmatterInput };
  if (template?.defaults) {
    // Evaluate date expressions in template defaults (e.g., today() + '7d')
    const evaluatedDefaults: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template.defaults)) {
      evaluatedDefaults[key] = evaluateTemplateDefault(value);
    }
    // Template defaults are base, JSON input takes precedence
    mergedInput = { ...evaluatedDefaults, ...frontmatterInput };
  }

  // Validate and apply defaults
  const validation = validateFrontmatter(schema, typePath, mergedInput);
  if (!validation.valid) {
    // Convert validation result to JSON error format
    printJson({
      success: false,
      error: 'Validation failed',
      errors: validation.errors.map(e => ({
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
        ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
      })),
    });
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Apply schema defaults for missing fields
  const frontmatter = applyDefaults(schema, typePath, mergedInput);

  // Validate context fields (source type constraints)
  const contextValidation = await validateContextFields(schema, vaultDir, typePath, mergedInput);
  if (!contextValidation.valid) {
    printJson({
      success: false,
      error: 'Context field validation failed',
      errors: contextValidation.errors.map(e => ({
        type: e.type,
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
      })),
    });
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Validate template constraints
  if (template?.constraints) {
    const constraintResult = validateConstraints(frontmatter, template.constraints);
    if (!constraintResult.valid) {
      printJson({
        success: false,
        error: 'Template constraint validation failed',
        errors: constraintResult.errors.map(e => ({
          field: e.field,
          message: e.message,
          constraint: e.constraint,
        })),
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  }

  // Validate parent field doesn't create a cycle (for recursive types)
  if (typeDef.recursive && frontmatter['parent']) {
    const cycleError = await validateParentNoCycle(
      schema,
      vaultDir,
      frontmatter['name'] as string,
      frontmatter['parent'] as string
    );
    if (cycleError) {
      printJson({
        success: false,
        error: cycleError.message,
        errors: [{
          field: cycleError.field,
          message: cycleError.message,
        }],
      });
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  }

  // Get the name from the frontmatter (always 'name')
  const itemName = frontmatter['name'];
  if (!itemName || typeof itemName !== 'string') {
    printJson(jsonError(`Missing or invalid 'name' field`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Create note (owned or pooled)
  if (owner) {
    const filePath = await createOwnedNoteFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      itemName,
      owner,
      template,
      bodyInput
    );
    return filePath;
  }

  // Create pooled note (default behavior)
  const filePath = await createPooledNoteFromJson(
    schema,
    vaultDir,
    typePath,
    typeDef,
    frontmatter,
    itemName,
    template,
    bodyInput
  );

  return filePath;
}

/**
 * Create a pooled note from JSON input.
 */
async function createPooledNoteFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  itemName: string,
  template?: Template | null,
  bodyInput?: Record<string, unknown>
): Promise<string> {
  const outputDir = getOutputDirForType(schema, typePath);
  if (!outputDir) {
    printJson(jsonError(`No output_dir defined for type: ${typePath}`));
    process.exit(ExitCodes.SCHEMA_ERROR);
  }

  const fullOutputDir = join(vaultDir, outputDir);
  const filePath = join(fullOutputDir, `${itemName}.md`);

  if (existsSync(filePath)) {
    printJson(jsonError(`File already exists: ${relative(vaultDir, filePath)}`));
    process.exit(ExitCodes.IO_ERROR);
  }

  // Generate body content
  const body = generateBodyForJson(typeDef, frontmatter, template, bodyInput);
  
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(frontmatter);

  await writeNote(filePath, frontmatter, body, orderedFields);
  return filePath;
}

/**
 * Create an owned note from JSON input.
 */
async function createOwnedNoteFromJson(
  _schema: LoadedSchema,
  vaultDir: string,
  _typePath: string,
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  itemName: string,
  owner: OwnerNoteRef,
  template?: Template | null,
  bodyInput?: Record<string, unknown>
): Promise<string> {
  const typeName = typeDef.name;
  
  // Ensure the owned output directory exists
  const outputDir = await ensureOwnedOutputDir(owner.ownerPath, typeName);
  const filePath = join(outputDir, `${itemName}.md`);

  if (existsSync(filePath)) {
    printJson(jsonError(`File already exists: ${relative(vaultDir, filePath)}`));
    process.exit(ExitCodes.IO_ERROR);
  }

  // Generate body content
  const body = generateBodyForJson(typeDef, frontmatter, template, bodyInput);
  
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(frontmatter);

  await writeNote(filePath, frontmatter, body, orderedFields);
  return filePath;
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
  bodyInput?: Record<string, unknown>
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
    let body = processTemplateBody(template.body, frontmatter);
    body = mergeBodySectionContent(body, sections, sectionContent);
    return body;
  } else if (template?.body) {
    // Template only: use processed template body
    return processTemplateBody(template.body, frontmatter);
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
  template?: Template | null,
  options?: { owner?: string | undefined; standalone?: boolean | undefined }
): Promise<string> {
  const segments = typePath.split('/');
  const displayTypeName = segments[0] ?? typePath;  // For header display
  const typeName = typeDef.name;  // For ownership checks

  printInfo(`\n=== New ${displayTypeName} ===`);
  
  // Show template info if using one
  if (template) {
    printInfo(`Using template: ${template.name}${template.description ? ` - ${template.description}` : ''}`);
  }

  // Check if this type can be owned
  const canBeOwned = typeCanBeOwned(schema, typeName);
  
  if (canBeOwned && !options?.standalone) {
    // Determine ownership (prompt or use --owner flag)
    const ownershipDecision = await resolveOwnership(schema, vaultDir, typeName, options?.owner);
    
    if (ownershipDecision.isOwned && ownershipDecision.owner) {
      // Create as owned note
      return await createOwnedNote(schema, vaultDir, typePath, typeDef, template, ownershipDecision.owner);
    }
    // Fall through to standard creation if standalone
  }

  // Standard pooled mode
  return await createPooledNote(schema, vaultDir, typePath, typeDef, template);
}

/**
 * Create a note in pooled mode (standard flat directory).
 */
async function createPooledNote(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  template?: Template | null
): Promise<string> {
  // Get output directory
  const outputDir = getOutputDirForType(schema, typePath);
  if (!outputDir) {
    printError(`No output_dir defined for type: ${typePath}`);
    process.exit(1);
  }
  const fullOutputDir = join(vaultDir, outputDir);

  // Prompt for name
  const itemName = await promptRequired('Name');
  if (itemName === null) {
    throw new UserCancelledError();
  }

  // Build frontmatter and body (may throw UserCancelledError)
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef, template);

  // Create file
  const filePath = join(fullOutputDir, `${itemName}.md`);

  if (existsSync(filePath)) {
    printWarning(`\nWarning: File already exists: ${filePath}`);
    const overwrite = await promptConfirm('Overwrite?');
    if (overwrite === null) {
      throw new UserCancelledError();
    }
    if (overwrite === false) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  await writeNote(filePath, frontmatter, body, orderedFields);
  printSuccess(`\n✓ Created: ${filePath}`);
  return filePath;
}

/**
 * Build frontmatter and body content for a note.
 * 
 * When a template is provided:
 * - Template defaults are used for fields (skip prompting)
 * - Fields in template.promptFields are still prompted
 * - Template body is used instead of schema body_sections
 */
async function buildNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  template?: Template | null
): Promise<{ frontmatter: Record<string, unknown>; body: string; orderedFields: string[] }> {
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  // Always inject the type field with the type name
  // In the new inheritance model, type is auto-injected, not a field definition
  frontmatter['type'] = typeDef.name;

  // Get template defaults and prompt-fields
  const templateDefaults = template?.defaults ?? {};
  const promptFields = new Set(template?.promptFields ?? []);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    // Check if template provides a default for this field
    const templateDefault = templateDefaults[fieldName];
    const hasTemplateDefault = templateDefault !== undefined;
    const shouldPrompt = !hasTemplateDefault || promptFields.has(fieldName);

    if (hasTemplateDefault && !shouldPrompt) {
      // Use template default without prompting
      // Evaluate date expressions like today() + '7d'
      frontmatter[fieldName] = evaluateTemplateDefault(templateDefault);
    } else {
      // Prompt as normal
      const value = await promptField(schema, vaultDir, fieldName, field);
      if (value !== undefined && value !== '') {
        frontmatter[fieldName] = value;
      }
    }
  }

  // Validate template constraints (after all prompts, before creating note)
  if (template?.constraints) {
    const constraintResult = validateConstraints(frontmatter, template.constraints);
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
  const promptableSections = bodySections?.filter(s => s.prompt === 'multi-input') ?? [];
  
  if (template?.body) {
    // Start with processed template body
    body = processTemplateBody(template.body, frontmatter);
    
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

// ============================================================================
// Ownership Flow
// ============================================================================

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
 * Create a note that is owned by another note.
 * Owned notes live in: {owner_folder}/{child_type}/
 */
async function createOwnedNote(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  template: Template | null | undefined,
  owner: OwnerNoteRef
): Promise<string> {
  const typeName = typeDef.name;
  
  printInfo(`Creating ${typeName} owned by ${owner.ownerName}`);
  
  // Prompt for name
  const itemName = await promptRequired('Name');
  if (itemName === null) {
    throw new UserCancelledError();
  }
  
  // Build frontmatter and body (may throw UserCancelledError)
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef, template);
  
  // Ensure the owned output directory exists
  const outputDir = await ensureOwnedOutputDir(owner.ownerPath, typeName);
  
  // Create file path
  const filePath = join(outputDir, `${itemName}.md`);
  
  if (existsSync(filePath)) {
    printWarning(`\nWarning: File already exists: ${filePath}`);
    const overwrite = await promptConfirm('Overwrite?');
    if (overwrite === null) {
      throw new UserCancelledError();
    }
    if (overwrite === false) {
      console.log('Aborted.');
      process.exit(1);
    }
  }
  
  await writeNote(filePath, frontmatter, body, orderedFields);
  printSuccess(`\n✓ Created: ${relative(vaultDir, filePath)}`);
  printInfo(`  Owned by: ${owner.ownerName}`);
  return filePath;
}

/**
 * Get output directory for a type, walking up the hierarchy.
 */
function getOutputDirForType(schema: LoadedSchema, typePath: string): string | undefined {
  // Use the type's outputDir from the resolved type
  const typeDef = getTypeDefByPath(schema, typePath);
  return typeDef?.outputDir;
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
    return expandStaticValue(field.value);
  }

  // Prompt-based value
  switch (field.prompt) {
    case 'select': {
      if (!field.enum) return field.default;
      const enumOptions = getEnumValues(schema, field.enum);
      
      // For optional fields, add a skip option
      let options: string[];
      let skipLabel: string | undefined;
      if (!field.required) {
        const defaultStr = field.default !== undefined ? String(field.default) : undefined;
        skipLabel = defaultStr ? `(skip) [${defaultStr}]` : '(skip)';
        options = [skipLabel, ...enumOptions];
      } else {
        options = enumOptions;
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
      return formatValue(selected, field.format);
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

    case 'multi-input': {
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

    default:
      return field.default;
  }
}

/**
 * Expand special static values like $NOW and $TODAY.
 */
function expandStaticValue(value: string): string {
  const now = new Date();

  switch (value) {
    case '$NOW':
      return now.toISOString().slice(0, 16).replace('T', ' ');
    case '$TODAY':
      return now.toISOString().slice(0, 10);
    default:
      return value;
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
    if (section.prompt === 'multi-input' && section.prompt_label) {
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
