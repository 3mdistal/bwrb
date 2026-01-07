import { Command } from 'commander';
import chalk from 'chalk';
import {
  getDashboard,
  createDashboard,
  updateDashboard,
  loadDashboards,
  listDashboards,
} from '../lib/dashboard.js';
import { resolveTargets, type TargetingOptions } from '../lib/targeting.js';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
import { setDefaultDashboard } from '../lib/schema-writer.js';
import { resolveVaultDir } from '../lib/vault.js';
import { getGlobalOpts } from '../lib/command.js';
import {
  promptInput,
  promptMultiInput,
  promptSelection,
  printError,
  printSuccess,
} from '../lib/prompt.js';
import {
  printJson,
  jsonSuccess,
  jsonError,
  ExitCodes,
  type ListOutputFormat,
} from '../lib/output.js';
import { listObjects, type ListOptions } from './list.js';
import { UserCancelledError } from '../lib/errors.js';
import type { DashboardDefinition, LoadedSchema } from '../types/schema.js';

/**
 * Resolve output format from string, with validation.
 * 'text' is an alias for 'default'.
 */
function resolveOutputFormat(format?: string): ListOutputFormat {
  if (!format || format === 'text') return 'default';
  const valid: ListOutputFormat[] = ['default', 'paths', 'tree', 'link', 'json'];
  return valid.includes(format as ListOutputFormat)
    ? (format as ListOutputFormat)
    : 'default';
}

// ============================================================================
// Dashboard Command (parent)
// ============================================================================

interface DashboardRunOptions {
  output?: string;
}

interface DashboardListOptions {
  output?: string;
}

export const dashboardCommand = new Command('dashboard')
  .description('Run or manage saved dashboard queries')
  .argument('[name]', 'Dashboard name to run')
  .option('-o, --output <format>', 'Output format: text (default), paths, tree, link, json')
  .enablePositionalOptions()
  .addHelpText('after', `
A dashboard is a saved list query. Running a dashboard executes the saved
query and displays results using the dashboard's default output format.

Commands:
  new <name>     Create a new dashboard
  list           List all saved dashboards
  edit [name]    Edit an existing dashboard
  delete <name>  Delete a dashboard (coming soon)

Examples:
  bwrb dashboard my-tasks              Run the "my-tasks" dashboard
  bwrb dashboard inbox --output json   Override output format to JSON
  bwrb dashboard new my-query --type task --where "status=active"
  bwrb dashboard list                  List all saved dashboards
  bwrb dashboard list --output json    List dashboards in JSON format
`)
  .action(async (name: string | undefined, options: DashboardRunOptions, cmd: Command) => {
    // If no name provided, show picker or run default dashboard
    if (!name) {
      await runDashboardPickerOrDefault(options, cmd);
      return;
    }

    // Run the named dashboard
    await runDashboard(name, options, cmd);
  });

/**
 * Run a saved dashboard by name.
 */
