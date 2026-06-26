import { Command } from 'commander';
import { basename, relative } from 'path';
import { stat } from 'fs/promises';
import chalk from 'chalk';
import { loadSchema, getTypeDefByPath, formatUnknownTypeError } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts, resolveGlobalPickerMode } from '../lib/command.js';
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
import { formatFileTimestamp } from '../lib/list-helpers.js';
import { openNote, resolveAppMode, parseAppMode } from './open.js';
import { pickFile, parsePickerMode } from '../lib/picker.js';
import { createDashboard, updateDashboard, getDashboard } from '../lib/dashboard.js';
import type { DashboardDefinition } from '../types/schema.js';

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
  // Open options (parity with `list`)
  open?: boolean;
  app?: string;
  // Dashboard save options (parity with `list`)
  saveAs?: string;
  force?: boolean;
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

Open Options:
  --open               Open the most recent note (picker if multiple)
  --app <mode>         How to open: system (default), editor, visual, obsidian, print

App Modes:
  system      Open with OS default handler (default)
  editor      Open in terminal editor ($EDITOR or config.editor)
  visual      Open in GUI editor ($VISUAL or config.visual)
  obsidian    Open in Obsidian via URI scheme
  print       Print the resolved path (for scripting)

App-Mode Precedence (for --open):
  1. --app flag (explicit)
  2. [mode] positional argument (the SECOND positional; see note below)
  3. BWRB_DEFAULT_APP environment variable
  4. config.open_with in .bwrb/schema.json
  5. Fallback: system

  Note: [mode] is the second positional, after the smart [positional] filter.
  A single positional is always the filter (type/path/where), never the mode —
  so use 'bwrb recent task print --open', not 'bwrb recent print --open'
  (which would treat 'print' as a type filter). To set the app mode without a
  filter positional, use the --app flag.

Dashboard Save:
  --save-as <name>   Save this recency query as a reusable dashboard
                     (stored as 'list --sort file.mtime --desc')
  --force            Overwrite if the dashboard already exists

Examples:
  bwrb recent
  bwrb recent --limit 5
  bwrb recent --type task
  bwrb recent --type task --limit 10
  bwrb recent --output json
  bwrb recent --output paths
  bwrb recent --path "Projects/**"
  bwrb recent --open                              # Open the most recent note
  bwrb recent --type task --open --app editor
  bwrb recent task print --open                   # Positional filter + app mode
  bwrb recent --type task --save-as "recent-tasks"`)
  .argument('[positional]', 'Smart positional: type, path (contains /), or where expression (contains =<>~)')
  .argument('[mode]', 'App mode for --open: system, editor, visual, obsidian, print')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**, Ideas/)')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('--limit <n>', `Limit output to the first n notes (default ${DEFAULT_RECENT_LIMIT})`)
  .option('--output <format>', 'Output format: text (default), paths, link, json')
  // Open options (parity with `list`)
  .option('-o, --open', 'Open the most recent note (picker if multiple)')
  .option('--app <mode>', 'How to open: system (default), editor, visual, obsidian, print')
  // Dashboard save options (parity with `list`)
  .option('--save-as <name>', 'Save this recency query as a dashboard')
  .option('--force', 'Overwrite existing dashboard when using --save-as')
  // Reject excess positional args. Only [positional] and [mode] are accepted;
  // a third+ token is almost certainly a typo, and silently swallowing it
  // (commander's default) hides the mistake.
  .allowExcessArguments(false)
  .action(async (positional: string | undefined, mode: string | undefined, options: RecentCommandOptions, cmd: Command) => {
    const outputFormat = resolveRecentOutputFormat(options.output);
    const jsonMode = outputFormat === 'json';

    // App-mode precedence: an explicit --app flag wins over the positional
    // [mode] (the convenience form, e.g. `bwrb recent --open print`).
    const appModeInput = options.app ?? mode;

    try {
      const globalOpts = getGlobalOpts(cmd);
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      // Validate the app mode eagerly (mirrors `open`): an invalid value from
      // either --app or the positional [mode] errors loudly here rather than
      // being silently ignored when --open isn't requested.
      if (appModeInput !== undefined) {
        parseAppMode(appModeInput);
      }

      // Pre-flight check: if --save-as is provided without --force, error early
      // if the dashboard already exists (mirrors `list`).
      if (options.saveAs && !options.force) {
        const existing = await getDashboard(vaultDir, options.saveAs);
        if (existing) {
          const error = `Dashboard "${options.saveAs}" already exists. Use --force to overwrite.`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

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

      // Save as dashboard if --save-as was provided. A `recent` query is just
      // `list --sort file.mtime --desc`, so persist it in that canonical form
      // (the dashboard command runs it through `listObjects`). Saving runs even
      // for an empty result set, mirroring `list`.
      if (options.saveAs) {
        const definition: DashboardDefinition = {
          sort: 'file.mtime',
          desc: true,
        };
        if (targeting.type) definition.type = targeting.type;
        if (targeting.path) definition.path = targeting.path;
        if (targeting.where?.length) definition.where = targeting.where;
        if (targeting.body) definition.body = targeting.body;
        if (outputFormat !== 'default') definition.output = outputFormat;
        // `recent` always limits (default 20), so persist the effective limit.
        definition.limit = limit;

        try {
          if (options.force) {
            const existing = await getDashboard(vaultDir, options.saveAs);
            if (existing) {
              await updateDashboard(vaultDir, options.saveAs, definition);
              console.error(`Dashboard "${options.saveAs}" updated.`);
            } else {
              await createDashboard(vaultDir, options.saveAs, definition);
              console.error(`Dashboard "${options.saveAs}" saved.`);
            }
          } else {
            await createDashboard(vaultDir, options.saveAs, definition);
            console.error(`Dashboard "${options.saveAs}" saved.`);
          }
        } catch (saveErr) {
          const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
          if (jsonMode) {
            printJson(jsonError(`Failed to save dashboard: ${saveMessage}`));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(`Failed to save dashboard: ${saveMessage}`);
          process.exit(1);
        }
      }

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

      // Handle --open: open the most recent note, or pick from the limited set
      // when there are several and we're attached to a TTY (mirrors `list`).
      if (options.open) {
        let targetPath: string;

        if (limited.length === 1) {
          targetPath = limited[0]!.path;
        } else if (process.stdin.isTTY && process.stdout.isTTY) {
          const pickerFiles = limited.map(f => ({
            path: f.path,
            relativePath: relative(vaultDir, f.path),
          }));
          const pickerResult = await pickFile(pickerFiles, {
            mode: parsePickerMode(resolveGlobalPickerMode(undefined, globalOpts, 'auto')),
            prompt: `${limited.length} notes - select to open`,
          });

          if (pickerResult.cancelled || !pickerResult.selected) {
            process.exit(0);
          }
          targetPath = pickerResult.selected.path;
        } else {
          // Non-interactive with multiple matches: open the most recent (top).
          targetPath = limited[0]!.path;
        }

        await openNote(
          vaultDir,
          targetPath,
          resolveAppMode(appModeInput, schema.config),
          schema.config,
          jsonMode
        );
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
    modified: formatFileTimestamp(mtimeMs),
  }));

  const lines = renderTable({ columns, rows, context });
  for (const line of lines) {
    console.log(line);
  }
}
