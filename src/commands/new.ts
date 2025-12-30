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
  queryDynamicSource,
  formatValue,
  getDirMode,
  isInstanceGroupedSubtype,
  getParentTypeName,
  listInstanceFolders,
  getInstanceFolderPath,
  getParentNotePath,
  createInstanceFolder,
  generateFilename,
  getFilenamePattern,
  getOutputDir,
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
} from '../lib/validation.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import {
  resolveTemplate,
  findTemplateByName,
  findDefaultTemplate,
  processTemplateBody,
} from '../lib/template.js';
import type { Schema, TypeDef, Field, BodySection, Template } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';

interface NewCommandOptions {
  open?: boolean;
  json?: string;
  instance?: string;
  template?: string;
  default?: boolean;
  noTemplate?: boolean;
}

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, objective/task)')
  .option('--open', 'Open the note after creation (uses OVAULT_DEFAULT_APP or Obsidian)')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--instance <name>', 'Parent instance name (for instance-grouped subtypes)')
  .option('--template <name>', 'Use a specific template')
  .option('--default', 'Use the default template for the type')
  .option('--no-template', 'Skip template selection, use schema only')
  .addHelpText('after', `
Examples:
  ovault new                    # Interactive type selection
  ovault new idea               # Create an idea
  ovault new objective/task     # Create a task
  ovault new draft --open       # Create and open (respects OVAULT_DEFAULT_APP)

Templates:
  ovault new task --template bug-report  # Use specific template
  ovault new task --default              # Use default.md template
  ovault new task --no-template          # Skip templates, use schema only

Non-interactive (JSON) mode:
  ovault new idea --json '{"Name": "My Idea", "status": "raw"}'
  ovault new objective/task --json '{"Name": "Fix bug", "status": "in-progress"}'
  ovault new task --json '{"Name": "Bug"}' --template bug-report

Body sections (JSON mode):
  ovault new task --json '{"Task name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'
  The _body field accepts section names as keys, with string or string[] values.

Template Discovery:
  Templates are stored in Templates/{type}/{subtype}/*.md
  If default.md exists, it's used automatically (unless --no-template).
  If multiple templates exist without default.md, you'll be prompted to select.

For instance-grouped types (like drafts), you'll be prompted to select
or create a parent instance folder.`)
  .action(async (typePath: string | undefined, options: NewCommandOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;
    
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
        if (!options.noTemplate) {
          if (options.template) {
            template = await findTemplateByName(vaultDir, typePath, options.template);
            if (!template) {
              printJson(jsonError(`Template not found: ${options.template}`));
              process.exit(ExitCodes.VALIDATION_ERROR);
            }
          } else if (options.default) {
            template = await findDefaultTemplate(vaultDir, typePath);
            if (!template) {
              printJson(jsonError(`No default template found for type: ${typePath}`));
              process.exit(ExitCodes.VALIDATION_ERROR);
            }
          }
          // Note: In JSON mode without explicit --template or --default, 
          // we don't auto-select templates (explicit is better for automation)
        }

        const filePath = await createNoteFromJson(
          schema,
          vaultDir,
          typePath,
          options.json!,
          options.instance,
          template
        );
        
        printJson(jsonSuccess({ path: relative(vaultDir, filePath) }));
        
        // Open if requested (respects OVAULT_DEFAULT_APP)
        if (options.open && filePath) {
          const { openNote } = await import('./open.js');
          await openNote(vaultDir, filePath);
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
          // --template <name>: Find specific template
          template = await findTemplateByName(vaultDir, resolvedPath, options.template);
          if (!template) {
            printError(`Template not found: ${options.template}`);
            process.exit(1);
          }
        } else if (options.default) {
          // --default: Find default.md
          template = await findDefaultTemplate(vaultDir, resolvedPath);
          if (!template) {
            printError(`No default template found for type: ${resolvedPath}`);
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

      const filePath = await createNote(schema, vaultDir, resolvedPath, typeDef, template);

      // Open if requested (respects OVAULT_DEFAULT_APP)
      if (options.open && filePath) {
        const { openNote } = await import('./open.js');
        await openNote(vaultDir, filePath);
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
  schema: Schema,
  vaultDir: string,
  typePath: string,
  jsonInput: string,
  instanceName?: string,
  template?: Template | null
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
    // Template defaults are base, JSON input takes precedence
    mergedInput = { ...template.defaults, ...frontmatterInput };
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

  // Get the name from the frontmatter
  const nameField = typeDef.name_field ?? 'Name';
  const itemName = frontmatter[nameField];
  if (!itemName || typeof itemName !== 'string') {
    printJson(jsonError(`Missing or invalid name field: ${nameField}`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Determine output path based on type
  const segments = typePath.split('/');
  const dirMode = getDirMode(schema, typePath);
  const isSubtype = isInstanceGroupedSubtype(schema, typePath);

  let filePath: string;

  if (dirMode === 'instance-grouped' && isSubtype) {
    // Instance-grouped subtype
    filePath = await createInstanceGroupedNoteFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      instanceName,
      template,
      bodyInput
    );
  } else if (dirMode === 'instance-grouped' && segments.length === 1) {
    // Instance-grouped parent
    filePath = await createInstanceParentFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      itemName,
      template,
      bodyInput
    );
  } else {
    // Pooled mode
    filePath = await createPooledNoteFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      itemName,
      template,
      bodyInput
    );
  }

  return filePath;
}

/**
 * Create a pooled note from JSON input.
 */
async function createPooledNoteFromJson(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
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
 * Create an instance parent from JSON input.
 */
async function createInstanceParentFromJson(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  frontmatter: Record<string, unknown>,
  instanceName: string,
  template?: Template | null,
  bodyInput?: Record<string, unknown>
): Promise<string> {
  const outputDir = getOutputDir(schema, typePath);
  if (!outputDir) {
    printJson(jsonError(`No output_dir defined for type: ${typePath}`));
    process.exit(ExitCodes.SCHEMA_ERROR);
  }

  await createInstanceFolder(vaultDir, outputDir, instanceName);
  const filePath = getParentNotePath(vaultDir, outputDir, instanceName);

  if (existsSync(filePath)) {
    printJson(jsonError(`Instance already exists: ${relative(vaultDir, filePath)}`));
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
 * Create an instance-grouped subtype note from JSON input.
 */
async function createInstanceGroupedNoteFromJson(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  frontmatter: Record<string, unknown>,
  instanceName?: string,
  template?: Template | null,
  bodyInput?: Record<string, unknown>
): Promise<string> {
  const parentTypeName = getParentTypeName(schema, typePath);
  if (!parentTypeName) {
    printJson(jsonError('Could not determine parent type'));
    process.exit(ExitCodes.SCHEMA_ERROR);
  }

  const parentOutputDir = getOutputDir(schema, parentTypeName);
  if (!parentOutputDir) {
    printJson(jsonError(`No output_dir defined for parent type: ${parentTypeName}`));
    process.exit(ExitCodes.SCHEMA_ERROR);
  }

  // Instance name is required for instance-grouped subtypes
  if (!instanceName) {
    // Try to get from frontmatter (_instance field)
    instanceName = frontmatter['_instance'] as string | undefined;
    if (!instanceName) {
      printJson(jsonError('Instance name required for instance-grouped subtypes. Use --instance flag or _instance field in JSON.'));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  }

  // Verify instance exists
  const instances = await listInstanceFolders(vaultDir, parentOutputDir);
  if (!instances.includes(instanceName)) {
    printJson(jsonError(`Instance not found: ${instanceName}. Available: ${instances.join(', ') || 'none'}`));
    process.exit(ExitCodes.IO_ERROR);
  }

  const instanceDir = getInstanceFolderPath(vaultDir, parentOutputDir, instanceName);
  const filenamePattern = getFilenamePattern(schema, typePath);
  const subtypeName = typePath.split('/').pop() ?? 'note';
  const filename = await generateFilename(filenamePattern, instanceDir, subtypeName);
  const filePath = join(instanceDir, filename);

  if (existsSync(filePath)) {
    printJson(jsonError(`File already exists: ${relative(vaultDir, filePath)}`));
    process.exit(ExitCodes.IO_ERROR);
  }

  // Remove _instance from frontmatter before writing
  const { _instance, ...cleanFrontmatter } = frontmatter;

  // Generate body content
  const body = generateBodyForJson(typeDef, cleanFrontmatter, template, bodyInput);
  
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(cleanFrontmatter);

  await writeNote(filePath, cleanFrontmatter, body, orderedFields);
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
  typeDef: TypeDef,
  frontmatter: Record<string, unknown>,
  template?: Template | null,
  bodyInput?: Record<string, unknown>
): string {
  const sections = typeDef.body_sections ?? [];
  
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
  schema: Schema,
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

  // Navigate through subtypes
  let typeDef = getTypeDefByPath(schema, typePath);
  let currentSegment = typePath.split('/').pop() ?? typePath;

  while (typeDef && hasSubtypes(typeDef)) {
    const subtypes = getSubtypeKeys(typeDef);
    const discLabel = discriminatorName(currentSegment);
    const selected = await promptSelection(
      `Select ${currentSegment} subtype (${discLabel}):`,
      subtypes
    );
    if (!selected) return undefined;

    typePath = `${typePath}/${selected}`;
    typeDef = getTypeDefByPath(schema, typePath);
    currentSegment = selected;
  }

  return typePath;
}

/**
 * Create a new note with the given type.
 * Returns the file path of the created note.
 */
async function createNote(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  template?: Template | null
): Promise<string> {
  const segments = typePath.split('/');
  const typeName = segments[0] ?? typePath;
  const dirMode = getDirMode(schema, typePath);
  const isSubtype = isInstanceGroupedSubtype(schema, typePath);

  printInfo(`\n=== New ${typeName} ===`);
  
  // Show template info if using one
  if (template) {
    printInfo(`Using template: ${template.name}${template.description ? ` - ${template.description}` : ''}`);
  }

  // Handle instance-grouped subtypes differently
  if (dirMode === 'instance-grouped' && isSubtype) {
    return await createInstanceGroupedNote(schema, vaultDir, typePath, typeDef, template);
  }

  // Handle instance-grouped parent types (creating new instance)
  if (dirMode === 'instance-grouped' && segments.length === 1) {
    return await createInstanceParent(schema, vaultDir, typePath, typeDef, template);
  }

  // Standard pooled mode
  return await createPooledNote(schema, vaultDir, typePath, typeDef, template);
}

/**
 * Create a note in pooled mode (standard flat directory).
 */
async function createPooledNote(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
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
  const nameField = typeDef.name_field ?? 'Name';
  const itemName = await promptRequired(nameField);
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
 * Create the parent/index note for an instance-grouped type.
 */
async function createInstanceParent(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  template?: Template | null
): Promise<string> {
  // Get output directory (e.g., "Drafts")
  const outputDir = getOutputDir(schema, typePath);
  if (!outputDir) {
    printError(`No output_dir defined for type: ${typePath}`);
    process.exit(1);
  }

  // Prompt for instance name
  const nameField = typeDef.name_field ?? 'Name';
  const instanceName = await promptRequired(nameField);
  if (instanceName === null) {
    throw new UserCancelledError();
  }

  // Build frontmatter and body BEFORE creating folder (may throw UserCancelledError)
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef, template);

  // Check if instance already exists BEFORE creating folder
  const filePath = getParentNotePath(vaultDir, outputDir, instanceName);
  if (existsSync(filePath)) {
    printWarning(`\nWarning: Instance already exists: ${filePath}`);
    const overwrite = await promptConfirm('Overwrite parent note?');
    if (overwrite === null) {
      throw new UserCancelledError();
    }
    if (overwrite === false) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  // Only create folder after all prompts succeed
  await createInstanceFolder(vaultDir, outputDir, instanceName);

  await writeNote(filePath, frontmatter, body, orderedFields);
  printSuccess(`\n✓ Created instance: ${instanceName}`);
  printSuccess(`  Parent note: ${filePath}`);
  return filePath;
}

/**
 * Create a note for a subtype within an instance-grouped parent.
 */
async function createInstanceGroupedNote(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  template?: Template | null
): Promise<string> {
  const parentTypeName = getParentTypeName(schema, typePath);
  if (!parentTypeName) {
    printError('Could not determine parent type');
    process.exit(1);
  }

  // Get parent type's output directory
  const parentOutputDir = getOutputDir(schema, parentTypeName);
  if (!parentOutputDir) {
    printError(`No output_dir defined for parent type: ${parentTypeName}`);
    process.exit(1);
  }

  // List existing instances
  const instances = await listInstanceFolders(vaultDir, parentOutputDir);

  // Prompt for instance selection - track if we need to create a new instance
  let selectedInstance: string;
  let needsNewInstance = false;

  if (instances.length === 0) {
    printInfo(`No existing ${parentTypeName} instances found.`);
    const createNew = await promptConfirm(`Create a new ${parentTypeName}?`);
    if (createNew === null) {
      throw new UserCancelledError();
    }
    if (createNew === false) {
      console.log('Aborted.');
      process.exit(1);
    }
    // Will create new instance - get name
    const instanceName = await promptRequired(`New ${parentTypeName} name`);
    if (instanceName === null) {
      throw new UserCancelledError();
    }
    selectedInstance = instanceName;
    needsNewInstance = true;
  } else {
    const options = [...instances, `[Create new ${parentTypeName}]`];
    const selected = await promptSelection(`Select ${parentTypeName}:`, options);
    if (selected === null) {
      throw new UserCancelledError();
    }
    if (selected.startsWith('[Create new')) {
      const instanceName = await promptRequired(`New ${parentTypeName} name`);
      if (instanceName === null) {
        throw new UserCancelledError();
      }
      selectedInstance = instanceName;
      needsNewInstance = true;
    } else {
      selectedInstance = selected;
    }
  }

  // Build frontmatter and body BEFORE creating any folders (may throw UserCancelledError)
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef, template);

  // Now that all prompts have succeeded, create folder if needed
  if (needsNewInstance) {
    await createInstanceFolder(vaultDir, parentOutputDir, selectedInstance);
  }

  // Get instance folder path
  const instanceDir = getInstanceFolderPath(vaultDir, parentOutputDir, selectedInstance);

  // Generate filename using pattern
  const filenamePattern = getFilenamePattern(schema, typePath);
  const subtypeName = typePath.split('/').pop() ?? 'note';
  const filename = await generateFilename(filenamePattern, instanceDir, subtypeName);

  const filePath = join(instanceDir, filename);

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
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef,
  template?: Template | null
): Promise<{ frontmatter: Record<string, unknown>; body: string; orderedFields: string[] }> {
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

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
      frontmatter[fieldName] = templateDefault;
    } else {
      // Prompt as normal
      const value = await promptField(schema, vaultDir, fieldName, field);
      if (value !== undefined && value !== '') {
        frontmatter[fieldName] = value;
      }
    }
  }

  // Generate body content
  // If we have a template body, use it as the base and merge in prompted sections
  // If no template, prompt for schema body_sections from scratch
  let body = '';
  const bodySections = typeDef.body_sections;
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

/**
 * Get output directory for a type, walking up the hierarchy.
 */
function getOutputDirForType(schema: Schema, typePath: string): string | undefined {
  const segments = typePath.split('/').filter(Boolean);
  let outputDir: string | undefined;

  type TypeLike = { output_dir?: string | undefined; subtypes?: Record<string, TypeLike> | undefined };
  let current: TypeLike | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === 0) {
      current = segment ? schema.types[segment] : undefined;
    } else if (current?.subtypes && segment) {
      current = current.subtypes[segment];
    }

    if (current?.output_dir) {
      outputDir = current.output_dir;
    }
  }

  return outputDir;
}

/**
 * Prompt for a single frontmatter field value.
 * Throws UserCancelledError if user cancels any prompt.
 */
async function promptField(
  schema: Schema,
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

    case 'dynamic': {
      if (!field.source) return field.default;
      const dynamicOptions = await queryDynamicSource(schema, vaultDir, field.source);
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

    case 'input': {
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
