/**
 * Schema command entry point.
 * Wires together all schema subcommands from domain-focused modules.
 */

import { Command } from 'commander';
import { loadSchema, getOutputDir } from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { printError } from '../../lib/prompt.js';
import { getGlobalOpts } from '../../lib/command.js';

// Subcommand modules
import { listCommand } from './list.js';
import { registerNewTypeCommand, registerEditTypeCommand, registerDeleteTypeCommand } from './type.js';
import { registerNewFieldCommand, registerEditFieldCommand, registerDeleteFieldCommand } from './field.js';
import { registerMigrationCommands } from './migrate.js';
import { promptSchemaEntityType, inferSchemaEntity, getTypesWithOwnField } from './helpers/pickers.js';
import { promptSelection } from '../../lib/prompt.js';

// ============================================================================
// Main Schema Command
// ============================================================================

export const schemaCommand = new Command('schema')
  .description('Schema introspection commands')
  .addHelpText('after', `
Examples:
  bwrb schema list              # List all types
  bwrb schema list objective    # Show objective type details
  bwrb schema list objective/task  # Show task subtype details
  bwrb schema list task --output json  # Show as JSON for AI/scripting
  bwrb schema validate          # Validate schema structure`);

// ============================================================================
// Validate Command
// ============================================================================

interface ValidateOptions {
  output?: string;
}

schemaCommand
  .command('validate')
  .description('Validate schema structure')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (options: ValidateOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));

      // Loading the schema validates it via Zod
      const schema = await loadSchema(vaultDir);

      const warnings = Array.from(schema.types.keys())
        .filter(typeName => typeName !== 'meta')
        .filter(typeName => !schema.types.get(typeName)?.outputDir)
        .sort((a, b) => a.localeCompare(b))
        .map(typeName => ({
          type: typeName,
          computed_output_dir: getOutputDir(schema, typeName),
        }));

      if (jsonMode) {
        printJson(
          warnings.length > 0
            ? jsonSuccess({ message: 'Schema is valid', data: { warnings } })
            : jsonSuccess({ message: 'Schema is valid' })
        );
      } else {
        for (const warning of warnings) {
          console.error(
            `Warning: type "${warning.type}" is missing output_dir (computed: "${warning.computed_output_dir}")`
          );
        }
        console.log('Schema is valid');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(`Schema validation failed: ${message}`));
        process.exit(ExitCodes.SCHEMA_ERROR);
      }
      printError('Schema validation failed:');
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// Unified Verb Commands (new, edit, delete)
// ============================================================================

interface NewCommandOptions {
  output?: string;
}

interface EditCommandOptions {
  output?: string;
}

interface DeleteCommandOptions {
  output?: string;
  execute?: boolean;
}

// -------------------- schema new --------------------

const newCommand = new Command('new')
  .description('Create a new type or field')
  .addHelpText('after', `
Examples:
  bwrb schema new                    # Prompts for what to create
  bwrb schema new type               # Create a new type
  bwrb schema new type project       # Create type named "project"
  bwrb schema new field              # Create a field (prompts for type)
  bwrb schema new field task status  # Add "status" field to "task" type`);

