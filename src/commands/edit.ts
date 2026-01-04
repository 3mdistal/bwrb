import { Command } from 'commander';
import { relative, isAbsolute } from 'path';
import {
  loadSchema,
  getTypeDefByPath,
  resolveTypePathFromFrontmatter,
  getFieldsForType,
  getFrontmatterOrder,
  getEnumValues,
} from '../lib/schema.js';
import { parseNote, writeNote, generateBodySections } from '../lib/frontmatter.js';
import { resolveVaultDir, queryByType, formatValue } from '../lib/vault.js';
import {
  promptSelection,
  promptInput,
  promptConfirm,
  printError,
  printSuccess,
  printInfo,
  printWarning,
} from '../lib/prompt.js';
import {
  validateFrontmatter,
  validateContextFields,
} from '../lib/validation.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
  exitWithResolutionError,
} from '../lib/output.js';
import type { LoadedSchema, Field, BodySection } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';
import { buildNoteIndex } from '../lib/navigation.js';
import { resolveAndPick, parsePickerMode, type PickerMode } from '../lib/picker.js';

interface EditCommandOptions {
  open?: boolean;
  json?: string;
  picker?: string;
  type?: string;
}

export const editCommand = new Command('edit')
  .description('Edit an existing note\'s frontmatter interactively')
  .argument('[query]', 'Note name, path, or search query (opens picker if omitted)')
  .option('--open', 'Open the note in Obsidian after editing')
  .option('--json <frontmatter>', 'Update note non-interactively with JSON (patch/merge semantics)')
  .option('--picker <mode>', 'Picker mode: auto, fzf, numbered, none', 'auto')
  .option('--type <type>', 'Restrict to notes of a specific type')
  .addHelpText('after', `
Examples:
  pika edit                           # Pick from all notes
  pika edit "My Idea"                 # Search by name
  pika edit Ideas/My\\ Idea.md        # Exact path
  pika edit --type task               # Pick from tasks only
  pika edit "bug" --type task         # Search tasks for "bug"
  pika edit "My Task" --open          # Edit and open in Obsidian

Non-interactive (JSON) mode:
  pika edit "Fix bug" --json '{"status": "done"}'
  pika edit Ideas/Idea.md --json '{"priority": "high", "tags": ["urgent"]}'
  
JSON mode uses patch/merge semantics:
  - Only fields present in JSON are updated
  - Existing fields not in JSON are preserved
  - To clear a field, pass null: '{"deadline": null}'`)
  .action(async (query: string | undefined, options: EditCommandOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate --type if provided
      if (options.type) {
        const typeDef = getTypeDefByPath(schema, options.type);
        if (!typeDef) {
          const error = `Unknown type: ${options.type}`;
          if (jsonMode) {
            printJson(jsonError(error, { code: ExitCodes.VALIDATION_ERROR }));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      // Determine effective picker mode (JSON mode disables picker)
      const pickerMode = parsePickerMode(options.picker);
      const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

      // In JSON mode without a query, we can't show a picker
      if (jsonMode && !query) {
        printJson(jsonError('Query required in JSON mode. Use a note name, path, or search term.', { code: ExitCodes.VALIDATION_ERROR }));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      // Convert absolute paths to vault-relative paths for resolution
      let resolveQuery = query ?? '';
      if (query && isAbsolute(query) && query.startsWith(vaultDir)) {
        resolveQuery = relative(vaultDir, query);
      }

      // Build note index and optionally filter by type
      let noteIndex = await buildNoteIndex(schema, vaultDir);
      if (options.type) {
        noteIndex = {
          ...noteIndex,
          allFiles: noteIndex.allFiles.filter(f => f.expectedType?.startsWith(options.type!)),
        };
      }

      // Resolve query to a file using picker if needed
      const result = await resolveAndPick(noteIndex, resolveQuery, {
        pickerMode: effectivePickerMode,
        prompt: 'Select note to edit',
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const resolvedPath = result.file.path;

      if (jsonMode) {
        const editResult = await editNoteFromJson(schema, vaultDir, resolvedPath, options.json!);
        printJson(jsonSuccess({
          path: relative(vaultDir, resolvedPath),
          updated: editResult.updatedFields,
        }));

        // Open in Obsidian if requested
        if (options.open) {
          const { openInObsidian } = await import('./open.js');
          await openInObsidian(vaultDir, resolvedPath);
        }
        return;
      }

      // Interactive mode
      await editNote(schema, vaultDir, resolvedPath);

      // Open in Obsidian if requested
      if (options.open) {
        const { openInObsidian } = await import('./open.js');
        await openInObsidian(vaultDir, resolvedPath);
      }
    } catch (err) {
      // Handle user cancellation cleanly (no changes written)
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
 * Edit a note from JSON input (non-interactive mode with merge semantics).
 */
async function editNoteFromJson(
  schema: LoadedSchema,
  _vaultDir: string,
  filePath: string,
  jsonInput: string
): Promise<{ updatedFields: string[] }> {
  // Parse JSON input
  let patchData: Record<string, unknown>;
  try {
    patchData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Parse existing note
  const { frontmatter, body } = await parseNote(filePath);

  // Resolve type path from existing frontmatter
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) {
    printJson(jsonError('Could not determine note type from frontmatter'));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    printJson(jsonError(`Unknown type path: ${typePath}`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Merge patch data into existing frontmatter
  const mergedFrontmatter = mergeFrontmatter(frontmatter, patchData);
  const updatedFields = Object.keys(patchData).filter(k => patchData[k] !== undefined);

  // Validate merged result
  const validation = validateFrontmatter(schema, typePath, mergedFrontmatter);
  if (!validation.valid) {
    printJson({
      success: false,
      error: 'Validation failed',
      errors: validation.errors.map(e => ({
        field: e.field,
        message: e.message,
        currentValue: frontmatter[e.field],
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
        ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
      })),
    });
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Validate context fields (source type constraints)
  const contextValidation = await validateContextFields(schema, _vaultDir, typePath, mergedFrontmatter);
  if (!contextValidation.valid) {
    printJson({
      success: false,
      error: 'Context field validation failed',
      errors: contextValidation.errors.map(e => ({
        type: e.type,
        field: e.field,
        message: e.message,
        currentValue: frontmatter[e.field],
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
      })),
    });
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Get field order
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(mergedFrontmatter);

  // Write updated note
  await writeNote(filePath, mergedFrontmatter, body, orderedFields);

  return { updatedFields };
}

/**
 * Merge patch data into existing frontmatter.
 * - Fields in patch overwrite existing fields
 * - null values remove the field
 * - Arrays are replaced, not merged
 */
function mergeFrontmatter(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...existing };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      // Remove field
      delete result[key];
    } else {
      // Overwrite field
      result[key] = value;
    }
  }

  return result;
}

/**
 * Edit an existing note's frontmatter (interactive mode).
 */
async function editNote(
  schema: LoadedSchema,
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
  const bodySections = typeDef.bodySections;
  if (bodySections && bodySections.length > 0) {
    const addSections = await promptConfirm('\nCheck for missing sections?');
    if (addSections === null) {
      throw new UserCancelledError();
    }
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
 * Throws UserCancelledError if user cancels any prompt.
 */
async function promptFieldEdit(
  schema: LoadedSchema,
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
      const enumOptions = getEnumValues(schema, field.enum);
      
      // Add a "keep current" option at the top
      const keepLabel = '(keep current)';
      const options = [keepLabel, ...enumOptions];
      
      const selected = await promptSelection(`New ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected keep current, return the existing value
      if (selected === keepLabel) {
        return currentValue;
      }
      return selected;
    }

    case 'dynamic': {
      if (!field.source) return currentValue;
      const dynamicOptions = await queryByType(schema, vaultDir, field.source, field.filter);
      if (dynamicOptions.length === 0) {
        return currentValue;
      }
      
      // Add a "keep current" option at the top
      const keepLabel = '(keep current)';
      const options = [keepLabel, ...dynamicOptions];
      
      const selected = await promptSelection(`New ${fieldName}:`, options);
      if (selected === null) {
        throw new UserCancelledError();
      }
      
      // If user selected keep current, return the existing value
      if (selected === keepLabel) {
        return currentValue;
      }
      return formatValue(selected, field.format);
    }

    case 'input': {
      const label = field.label ?? fieldName;
      const currentDefault = typeof currentValue === 'string' ? currentValue : '';
      const newValue = await promptInput(`New ${label} (or Enter to keep)`, currentDefault);
      if (newValue === null) {
        throw new UserCancelledError();
      }
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
 * Throws UserCancelledError if user cancels any prompt.
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
      if (addIt === null) {
        throw new UserCancelledError();
      }
      if (addIt) {
        const newSection = generateBodySections([section]);
        updatedBody += '\n' + newSection;
      }
    }
  }

  return updatedBody;
}
