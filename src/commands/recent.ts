import { Command } from 'commander';
import { basename, relative } from 'path';
import { stat } from 'fs/promises';
import chalk from 'chalk';
import { loadSchema, getTypeDefByPath, formatUnknownTypeError } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
  exitWithResolutionError,
  type ListOutputFormat,
} from '../lib/output.js';
import { UserCancelledError } from '../lib/errors.js';
import {
  resolveTargets,
  parsePositionalArg,
  hasAnyTargeting,
  formatTargetingSummary,
  type TargetingOptions,
} from '../lib/targeting.js';
import { getTtyContext } from '../lib/tty/context.js';
import { renderTable } from '../lib/tty/table.js';

/**
 * Default number of recently-modified notes to show when --limit is omitted.
 */
const DEFAULT_RECENT_LIMIT = 20;

interface RecentCommandOptions {
  type?: string;
  path?: string;
  body?: string;
  where?: string[];
  limit?: string;
  output?: string;
}

/**
 * Resolve the output format from the --output flag. `recent` shares the
 * list output contract but only supports the formats that make sense for a
 * flat, recency-ordered listing (no tree).
 */
function resolveRecentOutputFormat(value: string | undefined): ListOutputFormat {
  if (!value) return 'default';
  if (value === 'text') return 'default';
  const valid: ListOutputFormat[] = ['default', 'paths', 'link', 'json'];
  if (valid.includes(value as ListOutputFormat)) {
    return value as ListOutputFormat;
  }
  return 'default';
}

function parseRecentLimit(value: string | undefined, jsonMode: boolean): number {
  if (value === undefined) return DEFAULT_RECENT_LIMIT;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    const error = 'Invalid --limit value: must be a positive integer';
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  return limit;
}

/**
 * The recency source for `recent` is the file modification time (mtime) from
 * the filesystem. This is deterministic, requires no frontmatter convention,
 * and matches the scoping decision on issue #68 ("recently *modified* notes").
 */
interface RecentFile {
  path: string;
  frontmatter: Record<string, unknown>;
  mtimeMs: number;
}

export const recentCommand = new Command('recent')
  .description('List recently modified notes (most-recent first)')
  .addHelpText('after', `
Recency source:
  Notes are ordered by file modification time (mtime), most-recent first.
  This is sugar over 'list' for the common "what did I touch lately?" query.

Targeting Selectors (compose via AND):
  --type <type>        Filter by type (e.g., task, objective/milestone)
  --path <glob>        Filter by file path (e.g., Projects/**, Ideas/)
  --where <expr>       Filter by frontmatter expression (can repeat)
  --body <query>       Filter by body content (uses ripgrep)
  --limit <n>          Show only the first n notes (default ${DEFAULT_RECENT_LIMIT})

Examples:
  bwrb recent
  bwrb recent --limit 5
  bwrb recent --type task
  bwrb recent --type task --limit 10
  bwrb recent --output json
  bwrb recent --output paths
  bwrb recent --path "Projects/**"`)
  .argument('[positional]', 'Smart positional: type, path (contains /), or where expression (contains =<>~)')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**, Ideas/)')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('--limit <n>', `Limit output to the first n notes (default ${DEFAULT_RECENT_LIMIT})`)
  .option('--output <format>', 'Output format: text (default), paths, link, json')
  .action(async (positional: string | undefined, options: RecentCommandOptions, cmd: Command) => {
    const outputFormat = resolveRecentOutputFormat(options.output);
    const jsonMode = outputFormat === 'json';

    try {
      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      // Build targeting options from flags
      const targeting: TargetingOptions = {};
      if (options.type) targeting.type = options.type;
      if (options.path) targeting.path = options.path;
      if (options.where) targeting.where = options.where;
      if (options.body) targeting.body = options.body;

      // Handle smart positional detection (mirrors `list`)
      if (positional) {
        const positionalResult = parsePositionalArg(positional, schema, targeting);
        if (positionalResult.error) {
          if (jsonMode) {
            printJson(jsonError(positionalResult.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(positionalResult.error);
          process.exit(1);
        }
        Object.assign(targeting, positionalResult.options);
      }

      // Validate type if specified
      if (targeting.type) {
        const typeDef = getTypeDefByPath(schema, targeting.type);
        if (!typeDef) {
          const error = formatUnknownTypeError(schema, targeting.type);
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
        targeting.type = typeDef.name;
      }

      const limit = parseRecentLimit(options.limit, jsonMode);

      // Reuse list's discovery + targeting infrastructure
      const targetResult = await resolveTargets(targeting, schema, vaultDir);

      if (targetResult.error) {
        exitWithResolutionError(targetResult.error, targetResult.files, jsonMode);
      }

      // Stat files for mtime (the recency source). Skip files that can't be
      // stat'd (e.g. removed mid-scan) rather than failing the whole command.
      const withMtime: RecentFile[] = [];
      for (const file of targetResult.files) {
        try {
          const stats = await stat(file.path);
          withMtime.push({
            path: file.path,
            frontmatter: file.frontmatter,
            mtimeMs: stats.mtimeMs,
          });
        } catch {
          // Skip unreadable files
        }
      }

      // Sort most-recent first; ties break alphabetically by note name for
      // deterministic output.
      withMtime.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return basename(a.path, '.md').localeCompare(basename(b.path, '.md'));
      });

      const limited = withMtime.slice(0, limit);

      // No results
      if (limited.length === 0) {
        if (jsonMode) {
          console.log(JSON.stringify([], null, 2));
        } else if (outputFormat === 'default') {
          // Only the human-facing default output prints a message; the
          // machine-facing formats (paths/link) stay silent like `list`.
          if (hasAnyTargeting(targeting)) {
            console.log(`No notes found matching: ${formatTargetingSummary(targeting)}`);
          } else {
            console.log('No notes found.');
          }
        }
        return;
      }

      switch (outputFormat) {
        case 'json': {
          const jsonOutput = limited.map(({ path, frontmatter, mtimeMs }) => ({
            _path: relative(vaultDir, path),
            _name: basename(path, '.md'),
            _modified: new Date(mtimeMs).toISOString(),
            ...frontmatter,
          }));
          console.log(JSON.stringify(jsonOutput, null, 2));
          return;
        }

        case 'paths': {
          for (const { path } of limited) {
            console.log(relative(vaultDir, path));
          }
          return;
        }

        case 'link': {
          for (const { path } of limited) {
            console.log(`[[${basename(path, '.md')}]]`);
          }
          return;
        }

        default: {
          printRecentTable(limited);
          return;
        }
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
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
 * Format a timestamp for the default (human) table output.
 * Uses the local-timezone date and time, second precision dropped.
 */
function formatModified(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time}`;
}

/**
 * Render the default table: NAME + MODIFIED columns.
 */
function printRecentTable(files: RecentFile[]): void {
  const context = getTtyContext();
  const headerStyle = context.colorEnabled ? (text: string) => chalk.gray(text) : null;

  const columns = [
    {
      key: 'primary',
      title: 'NAME',
      minWidth: 12,
      weight: 2,
      priority: 0,
      canDrop: false,
      ...(headerStyle ? { style: headerStyle } : {}),
    },
    {
      key: 'modified',
      title: 'MODIFIED',
      minWidth: 16,
      weight: 1,
      priority: 1,
      canDrop: true,
      ...(headerStyle ? { style: headerStyle } : {}),
    },
  ];

  const rows = files.map(({ path, mtimeMs }) => ({
    primary: basename(path, '.md'),
    modified: formatModified(mtimeMs),
  }));

  const lines = renderTable({ columns, rows, context });
  for (const line of lines) {
    console.log(line);
  }
}