// schema new (no args - prompt for entity type)
newCommand
  .action(async (options: NewCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      if (jsonMode) {
        throw new Error('Entity type argument is required in JSON mode. Use: schema new type|field');
      }

      const entityType = await promptSchemaEntityType('create');
      if (entityType === null) {
        process.exit(0);
      }

      // Re-invoke the appropriate subcommand
      const args = [entityType];
      await newCommand.parseAsync(args, { from: 'user' });
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

// Register type and field subcommands
registerNewTypeCommand(newCommand);
registerNewFieldCommand(newCommand);

schemaCommand.addCommand(newCommand);

// -------------------- schema edit --------------------

const editCommand = new Command('edit')
  .description('Edit an existing type or field')
  .argument('[name]', 'Name to edit (infers type vs field from schema)')
  .addHelpText('after', `
Examples:
  bwrb schema edit                   # Prompts for what to edit
  bwrb schema edit task              # Infers "task" is a type, edits it
  bwrb schema edit status            # Infers "status" is a field, prompts for type
  bwrb schema edit type              # Edit a type (shows picker)
  bwrb schema edit type task         # Edit the "task" type
  bwrb schema edit field             # Edit a field (shows pickers)
  bwrb schema edit field task status # Edit "status" field on "task" type`);

// schema edit [name] - infers type vs field from name, or prompts if no name
editCommand
  .action(async (name: string | undefined, options: EditCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      // If no name provided, prompt for entity type (original behavior)
      if (!name) {
        if (jsonMode) {
          throw new Error('Entity type argument is required in JSON mode. Use: schema edit type|field');
        }

        const entityType = await promptSchemaEntityType('edit');
        if (entityType === null) {
          process.exit(0);
        }

        // Re-invoke the appropriate subcommand
        const args = [entityType];
        await editCommand.parseAsync(args, { from: 'user' });
        return;
      }

      // Name provided - check if it's a subcommand (type/field) first
      if (name === 'type' || name === 'field') {
        // Let Commander handle the subcommand
        return;
      }

      // Try to infer what the name refers to
      const globalOpts = getGlobalOpts(cmd);
      const vaultDir = resolveVaultDir(globalOpts);
      const schema = await loadSchema(vaultDir);
      const match = inferSchemaEntity(schema, name);

      switch (match.kind) {
        case 'type':
          // Route to: schema edit type <name>
          await editCommand.parseAsync(['type', name], { from: 'user' });
          break;

        case 'field': {
          // Find types that have this field
          const typesWithField = getTypesWithOwnField(schema, name);
          
          if (typesWithField.length === 0) {
            // Shouldn't happen since inferSchemaEntity found it, but handle gracefully
            throw new Error(`Field '${name}' not found in any type`);
          }
          
          let targetType: string;
          if (typesWithField.length === 1) {
            // Only one type has this field - use it directly
            targetType = typesWithField[0]!;
          } else {
            // Multiple types have this field - prompt user to select
            const selected = await promptSelection(
              `Multiple types have '${name}'. Select type to edit:`,
              typesWithField
            );
            if (selected === null) {
              process.exit(0);
            }
            targetType = selected;
          }
          
          // Route to: schema edit field <type> <field>
          await editCommand.parseAsync(['field', targetType, name], { from: 'user' });
          break;
        }

        case 'both':
          throw new Error(
            `Ambiguous: '${name}' exists as both a type and a field.\n` +
            `Use 'bwrb schema edit type ${name}' or 'bwrb schema edit field ${name}'`
          );

        case 'none':
          throw new Error(
            `'${name}' is not a known type or field name.\n` +
            `Run 'bwrb schema list' to see available types and fields.`
          );
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

// Register type and field subcommands
registerEditTypeCommand(editCommand);
registerEditFieldCommand(editCommand);

schemaCommand.addCommand(editCommand);

// -------------------- schema delete --------------------

const deleteCommand = new Command('delete')
  .description('Delete a type or field (dry-run by default)')
  .argument('[name]', 'Name to delete (infers type vs field from schema)')
  .addHelpText('after', `
Examples:
  bwrb schema delete                      # Prompts for what to delete
  bwrb schema delete task                 # Infers "task" is a type, deletes it
  bwrb schema delete status               # Infers "status" is a field, prompts for type
  bwrb schema delete type                 # Delete a type (shows picker, dry-run)
  bwrb schema delete type project         # Preview deleting "project" type
  bwrb schema delete type project --execute  # Actually delete "project" type
  bwrb schema delete field                # Delete a field (shows pickers)
  bwrb schema delete field task status    # Preview deleting "status" from "task"`);

// schema delete [name] - infers type vs field from name, or prompts if no name
deleteCommand
  .action(async (name: string | undefined, options: DeleteCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      // If no name provided, prompt for entity type (original behavior)
      if (!name) {
        if (jsonMode) {
          throw new Error('Entity type argument is required in JSON mode. Use: schema delete type|field');
        }

        const entityType = await promptSchemaEntityType('delete');
        if (entityType === null) {
          process.exit(0);
        }

        // Re-invoke the appropriate subcommand
        const args = [entityType];
        await deleteCommand.parseAsync(args, { from: 'user' });
        return;
      }

      // Name provided - check if it's a subcommand (type/field) first
      if (name === 'type' || name === 'field') {
        // Let Commander handle the subcommand
        return;
      }

      // Try to infer what the name refers to
      const globalOpts = getGlobalOpts(cmd);
      const vaultDir = resolveVaultDir(globalOpts);
      const schema = await loadSchema(vaultDir);
      const match = inferSchemaEntity(schema, name);

      switch (match.kind) {
        case 'type':
          // Route to: schema delete type <name>
          await deleteCommand.parseAsync(['type', name], { from: 'user' });
          break;

        case 'field': {
          // Find types that have this field
          const typesWithField = getTypesWithOwnField(schema, name);
          
          if (typesWithField.length === 0) {
            throw new Error(`Field '${name}' not found in any type`);
          }
          
          let targetType: string;
          if (typesWithField.length === 1) {
            targetType = typesWithField[0]!;
          } else {
            if (jsonMode) {
              throw new Error(
                `Field '${name}' exists on multiple types: ${typesWithField.join(', ')}. ` +
                `Specify the type explicitly: schema delete field <type> ${name}`
              );
            }
            const selected = await promptSelection(
              `Multiple types have '${name}'. Select type to delete from:`,
              typesWithField
            );
            if (selected === null) {
              process.exit(0);
            }
            targetType = selected;
          }
          
          // Route to: schema delete field <type> <field>
          await deleteCommand.parseAsync(['field', targetType, name], { from: 'user' });
          break;
        }

        case 'both':
          throw new Error(
            `Ambiguous: '${name}' exists as both a type and a field.\n` +
            `Use 'bwrb schema delete type ${name}' or 'bwrb schema delete field ${name}'`
          );

        case 'none':
          throw new Error(
            `'${name}' is not a known type or field name.\n` +
            `Run 'bwrb schema list' to see available types and fields.`
          );
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

// Register type and field subcommands
registerDeleteTypeCommand(deleteCommand);
registerDeleteFieldCommand(deleteCommand);

schemaCommand.addCommand(deleteCommand);

// ============================================================================
// Register Other Command Groups
// ============================================================================

// List commands (list, list types, list fields, list type <name>)
schemaCommand.addCommand(listCommand);

// Migration commands (diff, migrate, history)
registerMigrationCommands(schemaCommand);
