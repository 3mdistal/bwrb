import { Command } from 'commander';
import { join, relative } from 'path';
import { mkdir, unlink } from 'fs/promises';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeDefByPath,
  getFieldsForType,
  getEnumValues,
} from '../lib/schema.js';
import {
  findAllTemplates,
  findTemplates,
  findTemplateByName,
  validateAllTemplates,
  validateTemplate,
  getTemplateDir,
  parseTemplate,
} from '../lib/template.js';
import { resolveVaultDir, queryDynamicSource, formatValue } from '../lib/vault.js';
import { parseNote, writeNote } from '../lib/frontmatter.js';
import {
  promptSelection,
  promptInput,
  promptConfirm,
  promptMultiInput,
  printError,
  printSuccess,
  printWarning,
} from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import type { LoadedSchema, Field, Template } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';

interface TemplateListOptions {
  output?: string;
}

interface TemplateShowOptions {
  output?: string;
}

interface TemplateValidateOptions {
  output?: string;
}

interface TemplateNewOptions {
  name?: string;
  description?: string;
  json?: string;
}

interface TemplateEditOptions {
  json?: string;
}

export const templateCommand = new Command('template')
  .description('Template management commands')
  .addHelpText('after', `
Examples:
  pika template list                      # List all templates
  pika template list idea                 # List templates for idea type
  pika template show idea default         # Show template details
  pika template validate                  # Validate all templates
  pika template new idea                  # Create new template interactively
  pika template edit idea default         # Edit existing template
  pika template delete idea default       # Delete a template`);

// ============================================================================
// template list [type]
// ============================================================================

