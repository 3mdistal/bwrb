import { Command } from 'commander';
import { join } from 'path';
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
import { writeNote, generateBodyWithContent } from '../lib/frontmatter.js';
import { resolveVaultDir, queryDynamicSource, formatValue } from '../lib/vault.js';
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
import type { Schema, TypeDef, Field, BodySection } from '../types/schema.js';

export const newCommand = new Command('new')
  .description('Create a new note')
  .argument('[type]', 'Type of note to create (e.g., idea, objective/task)')
  .action(async (typePath: string | undefined, _options: unknown, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Resolve full type path through interactive navigation
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

      await createNote(schema, vaultDir, resolvedPath, typeDef);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

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
 */
async function createNote(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  typeDef: TypeDef
): Promise<void> {
  const segments = typePath.split('/');
  const typeName = segments[0] ?? typePath;

  printInfo(`\n=== New ${typeName} ===`);

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

  // Build frontmatter
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);

  // Determine actual field order (use explicit order, or all field keys)
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    const value = await promptField(schema, vaultDir, fieldName, field);
    if (value !== undefined && value !== '') {
      frontmatter[fieldName] = value;
    }
  }

  // Build body sections
  let body = '';
  const bodySections = typeDef.body_sections;
  if (bodySections && bodySections.length > 0) {
    const sectionContent = await promptBodySections(bodySections);
    body = generateBodyWithContent(bodySections, sectionContent);
  }

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
}

/**
 * Get output directory for a type, walking up the hierarchy.
 */
function getOutputDirForType(schema: Schema, typePath: string): string | undefined {
  const segments = typePath.split('/').filter(Boolean);
  let outputDir: string | undefined;

  type TypeLike = { output_dir?: string; subtypes?: Record<string, TypeLike> };
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
