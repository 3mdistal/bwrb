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
import { writeNote, generateBodyWithContent, generateBodySections } from '../lib/frontmatter.js';
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
import type { Schema, TypeDef, Field, BodySection } from '../types/schema.js';

interface NewCommandOptions {
  open?: boolean;
  json?: string;
  instance?: string;
}

export const newCommand = new Command('new')
  .description('Create a new note (interactive type navigation if type omitted)')
  .argument('[type]', 'Type of note to create (e.g., idea, objective/task)')
  .option('--open', 'Open the note in Obsidian after creation')
  .option('--json <frontmatter>', 'Create note non-interactively with JSON frontmatter')
  .option('--instance <name>', 'Parent instance name (for instance-grouped subtypes)')
  .addHelpText('after', `
Examples:
  ovault new                    # Interactive type selection
  ovault new idea               # Create an idea
  ovault new objective/task     # Create a task
  ovault new draft --open       # Create and open in Obsidian

Non-interactive (JSON) mode:
  ovault new idea --json '{"Name": "My Idea", "status": "raw"}'
  ovault new objective/task --json '{"Name": "Fix bug", "status": "in-progress"}'
  ovault new draft/version --instance "My Project" --json '{"Name": "v1"}'

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

        const filePath = await createNoteFromJson(
          schema,
          vaultDir,
          typePath,
          options.json!,
          options.instance
        );
        
        printJson(jsonSuccess({ path: relative(vaultDir, filePath) }));
        
        // Open in Obsidian if requested
        if (options.open && filePath) {
          const { openInObsidian } = await import('./open.js');
          await openInObsidian(vaultDir, filePath);
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

      const filePath = await createNote(schema, vaultDir, resolvedPath, typeDef);

      // Open in Obsidian if requested
      if (options.open && filePath) {
        const { openInObsidian } = await import('./open.js');
        await openInObsidian(vaultDir, filePath);
      }
    } catch (err) {
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
  instanceName?: string
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

  // Validate and apply defaults
  const validation = validateFrontmatter(schema, typePath, inputData);
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

  // Apply defaults for missing fields
  const frontmatter = applyDefaults(schema, typePath, inputData);

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
      instanceName
    );
  } else if (dirMode === 'instance-grouped' && segments.length === 1) {
    // Instance-grouped parent
    filePath = await createInstanceParentFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      itemName
    );
  } else {
    // Pooled mode
    filePath = await createPooledNoteFromJson(
      schema,
      vaultDir,
      typePath,
      typeDef,
      frontmatter,
      itemName
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
  itemName: string
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

  // Generate body from body_sections
  const body = generateBodyFromSections(typeDef.body_sections);
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
  instanceName: string
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

  const body = generateBodyFromSections(typeDef.body_sections);
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
  instanceName?: string
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

  const body = generateBodyFromSections(typeDef.body_sections);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(cleanFrontmatter);

  await writeNote(filePath, cleanFrontmatter, body, orderedFields);
  return filePath;
}

/**
 * Generate body content from body sections (for non-interactive mode).
 */
function generateBodyFromSections(sections?: BodySection[]): string {
  if (!sections || sections.length === 0) {
    return '';
  }
  return generateBodySections(sections);
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
  typeDef: TypeDef
): Promise<string> {
  const segments = typePath.split('/');
  const typeName = segments[0] ?? typePath;
  const dirMode = getDirMode(schema, typePath);
  const isSubtype = isInstanceGroupedSubtype(schema, typePath);

  printInfo(`\n=== New ${typeName} ===`);

  // Handle instance-grouped subtypes differently
  if (dirMode === 'instance-grouped' && isSubtype) {
    return await createInstanceGroupedNote(schema, vaultDir, typePath, typeDef);
  }

  // Handle instance-grouped parent types (creating new instance)
  if (dirMode === 'instance-grouped' && segments.length === 1) {
    return await createInstanceParent(schema, vaultDir, typePath, typeDef);
  }

  // Standard pooled mode
  return await createPooledNote(schema, vaultDir, typePath, typeDef);
}

/**
 * Create a note in pooled mode (standard flat directory).
 */
async function createPooledNote(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef
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

  // Build frontmatter and body
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef);

  // Create file
  const filePath = join(fullOutputDir, `${itemName}.md`);

  if (existsSync(filePath)) {
    printWarning(`\nWarning: File already exists: ${filePath}`);
    const overwrite = await promptConfirm('Overwrite?');
    if (!overwrite) {
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
  typeDef: TypeDef
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

  // Create instance folder
  await createInstanceFolder(vaultDir, outputDir, instanceName);

  // Build frontmatter and body
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef);

  // Create parent note (e.g., "Drafts/My Project/My Project.md")
  const filePath = getParentNotePath(vaultDir, outputDir, instanceName);

  if (existsSync(filePath)) {
    printWarning(`\nWarning: Instance already exists: ${filePath}`);
    const overwrite = await promptConfirm('Overwrite parent note?');
    if (!overwrite) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

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
  typeDef: TypeDef
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

  // Prompt for instance selection
  let selectedInstance: string | undefined;
  if (instances.length === 0) {
    printInfo(`No existing ${parentTypeName} instances found.`);
    const createNew = await promptConfirm(`Create a new ${parentTypeName}?`);
    if (!createNew) {
      console.log('Aborted.');
      process.exit(1);
    }
    // Create new instance
    const instanceName = await promptRequired(`New ${parentTypeName} name`);
    await createInstanceFolder(vaultDir, parentOutputDir, instanceName);
    selectedInstance = instanceName;
  } else {
    const options = [...instances, `[Create new ${parentTypeName}]`];
    const selected = await promptSelection(`Select ${parentTypeName}:`, options);
    if (!selected) {
      console.log('Aborted.');
      process.exit(1);
    }
    if (selected.startsWith('[Create new')) {
      const instanceName = await promptRequired(`New ${parentTypeName} name`);
      await createInstanceFolder(vaultDir, parentOutputDir, instanceName);
      selectedInstance = instanceName;
    } else {
      selectedInstance = selected;
    }
  }

  // Build frontmatter and body
  const { frontmatter, body, orderedFields } = await buildNoteContent(schema, vaultDir, typePath, typeDef);

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
    if (!overwrite) {
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
 */
async function buildNoteContent(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef
): Promise<{ frontmatter: Record<string, unknown>; body: string; orderedFields: string[] }> {
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    const value = await promptField(schema, vaultDir, fieldName, field);
    if (value !== undefined && value !== '') {
      frontmatter[fieldName] = value;
    }
  }

  let body = '';
  const bodySections = typeDef.body_sections;
  if (bodySections && bodySections.length > 0) {
    const sectionContent = await promptBodySections(bodySections);
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
      const options = getEnumValues(schema, field.enum);
      const selected = await promptSelection(`Select ${fieldName}:`, options);
      return selected ?? field.default;
    }

    case 'dynamic': {
      if (!field.source) return field.default;
      const options = await queryDynamicSource(schema, vaultDir, field.source);
      if (options.length === 0) {
        printWarning(`No options available for ${fieldName}`);
        return '';
      }
      const selected = await promptSelection(`Select ${fieldName}:`, options);
      return selected ? formatValue(selected, field.format) : '';
    }

    case 'input': {
      const label = field.label ?? fieldName;
      if (field.required) {
        return await promptRequired(label);
      }
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      return await promptInput(label, defaultVal);
    }

    case 'multi-input': {
      const label = field.label ?? fieldName;
      const items = await promptMultiInput(label);
      if (field.list_format === 'comma-separated') {
        return items.join(', ');
      }
      return items;
    }

    case 'date': {
      const label = field.label ?? fieldName;
      const defaultVal = typeof field.default === 'string' ? field.default : undefined;
      return await promptInput(label, defaultVal);
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
 */
async function promptBodySections(
  sections: BodySection[]
): Promise<Map<string, string[]>> {
  const content = new Map<string, string[]>();

  for (const section of sections) {
    if (section.prompt === 'multi-input' && section.prompt_label) {
      const items = await promptMultiInput(section.prompt_label);
      if (items.length > 0) {
        content.set(section.title, items);
      }
    }

    // Recursively handle children (no prompting for nested sections)
  }

  return content;
}