async function runDashboard(
  name: string,
  options: DashboardRunOptions,
  cmd: Command
): Promise<void> {
  const requestedFormat = options.output;
  let jsonMode = requestedFormat === 'json';

  try {
    const vaultDir = resolveVaultDir(getGlobalOpts(cmd));

    // 1. Load dashboard by name (before schema to fail fast on bad name)
    const dashboard = await getDashboard(vaultDir, name);
    if (!dashboard) {
      const msg = `Dashboard "${name}" does not exist.`;
      if (jsonMode) {
        printJson(jsonError(msg));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(msg);
      process.exit(1);
    }

    // 2. Determine effective output format and update jsonMode
    const effectiveFormat = requestedFormat
      ? resolveOutputFormat(requestedFormat)
      : resolveOutputFormat(dashboard.output);
    jsonMode = effectiveFormat === 'json';

    // 3. Load schema
    const schema = await loadSchema(vaultDir);

    // 4. Convert DashboardDefinition to TargetingOptions
    const targeting: TargetingOptions = {};
    if (dashboard.type) targeting.type = dashboard.type;
    if (dashboard.path) targeting.path = dashboard.path;
    if (dashboard.where) targeting.where = dashboard.where;
    if (dashboard.body) targeting.body = dashboard.body;

    // 5. Resolve targets using shared targeting module
    const targetResult = await resolveTargets(targeting, schema, vaultDir);

    if (targetResult.error) {
      if (jsonMode) {
        printJson(jsonError(targetResult.error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(targetResult.error);
      process.exit(1);
    }

    // 6. Build ListOptions and call shared listObjects
    const listOpts: ListOptions = {
      outputFormat: effectiveFormat,
      fields: dashboard.fields,
    };

    await listObjects(schema, vaultDir, targeting.type, targetResult.files, listOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      printJson(jsonError(message));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(message);
    process.exit(1);
  }
}

/**
 * Run the dashboard picker or default dashboard when no name is provided.
 * 
 * Behavior:
 * 1. JSON mode: return list of dashboards (no picker)
 * 2. No dashboards: show helpful message
 * 3. Default configured and exists: run it
 * 4. Default configured but missing: warn and show picker
 * 5. No default: show picker
 */
async function runDashboardPickerOrDefault(
  options: DashboardRunOptions,
  cmd: Command
): Promise<void> {
  const jsonMode = options.output === 'json';

  try {
    const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
    const schema = await loadSchema(vaultDir);
    // Load dashboards once and derive names from it (avoid double I/O)
    const dashboardsFile = await loadDashboards(vaultDir);
    const dashboardNames = Object.keys(dashboardsFile.dashboards).sort((a, b) => a.localeCompare(b));
    const defaultDashboard = schema.config.defaultDashboard;

    // JSON mode: return list of dashboards
    if (jsonMode) {
      printJson(jsonSuccess({
        data: {
          dashboards: dashboardNames,
          default: defaultDashboard ?? null,
        },
      }));
      return;
    }

    // Empty state: no dashboards
    if (dashboardNames.length === 0) {
      console.log('No dashboards saved.');
      console.log('\nCreate one with: bwrb dashboard new <name>');
      console.log('Or save from list: bwrb list --type task --save-as my-tasks');
      return;
    }

    // Check for default dashboard
    if (defaultDashboard) {
      if (dashboardNames.includes(defaultDashboard)) {
        // Run default dashboard
        await runDashboard(defaultDashboard, options, cmd);
        return;
      } else {
        // Default configured but doesn't exist - warn and show picker
        printError(`Default dashboard "${defaultDashboard}" not found.`);
        console.log('');
      }
    }

    // Check for TTY before showing picker
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printError('No dashboard specified. Use --output json to list dashboards or specify a name.');
      console.log('\nAvailable dashboards:');
      for (const name of dashboardNames) {
        console.log(`  ${name}`);
      }
      process.exit(1);
    }

    // Build picker options with type info and a map for lookup
    const displayToName = new Map<string, string>();
    const pickerOptions = dashboardNames.map(name => {
      const def = dashboardsFile.dashboards[name];
      const displayLabel = def?.type ? `${name} (${def.type})` : name;
      displayToName.set(displayLabel, name);
      return displayLabel;
    });

    // Show picker
    const selected = await promptSelection('Select a dashboard:', pickerOptions);
    if (selected === null) {
      throw new UserCancelledError();
    }

    // Look up the actual dashboard name from the display label
    const selectedName = displayToName.get(selected) ?? selected;

    // Run selected dashboard
    await runDashboard(selectedName, options, cmd);
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
}

// ============================================================================
// dashboard list
// ============================================================================

dashboardCommand
  .command('list')
  .description('List all saved dashboards')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (options: DashboardListOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const dashboardsFile = await loadDashboards(vaultDir);
      const dashboards = dashboardsFile.dashboards;
      const names = Object.keys(dashboards).sort((a, b) => a.localeCompare(b));

      if (jsonMode) {
        printJson(jsonSuccess({
          data: { dashboards },
        }));
        return;
      }

      // Text output
      if (names.length === 0) {
        console.log('No dashboards saved.');
        console.log('\nCreate one with: bwrb dashboard new <name>');
        console.log('Or save from list: bwrb list --type task --save-as my-tasks');
        return;
      }

      console.log(chalk.bold('\nDashboards\n'));

      // Calculate column widths
      const nameWidth = Math.max(10, ...names.map(n => n.length));
      const typeWidth = Math.max(6, ...names.map(n => (dashboards[n]?.type ?? '').length));

      // Header
      console.log(
        chalk.gray(
          'NAME'.padEnd(nameWidth + 2) +
          'TYPE'.padEnd(typeWidth + 2) +
          'FILTERS'
        )
      );

      // Rows
      for (const name of names) {
        const def = dashboards[name];
        if (!def) continue;

        const nameCol = chalk.cyan(name.padEnd(nameWidth + 2));
        const typeCol = chalk.green((def.type ?? '').padEnd(typeWidth + 2));
        
        // Build filters summary
        const filters: string[] = [];
        if (def.where && def.where.length > 0) {
          filters.push(`where: ${def.where.length}`);
        }
        if (def.path) {
          filters.push(`path: ${def.path}`);
        }
        if (def.body) {
          filters.push(`body: "${def.body}"`);
        }
        if (def.output && def.output !== 'default') {
          filters.push(`output: ${def.output}`);
        }
        if (def.fields && def.fields.length > 0) {
          filters.push(`fields: ${def.fields.length}`);
        }

        const filtersCol = filters.length > 0 
          ? chalk.gray(filters.join(', '))
          : chalk.gray('(no filters)');

        console.log(nameCol + typeCol + filtersCol);
      }

      console.log(`\n${names.length} dashboard(s) found`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.IO_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// dashboard new <name>
// ============================================================================

interface DashboardNewOptions {
  type?: string;
  path?: string;
  where?: string[];
  body?: string;
  defaultOutput?: string;
  fields?: string;
  json?: string;
  setDefault?: boolean;
}

dashboardCommand
  .command('new <name>')
  .description('Create a new dashboard')
  .option('-t, --type <type>', 'Filter by type path (e.g., task, objective/milestone)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**)')
  .option('-w, --where <expression...>', 'Filter expressions (can repeat)')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('--default-output <format>', 'Default output format: text, paths, tree, link, json')
  .option('--fields <fields>', 'Fields to display (comma-separated)')
  .option('--json <data>', 'Create from JSON (non-interactive)')
  .option('--set-default', 'Set this dashboard as the default')
  .addHelpText('after', `
Create a saved dashboard query. Dashboards can be created interactively
(when no flags are provided) or via command-line flags.

Examples:
  bwrb dashboard new my-tasks --type task
  bwrb dashboard new active-tasks --type task --where "status == 'active'"
  bwrb dashboard new inbox --type task --where "status == 'inbox'" --default-output tree
  bwrb dashboard new my-tasks --type task --set-default  # Set as default dashboard
  bwrb dashboard new my-query                   # Interactive mode
  bwrb dashboard new my-query --json '{"type":"task"}'
`)
  .action(async (name: string, options: DashboardNewOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      // Check if dashboard already exists
      const existing = await getDashboard(vaultDir, name);
      if (existing) {
        const error = `Dashboard "${name}" already exists`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Validate type if specified
      if (options.type) {
        const typeDef = getTypeDefByPath(schema, options.type);
        if (!typeDef) {
          const error = `Unknown type: ${options.type}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      if (jsonMode) {
        await createDashboardFromJson(vaultDir, name, options.json!, options.setDefault);
        return;
      }

      // Check if any flags were provided (excluding setDefault which is handled separately)
      const hasFlags = options.type || options.path || options.where || 
                       options.body || options.defaultOutput || options.fields;

      if (hasFlags) {
        await createDashboardFromFlags(vaultDir, name, options);
      } else {
        await createDashboardInteractive(schema, vaultDir, name);
      }

      // Set as default if requested
      if (options.setDefault) {
        await setDefaultDashboard(vaultDir, name);
        printSuccess(`Set "${name}" as default dashboard`);
      }
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
 * Create a dashboard from JSON input.
 */
async function createDashboardFromJson(
  vaultDir: string,
  name: string,
  jsonInput: string,
  setAsDefault?: boolean
): Promise<void> {
  let definition: DashboardDefinition;
  try {
    definition = JSON.parse(jsonInput) as DashboardDefinition;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  await createDashboard(vaultDir, name, definition);

  // Set as default if requested
  if (setAsDefault) {
    await setDefaultDashboard(vaultDir, name);
  }

  printJson(jsonSuccess({
    message: setAsDefault ? 'Dashboard created and set as default' : 'Dashboard created',
    data: { name, definition, isDefault: setAsDefault ?? false },
  }));
}

/**
 * Create a dashboard from command-line flags.
 */
async function createDashboardFromFlags(
  vaultDir: string,
  name: string,
  options: DashboardNewOptions
): Promise<void> {
  const definition: DashboardDefinition = {};

  if (options.type) definition.type = options.type;
  if (options.path) definition.path = options.path;
  if (options.where && options.where.length > 0) definition.where = options.where;
  if (options.body) definition.body = options.body;
  if (options.defaultOutput) {
    // Schema validates the value on save, so just cast and assign
    definition.output = options.defaultOutput as DashboardDefinition['output'];
  }
  if (options.fields) {
    definition.fields = options.fields.split(',').map(f => f.trim()).filter(Boolean);
  }

  await createDashboard(vaultDir, name, definition);

  printSuccess(`Created dashboard: ${name}`);
  printDashboardSummary(definition);
}

/**
 * Create a dashboard interactively.
 */
async function createDashboardInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  name: string
): Promise<void> {
  console.log(chalk.bold(`\nCreating dashboard: ${name}\n`));
  console.log(chalk.gray('Press Enter to skip optional fields.\n'));

  const definition: DashboardDefinition = {};

  // 1. Type selection (optional)
  const types = Array.from(schema.types.keys())
    .filter((t) => t !== 'meta')
    .sort();
  
  if (types.length > 0) {
    const typeOptions = ['(all types)', ...types];
    const selectedType = await promptSelection('Filter by type:', typeOptions);
    if (selectedType === null) throw new UserCancelledError();
    if (selectedType !== '(all types)') {
      definition.type = selectedType;
    }
  }

  // 2. Where expressions (optional)
  console.log(chalk.gray('\nWhere expressions filter by frontmatter values.'));
  console.log(chalk.gray('Examples: status == \'active\', priority < 3, !isEmpty(deadline)'));
  const whereInput = await promptMultiInput('Where expressions');
  if (whereInput === null) throw new UserCancelledError();
  if (whereInput.length > 0) {
    definition.where = whereInput;
  }

  // 3. Body search (optional)
  const bodyQuery = await promptInput('Body content search (optional)');
  if (bodyQuery === null) throw new UserCancelledError();
  if (bodyQuery.trim()) {
    definition.body = bodyQuery.trim();
  }

  // 4. Path filter (optional)
  console.log(chalk.gray('\nPath filter uses glob patterns.'));
  console.log(chalk.gray('Examples: Projects/**, Ideas/, **/Archive/**'));
  const pathFilter = await promptInput('Path filter (optional)');
  if (pathFilter === null) throw new UserCancelledError();
  if (pathFilter.trim()) {
    definition.path = pathFilter.trim();
  }

  // 5. Output format (optional)
  const outputOptions = ['(default)', 'paths', 'tree', 'link', 'json'];
  const selectedOutput = await promptSelection('Default output format:', outputOptions);
  if (selectedOutput === null) throw new UserCancelledError();
  if (selectedOutput !== '(default)') {
    definition.output = selectedOutput as DashboardDefinition['output'];
  }

  // 6. Fields (optional)
  console.log(chalk.gray('\nFields to display in table output (when not using paths/tree/link).'));
  const fieldsInput = await promptMultiInput('Display fields');
  if (fieldsInput === null) throw new UserCancelledError();
  if (fieldsInput.length > 0) {
    definition.fields = fieldsInput;
  }

  // Create the dashboard
  await createDashboard(vaultDir, name, definition);

  printSuccess(`\nCreated dashboard: ${name}`);
  printDashboardSummary(definition);
}

/**
 * Print a summary of the dashboard definition.
 */
function printDashboardSummary(definition: DashboardDefinition): void {
  const parts: string[] = [];
  
  if (definition.type) parts.push(`type: ${definition.type}`);
  if (definition.where && definition.where.length > 0) {
    parts.push(`where: ${JSON.stringify(definition.where)}`);
  }
  if (definition.body) parts.push(`body: "${definition.body}"`);
  if (definition.path) parts.push(`path: ${definition.path}`);
  if (definition.output) parts.push(`output: ${definition.output}`);
  if (definition.fields && definition.fields.length > 0) {
    parts.push(`fields: ${definition.fields.join(', ')}`);
  }

  if (parts.length > 0) {
    for (const part of parts) {
      console.log(chalk.gray(`  ${part}`));
    }
  } else {
    console.log(chalk.gray('  (no filters - matches all notes)'));
  }
}

// ============================================================================
// dashboard edit [name]
// ============================================================================

interface DashboardEditOptions {
  type?: string;
  path?: string;
  where?: string[];
  body?: string;
  defaultOutput?: string;
  fields?: string;
  json?: string;
  setDefault?: boolean;
}

dashboardCommand
  .command('edit [name]')
  .description('Edit an existing dashboard')
  .option('-t, --type <type>', 'Filter by type path (e.g., task, objective/milestone)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**)')
  .option('-w, --where <expression...>', 'Filter expressions (replaces existing)')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('--default-output <format>', 'Default output format: text, paths, tree, link, json')
  .option('--fields <fields>', 'Fields to display (comma-separated)')
  .option('--json <data>', 'Update from JSON (non-interactive, replaces definition)')
  .option('--set-default', 'Set this dashboard as the default')
  .addHelpText('after', `
Edit an existing dashboard's query parameters. In interactive mode, current
values are shown as defaults.

Examples:
  bwrb dashboard edit my-tasks                    # Interactive mode with picker
  bwrb dashboard edit my-tasks --type idea        # Update type via flag
  bwrb dashboard edit my-tasks --where "status == 'active'"  # Replace where
  bwrb dashboard edit my-tasks --set-default      # Set as default dashboard
  bwrb dashboard edit my-tasks --json '{"type":"task","output":"tree"}'
`)
  .action(async (name: string | undefined, options: DashboardEditOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      // If no name provided, show picker to select dashboard
      let dashboardName: string;
      if (name) {
        dashboardName = name;
      } else {
        const selected = await selectDashboardForEdit(vaultDir);
        if (!selected) {
          // No dashboards or user cancelled
          return;
        }
        dashboardName = selected;
      }

      // Load existing dashboard
      const existing = await getDashboard(vaultDir, dashboardName);
      if (!existing) {
        const error = `Dashboard "${dashboardName}" does not exist`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Validate type if specified
      if (options.type) {
        const typeDef = getTypeDefByPath(schema, options.type);
        if (!typeDef) {
          const error = `Unknown type: ${options.type}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      if (jsonMode) {
        await editDashboardFromJson(vaultDir, dashboardName, options.json!, options.setDefault);
        return;
      }

      // Check if any flags were provided (excluding setDefault which is handled after)
      const hasEditFlags = options.type || options.path || options.where || 
                           options.body || options.defaultOutput || options.fields;

      if (hasEditFlags) {
        await editDashboardFromFlags(vaultDir, dashboardName, existing, options);
      } else if (!options.setDefault) {
        // Only go interactive if no edit flags AND no --set-default
        await editDashboardInteractive(schema, vaultDir, dashboardName, existing);
      }

      // Set as default if requested
      if (options.setDefault) {
        await setDefaultDashboard(vaultDir, dashboardName);
        printSuccess(`Set "${dashboardName}" as default dashboard`);
      }
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
 * Show picker to select a dashboard for editing.
 * Returns null if no dashboards exist or user cancels.
 */
async function selectDashboardForEdit(vaultDir: string): Promise<string | null> {
  const names = await listDashboards(vaultDir);

  if (names.length === 0) {
    console.log('No dashboards to edit.');
    console.log('\nCreate one with: bwrb dashboard new <name>');
    return null;
  }

  // Check for TTY before showing picker
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printError('No dashboard specified. Provide a dashboard name to edit.');
    console.log('\nAvailable dashboards:');
    for (const n of names) {
      console.log(`  ${n}`);
    }
    process.exit(1);
  }

  // Load full definitions for display
  const dashboardsFile = await loadDashboards(vaultDir);
  const displayToName = new Map<string, string>();
  const pickerOptions = names.map(n => {
    const def = dashboardsFile.dashboards[n];
    const displayLabel = def?.type ? `${n} (${def.type})` : n;
    displayToName.set(displayLabel, n);
    return displayLabel;
  });

  const selected = await promptSelection('Select a dashboard to edit:', pickerOptions);
  if (selected === null) {
    throw new UserCancelledError();
  }

  return displayToName.get(selected) ?? selected;
}

/**
 * Update a dashboard from JSON input (replaces entire definition).
 */
async function editDashboardFromJson(
  vaultDir: string,
  name: string,
  jsonInput: string,
  setAsDefault?: boolean
): Promise<void> {
  let definition: DashboardDefinition;
  try {
    definition = JSON.parse(jsonInput) as DashboardDefinition;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    printJson(jsonError(error));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  await updateDashboard(vaultDir, name, definition);

  // Set as default if requested
  if (setAsDefault) {
    await setDefaultDashboard(vaultDir, name);
  }

  printJson(jsonSuccess({
    message: setAsDefault ? 'Dashboard updated and set as default' : 'Dashboard updated',
    data: { name, definition, isDefault: setAsDefault ?? false },
  }));
}

/**
 * Update a dashboard from command-line flags.
 * Only updates fields that are explicitly provided; preserves others.
 */
async function editDashboardFromFlags(
  vaultDir: string,
  name: string,
  existing: DashboardDefinition,
  options: DashboardEditOptions
): Promise<void> {
  // Start with existing definition
  const definition: DashboardDefinition = { ...existing };

  // Update only the fields that were provided
  if (options.type !== undefined) definition.type = options.type || undefined;
  if (options.path !== undefined) definition.path = options.path || undefined;
  if (options.where !== undefined) {
    definition.where = options.where.length > 0 ? options.where : undefined;
  }
  if (options.body !== undefined) definition.body = options.body || undefined;
  if (options.defaultOutput !== undefined) {
    definition.output = options.defaultOutput 
      ? (options.defaultOutput as DashboardDefinition['output'])
      : undefined;
  }
  if (options.fields !== undefined) {
    const fields = options.fields.split(',').map(f => f.trim()).filter(Boolean);
    definition.fields = fields.length > 0 ? fields : undefined;
  }

  await updateDashboard(vaultDir, name, definition);

  printSuccess(`Updated dashboard: ${name}`);
  printDashboardSummary(definition);
}

/**
 * Edit a dashboard interactively, showing current values as defaults.
 */
async function editDashboardInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  name: string,
  current: DashboardDefinition
): Promise<void> {
  console.log(chalk.bold(`\nEditing dashboard: ${name}\n`));
  console.log(chalk.gray('Press Enter to keep current value, or enter new value.\n'));

  const definition: DashboardDefinition = {};

  // 1. Type selection
  const types = Array.from(schema.types.keys())
    .filter((t) => t !== 'meta')
    .sort();
  
  if (types.length > 0) {
    const typeOptions = ['(all types)', ...types];
    console.log(chalk.gray(`Current type: ${current.type ?? '(all types)'}`));
    const selectedType = await promptSelection('Filter by type:', typeOptions);
    if (selectedType === null) throw new UserCancelledError();
    if (selectedType !== '(all types)') {
      definition.type = selectedType;
    }
  }

  // 2. Where expressions
  console.log(chalk.gray('\nWhere expressions filter by frontmatter values.'));
  if (current.where && current.where.length > 0) {
    console.log(chalk.gray(`Current: ${current.where.join(', ')}`));
  }
  const whereDefault = current.where?.join(', ') ?? '';
  const whereInput = await promptMultiInput('Where expressions', whereDefault);
  if (whereInput === null) throw new UserCancelledError();
  if (whereInput.length > 0) {
    definition.where = whereInput;
  }

  // 3. Body search
  console.log(chalk.gray(`\nCurrent body search: ${current.body ?? '(none)'}`));
  const bodyQuery = await promptInput('Body content search (optional)', current.body);
  if (bodyQuery === null) throw new UserCancelledError();
  if (bodyQuery.trim()) {
    definition.body = bodyQuery.trim();
  }

  // 4. Path filter
  console.log(chalk.gray(`\nCurrent path filter: ${current.path ?? '(none)'}`));
  const pathFilter = await promptInput('Path filter (optional)', current.path);
  if (pathFilter === null) throw new UserCancelledError();
  if (pathFilter.trim()) {
    definition.path = pathFilter.trim();
  }

  // 5. Output format
  const outputOptions = ['(default)', 'paths', 'tree', 'link', 'json'];
  console.log(chalk.gray(`\nCurrent output: ${current.output ?? '(default)'}`));
  const selectedOutput = await promptSelection('Default output format:', outputOptions);
  if (selectedOutput === null) throw new UserCancelledError();
  if (selectedOutput !== '(default)') {
    definition.output = selectedOutput as DashboardDefinition['output'];
  }

  // 6. Fields
  console.log(chalk.gray('\nFields to display in table output (when not using paths/tree/link).'));
  if (current.fields && current.fields.length > 0) {
    console.log(chalk.gray(`Current: ${current.fields.join(', ')}`));
  }
  const fieldsDefault = current.fields?.join(', ') ?? '';
  const fieldsInput = await promptMultiInput('Display fields', fieldsDefault);
  if (fieldsInput === null) throw new UserCancelledError();
  if (fieldsInput.length > 0) {
    definition.fields = fieldsInput;
  }

  // Update the dashboard
  await updateDashboard(vaultDir, name, definition);

  printSuccess(`\nUpdated dashboard: ${name}`);
  printDashboardSummary(definition);
}
