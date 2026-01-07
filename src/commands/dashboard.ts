import { Command } from 'commander';
import { getDashboard } from '../lib/dashboard.js';
import { resolveTargets, type TargetingOptions } from '../lib/targeting.js';
import { loadSchema } from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { getGlobalOpts } from '../lib/command.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
  type ListOutputFormat,
} from '../lib/output.js';
import { listObjects, type ListOptions } from './list.js';

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

interface DashboardCommandOptions {
  output?: string;
}

export const dashboardCommand = new Command('dashboard')
  .description('Run a saved dashboard query')
  .argument('<name>', 'Dashboard name to run')
  .option('-o, --output <format>', 'Output format: text (default), paths, tree, link, json')
  .addHelpText('after', `
A dashboard is a saved list query. Running a dashboard executes the saved
query and displays results using the dashboard's default output format.

Examples:
  bwrb dashboard my-tasks              Run the "my-tasks" dashboard
  bwrb dashboard inbox --output json   Override output format to JSON
`)
  .action(async (name: string, options: DashboardCommandOptions, cmd: Command) => {
    const requestedFormat = options.output;
    // Initial JSON mode check for early errors (before dashboard is loaded)
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
      // Priority: --output flag > dashboard's default > 'default'
      const effectiveFormat = requestedFormat
        ? resolveOutputFormat(requestedFormat)
        : resolveOutputFormat(dashboard.output);
      jsonMode = effectiveFormat === 'json';

      // 3. Load schema
      const schema = await loadSchema(vaultDir);

      // 4. Convert DashboardDefinition to TargetingOptions
      // Only include defined properties to satisfy exactOptionalPropertyTypes
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
        filters: [], // Dashboard uses --where via targeting, not deprecated filters
        whereExpressions: [], // Already applied by resolveTargets
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
  });
