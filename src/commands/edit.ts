import { Command } from 'commander';
import { join, isAbsolute } from 'path';
import {
  loadSchema,
  getTypeDefByPath,
  resolveTypePathFromFrontmatter,
  getFieldsForType,
  getFrontmatterOrder,
  getEnumValues,
} from '../lib/schema.js';
import { parseNote, writeNote, generateBodySections } from '../lib/frontmatter.js';
import { resolveVaultDir, queryDynamicSource, formatValue, isFile } from '../lib/vault.js';
import {
  promptSelection,
  promptInput,
  promptConfirm,
  printError,
  printSuccess,
  printInfo,
  printWarning,
} from '../lib/prompt.js';
import type { Schema, Field, BodySection } from '../types/schema.js';

export const editCommand = new Command('edit')
  .description('Edit an existing note\'s frontmatter')
  .argument('<file>', 'Path to the file to edit')
  .action(async (filePath: string, _options: unknown, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Resolve file path
      const resolvedPath = isAbsolute(filePath) ? filePath : join(vaultDir, filePath);

      if (!(await isFile(resolvedPath))) {
        printError(`File not found: ${resolvedPath}`);
        process.exit(1);
      }

      await editNote(schema, vaultDir, resolvedPath);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * Edit an existing note's frontmatter.
 */
async function editNote(
  schema: Schema,
  vaultDir: string,
  filePath: string
): Promise<void> {
  const { frontmatter, body } = await parseNote(filePath);
  const fileName = filePath.split('/').pop() ?? filePath;

  printInfo(`\n=== Editing: ${fileName} ===`);

  // Resolve type path from frontmatter
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) {
    printWarning('Warning: Unknown type, showing raw frontmatter edit');
    console.log('Current frontmatter:');
    console.log(JSON.stringify(frontmatter, null, 2));
    return;
  }

  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printWarning(`Warning: Unknown type path: ${typePath}`);
    return;
  }

  printInfo(`Type path: ${typePath}\n`);

  // Edit frontmatter fields
  const newFrontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);

  // Determine actual field order
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    const currentValue = frontmatter[fieldName];
    const newValue = await promptFieldEdit(
      schema,
      vaultDir,
      fieldName,
      field,
      currentValue
    );

    if (newValue !== undefined) {
      newFrontmatter[fieldName] = newValue;
    }
  }

  // Check for missing body sections
  let updatedBody = body;
  const bodySections = typeDef.body_sections;
  if (bodySections && bodySections.length > 0) {
    const addSections = await promptConfirm('\nCheck for missing sections?');
    if (addSections) {
      updatedBody = await addMissingSections(body, bodySections);
    }
  }

  // Write updated file
  await writeNote(filePath, newFrontmatter, updatedBody, orderedFields);
  printSuccess(`\n✓ Updated: ${filePath}`);
}

/**
 * Prompt for editing a single frontmatter field.
 */
async function promptFieldEdit(
  schema: Schema,
  vaultDir: string,
  fieldName: string,
  field: Field,
  currentValue: unknown
): Promise<unknown> {
  const currentStr = formatCurrentValue(currentValue);

  // Static value - keep current or use static default
  if (field.value !== undefined) {
    if (currentValue !== undefined && currentValue !== '') {
      return currentValue;
    }
    return expandStaticValue(field.value);
  }

  console.log(`Current ${fieldName}: ${currentStr}`);

  // Prompt-based value
  switch (field.prompt) {
    case 'select': {
      if (!field.enum) return currentValue;
      const options = getEnumValues(schema, field.enum);
      const selected = await promptSelection(`New ${fieldName} (or Enter to keep):`, options);
      return selected ?? currentValue;
    }

    case 'dynamic': {
      if (!field.source) return currentValue;
      const options = await queryDynamicSource(schema, vaultDir, field.source);
      if (options.length === 0) {
        return currentValue;
      }
      const selected = await promptSelection(`New ${fieldName} (or Enter to keep):`, options);
      if (selected) {
        return formatValue(selected, field.format);
      }
      return currentValue;
    }

    case 'input': {
      const label = field.label ?? fieldName;
      const currentDefault = typeof currentValue === 'string' ? currentValue : '';
      const newValue = await promptInput(`New ${label} (or Enter to keep)`, currentDefault);
      return newValue || currentValue;
    }

    default:
      return currentValue;
  }
}

/**
 * Format current value for display.
 */
function formatCurrentValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '<empty>';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

/**
 * Expand special static values.
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
 * Check for missing sections and offer to add them.
 */
async function addMissingSections(
  body: string,
  sections: BodySection[]
): Promise<string> {
  let updatedBody = body;

  for (const section of sections) {
    const level = section.level ?? 2;
    const prefix = '#'.repeat(level);
    const pattern = new RegExp(`^${prefix} ${section.title}`, 'm');

    if (!pattern.test(body)) {
      printWarning(`Missing section: ${section.title}`);
      const addIt = await promptConfirm('Add it?');
      if (addIt) {
        const newSection = generateBodySections([section]);
        updatedBody += '\n' + newSection;
      }
    }
  }

  return updatedBody;
}
