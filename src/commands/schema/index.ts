/**
 * Schema command entry point.
 * Wires together all schema subcommands from domain-focused modules.
 */

import { Command } from 'commander';
import { loadSchema } from '../../lib/schema.js';
import { resolveVaultDir } from '../../lib/vault.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { printError } from '../../lib/prompt.js';
import { getGlobalOpts } from '../../lib/command.js';

// Subcommand modules
import { listCommand } from './list.js';
import { registerNewTypeCommand, registerEditTypeCommand, registerDeleteTypeCommand } from './type.js';
import { registerNewFieldCommand, registerEditFieldCommand, registerDeleteFieldCommand } from './field.js';
import { registerMigrationCommands } from './migrate.js';
import { registerDeprecatedCommands } from './deprecated.js';
import { promptSchemaEntityType } from './helpers/pickers.js';

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
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: ValidateOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));

      // Loading the schema validates it via Zod
      await loadSchema(vaultDir);

      if (jsonMode) {
        printJson(jsonSuccess({ message: 'Schema is valid' }));
      } else {
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
  .addHelpText('after', `
Examples:
  bwrb schema edit                   # Prompts for what to edit
  bwrb schema edit type              # Edit a type (shows picker)
  bwrb schema edit type task         # Edit the "task" type
  bwrb schema edit field             # Edit a field (shows pickers)
  bwrb schema edit field task status # Edit "status" field on "task" type`);

// schema edit (no args - prompt for entity type)
editCommand
  .action(async (options: EditCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
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
  .addHelpText('after', `
Examples:
  bwrb schema delete                      # Prompts for what to delete
  bwrb schema delete type                 # Delete a type (shows picker, dry-run)
  bwrb schema delete type project         # Preview deleting "project" type
  bwrb schema delete type project --execute  # Actually delete "project" type
  bwrb schema delete field                # Delete a field (shows pickers)
  bwrb schema delete field task status    # Preview deleting "status" from "task"`);

// schema delete (no args - prompt for entity type)
deleteCommand
  .action(async (options: DeleteCommandOptions, _cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
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

// Deprecated commands (edit-type, edit-field) - for backwards compatibility
registerDeprecatedCommands(schemaCommand);