templateCommand
  .command('list [type]')
  .description('List available templates')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string | undefined, options: TemplateListOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      
      // Load schema to validate type path if provided
      const schema = await loadSchema(vaultDir);

      // Validate type path if provided
      if (typePath) {
        const typeDef = getTypeDefByPath(schema, typePath);
        if (!typeDef) {
          const error = `Unknown type: ${typePath}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      // Find templates
      const templates = typePath
        ? await findTemplates(vaultDir, typePath)
        : await findAllTemplates(vaultDir);

      if (jsonMode) {
        printJson(jsonSuccess({
          data: {
            templates: templates.map(t => ({
              type: t.templateFor,
              name: t.name,
              description: t.description,
              path: relative(vaultDir, t.path),
              hasDefaults: Boolean(t.defaults && Object.keys(t.defaults).length > 0),
              promptFields: t.promptFields,
              filenamePattern: t.filenamePattern,
            })),
          },
        }));
        return;
      }

      // Text output
      if (templates.length === 0) {
        if (typePath) {
          console.log(`No templates found for type: ${typePath}`);
        } else {
          console.log('No templates found.');
        }
        console.log(`\nTemplates are stored in: .pika/templates/{type}/{subtype}/`);
        return;
      }

      console.log(chalk.bold('\nTemplates\n'));

      // Calculate column widths
      const typeWidth = Math.max(12, ...templates.map(t => t.templateFor.length));
      const nameWidth = Math.max(10, ...templates.map(t => t.name.length));

      // Header
      console.log(
        chalk.gray(
          'TYPE'.padEnd(typeWidth + 2) +
          'NAME'.padEnd(nameWidth + 2) +
          'DESCRIPTION'
        )
      );

      // Rows
      for (const template of templates) {
        const typeCol = chalk.cyan(template.templateFor.padEnd(typeWidth + 2));
        const nameCol = chalk.green(template.name.padEnd(nameWidth + 2));
        const descCol = template.description ?? chalk.gray('(no description)');
        console.log(typeCol + nameCol + descCol);
      }

      console.log(`\n${templates.length} template(s) found`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// template show <type> <name>
// ============================================================================

templateCommand
  .command('show <type> <name>')
  .description('Show template details')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string, templateName: string, options: TemplateShowOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type path
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        const error = `Unknown type: ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Find template
      const template = await findTemplateByName(vaultDir, typePath, templateName);
      if (!template) {
        const error = `Template not found: ${templateName} for type ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      if (jsonMode) {
        printJson(jsonSuccess({
          data: {
            name: template.name,
            type: template.templateFor,
            path: relative(vaultDir, template.path),
            description: template.description,
            defaults: template.defaults,
            promptFields: template.promptFields,
            filenamePattern: template.filenamePattern,
            body: template.body,
          },
        }));
        return;
      }

      // Text output
      console.log(chalk.bold(`\nTemplate: ${template.name}\n`));
      console.log(`  ${chalk.cyan('Type:')} ${template.templateFor}`);
      console.log(`  ${chalk.cyan('Path:')} ${relative(vaultDir, template.path)}`);
      
      if (template.description) {
        console.log(`  ${chalk.cyan('Description:')} ${template.description}`);
      }

      if (template.defaults && Object.keys(template.defaults).length > 0) {
        console.log(`\n  ${chalk.cyan('Defaults:')}`);
        for (const [key, value] of Object.entries(template.defaults)) {
          const displayValue = Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
          console.log(`    ${chalk.yellow(key)}: ${displayValue}`);
        }
      }

      if (template.promptFields && template.promptFields.length > 0) {
        console.log(`\n  ${chalk.cyan('Prompt Fields:')} ${template.promptFields.join(', ')}`);
      }

      if (template.filenamePattern) {
        console.log(`\n  ${chalk.cyan('Filename Pattern:')} ${template.filenamePattern}`);
      }

      if (template.body) {
        console.log(`\n  ${chalk.cyan('Body Preview:')}`);
        const lines = template.body.split('\n').slice(0, 10);
        for (const line of lines) {
          console.log(`    ${chalk.gray(line)}`);
        }
        if (template.body.split('\n').length > 10) {
          console.log(chalk.gray('    ...'));
        }
      }

      console.log('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// template validate [type]
// ============================================================================

templateCommand
  .command('validate [type]')
  .description('Validate templates against schema')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string | undefined, options: TemplateValidateOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type path if provided
      if (typePath) {
        const typeDef = getTypeDefByPath(schema, typePath);
        if (!typeDef) {
          const error = `Unknown type: ${typePath}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      // Validate templates
      const results = await validateAllTemplates(vaultDir, schema, typePath);

      if (results.length === 0) {
        if (jsonMode) {
          printJson(jsonSuccess({
            message: 'No templates found',
            data: { templates: [], valid: 0, invalid: 0 },
          }));
        } else {
          console.log('No templates found to validate.');
        }
        return;
      }

      const validCount = results.filter(r => r.valid).length;
      const invalidCount = results.filter(r => !r.valid).length;

      if (jsonMode) {
        printJson(jsonSuccess({
          data: {
            templates: results.map(r => ({
              path: r.relativePath,
              name: r.name,
              type: r.templateFor,
              valid: r.valid,
              issues: r.issues,
            })),
            valid: validCount,
            invalid: invalidCount,
          },
        }));
        
        if (invalidCount > 0) {
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        return;
      }

      // Text output
      console.log(chalk.bold('\nValidating templates...\n'));

      for (const result of results) {
        console.log(result.relativePath);
        
        if (result.valid && result.issues.length === 0) {
          console.log(chalk.green('  ✓ Valid\n'));
        } else if (result.valid) {
          console.log(chalk.green('  ✓ Valid (with warnings)'));
          for (const issue of result.issues) {
            if (issue.severity === 'warning') {
              console.log(chalk.yellow(`  ⚠ ${issue.message}`));
              if (issue.suggestion) {
                console.log(chalk.gray(`    ${issue.suggestion}`));
              }
            }
          }
          console.log('');
        } else {
          console.log(chalk.red('  ✗ Invalid'));
          for (const issue of result.issues) {
            const icon = issue.severity === 'error' ? '✗' : '⚠';
            const color = issue.severity === 'error' ? chalk.red : chalk.yellow;
            console.log(color(`  ${icon} ${issue.message}`));
            if (issue.suggestion) {
              console.log(chalk.gray(`    ${issue.suggestion}`));
            }
          }
          console.log('');
        }
      }

      // Summary
      console.log(`${results.length} template(s), ${validCount} valid, ${invalidCount} invalid`);

      if (invalidCount > 0) {
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// template new <type>
// ============================================================================

templateCommand
  .command('new <type>')
  .description('Create a new template')
  .option('--name <name>', 'Template name (without .md)')
  .option('--description <desc>', 'Template description')
  .option('--json <data>', 'Create template non-interactively from JSON')
  .action(async (typePath: string, options: TemplateNewOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type path
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        const error = `Unknown type: ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      if (jsonMode) {
        await createTemplateFromJson(schema, vaultDir, typePath, options);
        return;
      }

      await createTemplateInteractive(schema, vaultDir, typePath, options);
    } catch (err) {
      if (err instanceof UserCancelledError) {
        console.log('\nCancelled.');
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
 * Create a template from JSON input.
 */
async function createTemplateFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  options: TemplateNewOptions
): Promise<void> {
  let jsonData: Record<string, unknown>;
  try {
    jsonData = JSON.parse(options.json!) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  const name = options.name ?? jsonData.name as string;
  if (!name) {
    printJson(jsonError('Template name is required (use --name or include "name" in JSON)'));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Check if template already exists
  const existing = await findTemplateByName(vaultDir, typePath, name);
  if (existing) {
    printJson(jsonError(`Template already exists: ${name}`));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  const templateDir = getTemplateDir(vaultDir, typePath);
  const templatePath = join(templateDir, `${name}.md`);

  // Build template content
  const frontmatter: Record<string, unknown> = {
    type: 'template',
    'template-for': typePath,
  };

  const description = options.description ?? jsonData.description;
  if (description) {
    frontmatter.description = description;
  }

  if (jsonData.defaults) {
    frontmatter.defaults = jsonData.defaults;
  }

  if (jsonData['prompt-fields']) {
    frontmatter['prompt-fields'] = jsonData['prompt-fields'];
  }

  if (jsonData['filename-pattern']) {
    frontmatter['filename-pattern'] = jsonData['filename-pattern'];
  }

  const body = typeof jsonData.body === 'string' 
    ? jsonData.body 
    : '# {title}\n\n[Template body - customize this section]';

  // Create directory and write template
  await mkdir(templateDir, { recursive: true });
  await writeNote(templatePath, frontmatter, body, ['type', 'template-for', 'description', 'defaults', 'prompt-fields', 'filename-pattern']);

  // Validate the created template
  const template = await parseTemplate(templatePath);
  if (template) {
    const validation = await validateTemplate(vaultDir, template, schema);
    if (!validation.valid) {
      printJson(jsonSuccess({
        path: relative(vaultDir, templatePath),
        message: 'Template created with validation warnings',
        data: { issues: validation.issues },
      }));
      return;
    }
  }

  printJson(jsonSuccess({
    path: relative(vaultDir, templatePath),
    message: 'Template created successfully',
  }));
}

/**
 * Create a template interactively.
 */
async function createTemplateInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  options: TemplateNewOptions
): Promise<void> {
  console.log(chalk.bold(`\nCreating template for: ${typePath}\n`));

  // Get template name
  let name = options.name;
  if (!name) {
    const input = await promptInput('Template name');
    if (input === null) throw new UserCancelledError();
    name = input.trim().toLowerCase().replace(/\s+/g, '-');
  }

  if (!name) {
    printError('Template name is required');
    process.exit(1);
  }

  // Check if template already exists
  const existing = await findTemplateByName(vaultDir, typePath, name);
  if (existing) {
    printError(`Template already exists: ${name}`);
    process.exit(1);
  }

  // Get description
  let description = options.description;
  if (!description) {
    const input = await promptInput('Description (optional)');
    if (input === null) throw new UserCancelledError();
    description = input.trim() || undefined;
  }

  // Get fields for this type
  const fields = getFieldsForType(schema, typePath);
  const fieldNames = Object.keys(fields);

  // Ask about defaults
  const defaults: Record<string, unknown> = {};
  const setDefaults = await promptConfirm('Set default values for fields?');
  if (setDefaults === null) throw new UserCancelledError();

  if (setDefaults) {
    console.log(chalk.gray('\nFor each field, enter a default value or press Enter to skip.\n'));
    
    for (const fieldName of fieldNames) {
      const field = fields[fieldName];
      if (!field) continue;

      // Skip static value fields
      if (field.value !== undefined) continue;

      const defaultValue = await promptFieldDefault(schema, vaultDir, fieldName, field);
      if (defaultValue !== undefined && defaultValue !== '') {
        defaults[fieldName] = defaultValue;
      }
    }
  }

  // Ask about prompt-fields
  let promptFields: string[] | undefined;
  if (Object.keys(defaults).length > 0) {
    const forcePrompt = await promptConfirm('Force prompting for any fields (even with defaults)?');
    if (forcePrompt === null) throw new UserCancelledError();

    if (forcePrompt) {
      const fieldsWithDefaults = Object.keys(defaults);
      const selected = await selectMultipleFields(fieldsWithDefaults, 'Select fields to always prompt');
      if (selected === null) throw new UserCancelledError();
      if (selected.length > 0) {
        promptFields = selected;
      }
    }
  }

  // Ask about filename pattern
  let filenamePattern: string | undefined;
  const customFilename = await promptConfirm('Custom filename pattern?');
  if (customFilename === null) throw new UserCancelledError();

  if (customFilename) {
    console.log(chalk.gray('Available placeholders: {title}, {date}, {date:FORMAT}, or any field name'));
    const input = await promptInput('Filename pattern', '{title}');
    if (input === null) throw new UserCancelledError();
    filenamePattern = input.trim() || undefined;
  }

  // Build template
  const templateDir = getTemplateDir(vaultDir, typePath);
  const templatePath = join(templateDir, `${name}.md`);

  const frontmatter: Record<string, unknown> = {
    type: 'template',
    'template-for': typePath,
  };

  if (description) {
    frontmatter.description = description;
  }

  if (Object.keys(defaults).length > 0) {
    frontmatter.defaults = defaults;
  }

  if (promptFields && promptFields.length > 0) {
    frontmatter['prompt-fields'] = promptFields;
  }

  if (filenamePattern) {
    frontmatter['filename-pattern'] = filenamePattern;
  }

  const body = '# {title}\n\n[Template body - customize this section]';

  // Create directory and write template
  await mkdir(templateDir, { recursive: true });
  await writeNote(templatePath, frontmatter, body, ['type', 'template-for', 'description', 'defaults', 'prompt-fields', 'filename-pattern']);

  // Validate the created template
  const template = await parseTemplate(templatePath);
  if (template) {
    const validation = await validateTemplate(vaultDir, template, schema);
    if (!validation.valid || validation.issues.length > 0) {
      printWarning('\nTemplate created with issues:');
      for (const issue of validation.issues) {
        const icon = issue.severity === 'error' ? '✗' : '⚠';
        const color = issue.severity === 'error' ? chalk.red : chalk.yellow;
        console.log(color(`  ${icon} ${issue.message}`));
        if (issue.suggestion) {
          console.log(chalk.gray(`    ${issue.suggestion}`));
        }
      }
    }
  }

  printSuccess(`\n✓ Created: ${relative(vaultDir, templatePath)}`);
}

/**
 * Prompt for a field default value.
 */
async function promptFieldDefault(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field
): Promise<unknown> {
  const label = field.label ?? fieldName;

  switch (field.prompt) {
    case 'select': {
      if (!field.enum) return undefined;
      const enumOptions = getEnumValues(schema, field.enum);
      const options = ['(skip)', ...enumOptions];
      
      const selected = await promptSelection(`Default ${label}:`, options);
      if (selected === null) throw new UserCancelledError();
      if (selected === '(skip)') return undefined;
      return selected;
    }

    case 'dynamic': {
      if (!field.source) return undefined;
      const dynamicOptions = await queryDynamicSource(schema, vaultDir, field.source);
      if (dynamicOptions.length === 0) return undefined;
      
      const options = ['(skip)', ...dynamicOptions];
      const selected = await promptSelection(`Default ${label}:`, options);
      if (selected === null) throw new UserCancelledError();
      if (selected === '(skip)') return undefined;
      return formatValue(selected, field.format);
    }

    case 'multi-input': {
      console.log(`Default ${label} (comma-separated values, or Enter to skip):`);
      const values = await promptMultiInput('');
      if (values === null) throw new UserCancelledError();
      if (values.length === 0) return undefined;
      return values;
    }

    case 'input':
    case 'date':
    default: {
      const input = await promptInput(`Default ${label} (or Enter to skip)`);
      if (input === null) throw new UserCancelledError();
      return input.trim() || undefined;
    }
  }
}

/**
 * Simple multi-select for field names.
 */
async function selectMultipleFields(
  fields: string[],
  message: string
): Promise<string[] | null> {
  console.log(`\n${message}:`);
  console.log(chalk.gray('Enter field numbers separated by commas, or Enter to skip\n'));

  for (let i = 0; i < fields.length; i++) {
    console.log(`  ${i + 1}. ${fields[i]}`);
  }

  const input = await promptInput('Selection');
  if (input === null) return null;
  if (!input.trim()) return [];

  const indices = input.split(',').map(s => parseInt(s.trim(), 10) - 1);
  const selected = indices
    .filter(i => i >= 0 && i < fields.length)
    .map(i => fields[i]!)
    .filter(Boolean);

  return selected;
}

// ============================================================================
// template edit <type> <name>
// ============================================================================

templateCommand
  .command('edit <type> <name>')
  .description('Edit an existing template')
  .option('--json <data>', 'Update template non-interactively with JSON (patch/merge semantics)')
  .action(async (typePath: string, templateName: string, options: TemplateEditOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type path
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        const error = `Unknown type: ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Find template
      const template = await findTemplateByName(vaultDir, typePath, templateName);
      if (!template) {
        const error = `Template not found: ${templateName} for type ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      if (jsonMode) {
        await editTemplateFromJson(schema, vaultDir, template, options.json!);
        return;
      }

      await editTemplateInteractive(schema, vaultDir, template);
    } catch (err) {
      if (err instanceof UserCancelledError) {
        console.log('\nCancelled.');
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
 * Edit a template from JSON input (patch/merge semantics).
 */
async function editTemplateFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  template: Template,
  jsonInput: string
): Promise<void> {
  let patchData: Record<string, unknown>;
  try {
    patchData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  // Parse existing template file
  const { frontmatter, body } = await parseNote(template.path);

  // Merge changes
  const newFrontmatter = { ...frontmatter };
  const updatedFields: string[] = [];

  // Handle description
  if ('description' in patchData) {
    if (patchData.description === null) {
      delete newFrontmatter.description;
    } else {
      newFrontmatter.description = patchData.description;
    }
    updatedFields.push('description');
  }

  // Handle defaults (merge nested)
  if ('defaults' in patchData) {
    if (patchData.defaults === null) {
      delete newFrontmatter.defaults;
    } else {
      newFrontmatter.defaults = {
        ...(newFrontmatter.defaults as Record<string, unknown> ?? {}),
        ...(patchData.defaults as Record<string, unknown>),
      };
      // Remove null values
      for (const [k, v] of Object.entries(newFrontmatter.defaults as Record<string, unknown>)) {
        if (v === null) {
          delete (newFrontmatter.defaults as Record<string, unknown>)[k];
        }
      }
    }
    updatedFields.push('defaults');
  }

  // Handle prompt-fields
  if ('prompt-fields' in patchData) {
    if (patchData['prompt-fields'] === null) {
      delete newFrontmatter['prompt-fields'];
    } else {
      newFrontmatter['prompt-fields'] = patchData['prompt-fields'];
    }
    updatedFields.push('prompt-fields');
  }

  // Handle filename-pattern
  if ('filename-pattern' in patchData) {
    if (patchData['filename-pattern'] === null) {
      delete newFrontmatter['filename-pattern'];
    } else {
      newFrontmatter['filename-pattern'] = patchData['filename-pattern'];
    }
    updatedFields.push('filename-pattern');
  }

  // Handle body
  let newBody = body;
  if ('body' in patchData && typeof patchData.body === 'string') {
    newBody = patchData.body;
    updatedFields.push('body');
  }

  // Write updated template
  await writeNote(
    template.path,
    newFrontmatter,
    newBody,
    ['type', 'template-for', 'description', 'defaults', 'prompt-fields', 'filename-pattern']
  );

  // Validate updated template
  const updated = await parseTemplate(template.path);
  if (updated) {
    const validation = await validateTemplate(vaultDir, updated, schema);
    if (!validation.valid) {
      printJson(jsonSuccess({
        path: relative(vaultDir, template.path),
        updated: updatedFields,
        message: 'Template updated with validation errors',
        data: { issues: validation.issues },
      }));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
  }

  printJson(jsonSuccess({
    path: relative(vaultDir, template.path),
    updated: updatedFields,
    message: 'Template updated successfully',
  }));
}

/**
 * Edit a template interactively.
 */
async function editTemplateInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  template: Template
): Promise<void> {
  console.log(chalk.bold(`\nEditing template: ${template.name}\n`));
  console.log(`  ${chalk.cyan('Type:')} ${template.templateFor}`);
  console.log(`  ${chalk.cyan('Path:')} ${relative(vaultDir, template.path)}\n`);

  // Parse existing template file
  const { frontmatter, body } = await parseNote(template.path);
  const newFrontmatter = { ...frontmatter };
  let newBody = body;

  // Edit description
  const currentDesc = template.description ?? '';
  console.log(`Current description: ${currentDesc || chalk.gray('(none)')}`);
  const newDesc = await promptInput('New description (or Enter to keep)');
  if (newDesc === null) throw new UserCancelledError();
  if (newDesc.trim()) {
    newFrontmatter.description = newDesc.trim();
  }

  // Edit defaults
  const fields = getFieldsForType(schema, template.templateFor);
  const fieldNames = Object.keys(fields);
  const currentDefaults = (newFrontmatter.defaults as Record<string, unknown>) ?? {};

  const editDefaults = await promptConfirm('Edit default values?');
  if (editDefaults === null) throw new UserCancelledError();

  if (editDefaults) {
    console.log(chalk.gray('\nFor each field, enter a new default, press Enter to keep, or type "clear" to remove.\n'));
    
    for (const fieldName of fieldNames) {
      const field = fields[fieldName];
      if (!field || field.value !== undefined) continue;

      const currentValue = currentDefaults[fieldName];
      const currentStr = formatDefaultValue(currentValue);
      console.log(`Current ${fieldName}: ${currentStr}`);

      const newValue = await promptFieldDefaultEdit(schema, vaultDir, fieldName, field, currentValue);
      if (newValue === 'CLEAR') {
        delete currentDefaults[fieldName];
      } else if (newValue !== undefined) {
        currentDefaults[fieldName] = newValue;
      }
    }

    if (Object.keys(currentDefaults).length > 0) {
      newFrontmatter.defaults = currentDefaults;
    } else {
      delete newFrontmatter.defaults;
    }
  }

  // Edit prompt-fields
  const currentPromptFields = (newFrontmatter['prompt-fields'] as string[]) ?? [];
  console.log(`\nCurrent prompt-fields: ${currentPromptFields.length > 0 ? currentPromptFields.join(', ') : chalk.gray('(none)')}`);
  
  const editPromptFields = await promptConfirm('Edit prompt-fields?');
  if (editPromptFields === null) throw new UserCancelledError();

  if (editPromptFields) {
    const allFieldNames = Object.keys(currentDefaults);
    if (allFieldNames.length > 0) {
      const selected = await selectMultipleFields(allFieldNames, 'Select fields to always prompt');
      if (selected === null) throw new UserCancelledError();
      if (selected.length > 0) {
        newFrontmatter['prompt-fields'] = selected;
      } else {
        delete newFrontmatter['prompt-fields'];
      }
    } else {
      console.log(chalk.gray('No defaults set - prompt-fields only makes sense with defaults.'));
    }
  }

  // Edit filename pattern
  const currentPattern = (newFrontmatter['filename-pattern'] as string) ?? '';
  console.log(`\nCurrent filename-pattern: ${currentPattern || chalk.gray('(none)')}`);
  
  const editPattern = await promptConfirm('Edit filename pattern?');
  if (editPattern === null) throw new UserCancelledError();

  if (editPattern) {
    console.log(chalk.gray('Available placeholders: {title}, {date}, {date:FORMAT}, or any field name'));
    console.log(chalk.gray('Type "clear" to remove the pattern.'));
    const input = await promptInput('Filename pattern', currentPattern);
    if (input === null) throw new UserCancelledError();
    if (input.toLowerCase() === 'clear') {
      delete newFrontmatter['filename-pattern'];
    } else if (input.trim()) {
      newFrontmatter['filename-pattern'] = input.trim();
    }
  }

  // Edit body
  console.log(`\nCurrent body preview:`);
  const lines = body.split('\n').slice(0, 5);
  for (const line of lines) {
    console.log(chalk.gray(`  ${line}`));
  }
  if (body.split('\n').length > 5) {
    console.log(chalk.gray('  ...'));
  }

  const editBody = await promptConfirm('Edit body?');
  if (editBody === null) throw new UserCancelledError();

  if (editBody) {
    console.log(chalk.gray('\nEnter new body content. Use \\n for newlines, or enter multiline with proper escaping.'));
    console.log(chalk.gray('Enter "keep" to keep the current body.\n'));
    const input = await promptInput('Body (or "keep")');
    if (input === null) throw new UserCancelledError();
    if (input.toLowerCase() !== 'keep' && input.trim()) {
      // Simple \n replacement for convenience
      newBody = input.replace(/\\n/g, '\n');
    }
  }

  // Write updated template
  await writeNote(
    template.path,
    newFrontmatter,
    newBody,
    ['type', 'template-for', 'description', 'defaults', 'prompt-fields', 'filename-pattern']
  );

  // Validate updated template
  const updated = await parseTemplate(template.path);
  if (updated) {
    const validation = await validateTemplate(vaultDir, updated, schema);
    if (!validation.valid || validation.issues.length > 0) {
      printWarning('\nTemplate updated with issues:');
      for (const issue of validation.issues) {
        const icon = issue.severity === 'error' ? '✗' : '⚠';
        const color = issue.severity === 'error' ? chalk.red : chalk.yellow;
        console.log(color(`  ${icon} ${issue.message}`));
        if (issue.suggestion) {
          console.log(chalk.gray(`    ${issue.suggestion}`));
        }
      }
    }
  }

  printSuccess(`\n✓ Updated: ${relative(vaultDir, template.path)}`);
}

/**
 * Format a default value for display.
 */
function formatDefaultValue(value: unknown): string {
  if (value === undefined || value === null) {
    return chalk.gray('(not set)');
  }
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`;
  }
  return String(value);
}

/**
 * Prompt for editing a field default value.
 * Returns 'CLEAR' if user wants to remove the default.
 */
async function promptFieldDefaultEdit(
  schema: LoadedSchema,
  vaultDir: string,
  fieldName: string,
  field: Field,
  currentValue: unknown
): Promise<unknown | 'CLEAR'> {
  const label = field.label ?? fieldName;

  switch (field.prompt) {
    case 'select': {
      if (!field.enum) return currentValue;
      const enumOptions = getEnumValues(schema, field.enum);
      const options = ['(keep)', '(clear)', ...enumOptions];
      
      const selected = await promptSelection(`New ${label}:`, options);
      if (selected === null) throw new UserCancelledError();
      if (selected === '(keep)') return currentValue;
      if (selected === '(clear)') return 'CLEAR';
      return selected;
    }

    case 'dynamic': {
      if (!field.source) return currentValue;
      const dynamicOptions = await queryDynamicSource(schema, vaultDir, field.source);
      if (dynamicOptions.length === 0) return currentValue;
      
      const options = ['(keep)', '(clear)', ...dynamicOptions];
      const selected = await promptSelection(`New ${label}:`, options);
      if (selected === null) throw new UserCancelledError();
      if (selected === '(keep)') return currentValue;
      if (selected === '(clear)') return 'CLEAR';
      return formatValue(selected, field.format);
    }

    case 'multi-input': {
      console.log(`New ${label} (comma-separated, Enter to keep, "clear" to remove):`);
      const input = await promptInput('');
      if (input === null) throw new UserCancelledError();
      if (!input.trim()) return currentValue;
      if (input.toLowerCase() === 'clear') return 'CLEAR';
      return input.split(',').map(s => s.trim()).filter(Boolean);
    }

    case 'input':
    case 'date':
    default: {
      const input = await promptInput(`New ${label} (Enter to keep, "clear" to remove)`);
      if (input === null) throw new UserCancelledError();
      if (!input.trim()) return currentValue;
      if (input.toLowerCase() === 'clear') return 'CLEAR';
      return input.trim();
    }
  }
}

// ============================================================================
// template delete <type> <name>
// ============================================================================

interface TemplateDeleteOptions {
  force?: boolean;
  output?: string;
}

templateCommand
  .command('delete <type> <name>')
  .description('Delete a template')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string, templateName: string, options: TemplateDeleteOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type path
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        const error = `Unknown type: ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Find template
      const template = await findTemplateByName(vaultDir, typePath, templateName);
      if (!template) {
        const error = `Template not found: ${templateName} for type ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      const relativePath = relative(vaultDir, template.path);

      // Confirm deletion unless --force
      if (!options.force && !jsonMode) {
        const confirmed = await promptConfirm(
          `Delete template '${template.name}' for type '${typePath}'?`
        );
        if (confirmed === null) throw new UserCancelledError();
        if (!confirmed) {
          console.log('Cancelled.');
          process.exit(0);
        }
      }

      // Delete the template file
      await unlink(template.path);

      if (jsonMode) {
        printJson(jsonSuccess({
          path: relativePath,
          message: 'Template deleted successfully',
        }));
        return;
      }

      printSuccess(`Deleted: ${relativePath}`);
    } catch (err) {
      if (err instanceof UserCancelledError) {
        console.log('\nCancelled.');
        process.exit(1);
      }

      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });
