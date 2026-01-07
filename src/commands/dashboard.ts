import { Command } from 'commander';
import chalk from 'chalk';
import {
  getDashboard,
  createDashboard,
  listDashboards,
} from '../lib/dashboard.js';
import { resolveTargets, type TargetingOptions } from '../lib/targeting.js';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
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

export const dashboardCommand = new Command('dashboard')
  .description('Run or manage saved dashboard queries')
  .argument('[name]', 'Dashboard name to run')
  .option('-o, --output <format>', 'Output format: text (default), paths, tree, link, json')
  .addHelpText('after', `
A dashboard is a saved list query. Running a dashboard executes the saved
query and displays results using the dashboard's default output format.

Commands:
  new <name>     Create a new dashboard
  list           List all saved dashboards (coming soon)
  edit <name>    Edit an existing dashboard (coming soon)
  delete <name>  Delete a dashboard (coming soon)

Examples:
  bwrb dashboard my-tasks              Run the "my-tasks" dashboard
  bwrb dashboard inbox --output json   Override output format to JSON
  bwrb dashboard new my-query --type task --where "status=active"
`)
  .action(async (name: string | undefined, options: DashboardRunOptions, cmd: Command) => {
    // If no name provided, show available dashboards
    if (!name) {
      try {
        const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
        const dashboards = await listDashboards(vaultDir);
        
        if (dashboards.length === 0) {
          console.log('No dashboards saved yet.');
          console.log('\nCreate one with: bwrb dashboard new <name>');
          return;
        }

        console.log(chalk.bold('\nAvailable dashboards:\n'));
        for (const dashboard of dashboards) {
          console.log(`  ${dashboard}`);
        }
        console.log('\nRun with: bwrb dashboard <name>');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        printError(message);
        process.exit(1);
      }
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
      filters: [],
      whereExpressions: [],
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
  .addHelpText('after', `
Create a saved dashboard query. Dashboards can be created interactively
(when no flags are provided) or via command-line flags.

Examples:
  bwrb dashboard new my-tasks --type task
  bwrb dashboard new active-tasks --type task --where "status == 'active'"
  bwrb dashboard new inbox --type task --where "status == 'inbox'" --default-output tree
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
        await createDashboardFromJson(vaultDir, name, options.json!);
        return;
      }

      // Check if any flags were provided
      const hasFlags = options.type || options.path || options.where || 
                       options.body || options.defaultOutput || options.fields;

      if (hasFlags) {
        await createDashboardFromFlags(vaultDir, name, options);
      } else {
        await createDashboardInteractive(schema, vaultDir, name);
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
  jsonInput: string
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

  printJson(jsonSuccess({
    message: 'Dashboard created',
    data: { name, definition },
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
