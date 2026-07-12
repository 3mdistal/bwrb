import { Command } from 'commander';
import { basename, relative } from 'path';
import chalk from 'chalk';
import {
  getType,
  loadSchema,
  getTypeDefByPath,
  getAllFieldsForType,
  formatUnknownTypeError,
  getFieldsForType,
  resolveDateCalendar,
  resolveTypeFromFrontmatter,
} from '../lib/schema.js';
import {
  buildParentMapFromFiles,
  buildChildrenMap,
  collectDescendants,
  createFileComparator,
  buildTree,
  treeHasNestedNotes,
  buildDirectoryTree,
  extractNoteName,
  isFileSortKey,
  isFileStatField,
  formatFileStatDisplay,
  fileStatJsonValue,
  type TreeNode,
  type DirectoryTreeNode,
  type FileStatMap,
} from '../lib/list-helpers.js';
import { readFile, stat } from 'fs/promises';
import { parseNote } from '../lib/frontmatter.js';
import { noteRevision } from '../lib/note-revision.js';

import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts, resolveGlobalPickerMode } from '../lib/command.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
  exitWithResolutionError,
  warnDeprecated,
  type ListOutputFormat,
} from '../lib/output.js';
import { UserCancelledError } from '../lib/errors.js';
import { openNote, resolveAppMode, parseAppMode } from './open.js';
import { runSearchCommand, type SearchOptions } from './search.js';
import { pickFile, parsePickerMode } from '../lib/picker.js';
import { formatDisplayValue } from '../lib/value-format.js';
import type { LoadedSchema, DashboardDefinition } from '../types/schema.js';
import {
  resolveTargets,
  parsePositionalArg,
  hasAnyTargeting,
  formatTargetingSummary,
  type TargetingOptions,
} from '../lib/targeting.js';
import { createDashboard, updateDashboard, getDashboard } from '../lib/dashboard.js';
import { suggestFieldName } from '../lib/validation.js';
import { getTtyContext } from '../lib/tty/context.js';
import { renderTable } from '../lib/tty/table.js';
import { buildVaultNoteIndex } from '../lib/discovery.js';
import {
  buildRelativeDateFieldMap,
  type RelativeDateFieldMap,
} from '../lib/relative-date.js';
import {
  calendarDateJsonValue,
  calendarDateValue,
  isCalendarDateValue,
  parseCalendarDate,
} from '../lib/calendar-date.js';
import { resolveExactNoteTarget } from '../lib/exact-note-target.js';
import {
  buildLineageMaps,
  collectLineage,
  type CollectedLineage,
  type LineageNode,
} from '../lib/lineage.js';
import { isValidNoteId, normalizeNoteId } from '../lib/note-id.js';

/**
 * Resolve the output format from --output flag and deprecated flags.
 * Emits deprecation warnings for old flags.
 */
function resolveListOutputFormat(options: ListCommandOptions): ListOutputFormat {
  // Check deprecated flags first (they take precedence for backwards compat)
  if (options.json) {
    warnDeprecated('--json', '--output json');
    return 'json';
  }
  if (options.paths) {
    warnDeprecated('--paths', '--output paths');
    return 'paths';
  }
  if (options.tree) {
    warnDeprecated('--tree', '--output tree');
    return 'tree';
  }

  // Check --output flag
  if (options.output) {
    // 'text' is an alias for 'default'
    if (options.output === 'text') {
      return 'default';
    }
    const validFormats: ListOutputFormat[] = ['default', 'paths', 'tree', 'link', 'content', 'json'];
    if (validFormats.includes(options.output as ListOutputFormat)) {
      return options.output as ListOutputFormat;
    }
    // Invalid format - will be caught by validation or default to 'default'
  }

  return 'default';
}

function parseListLimit(value: string | undefined, jsonMode: boolean): number | undefined {
  if (value === undefined) return undefined;

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

interface ListCommandOptions {
  type?: string;
  path?: string;
  body?: string;
  name?: string;
  fuzzy?: string;
  matches?: boolean;
  threshold?: string;
  context?: string | boolean;
  caseSensitive?: boolean;
  regex?: boolean;
  text?: string; // deprecated
  paths?: boolean; // deprecated
  fields?: string;
  where?: string[];
  id?: string;
  lineage?: string;
  limit?: string;
  count?: boolean;
  sort?: string;
  desc?: boolean;
  output?: string;
  json?: boolean; // deprecated
  // Open options
  open?: boolean;
  app?: string;
  picker?: string;
  preview?: boolean;
  // Hierarchy options for recursive types
  roots?: boolean;
  childrenOf?: string;
  descendantsOf?: string;
  tree?: boolean; // deprecated (use --output tree)
  depth?: string;
  // Dashboard save options
  saveAs?: string;
  force?: boolean;
}

function validateLineageMode(
  positional: string | undefined,
  mode: string | undefined,
  options: ListCommandOptions
): string | undefined {
  if (options.lineage === undefined) return undefined;

  const conflicts: string[] = [];
  if (positional !== undefined) conflicts.push('[positional]');
  if (mode !== undefined) conflicts.push('[mode]');
  if (options.type !== undefined) conflicts.push('--type');
  if (options.path !== undefined) conflicts.push('--path');
  if (options.where !== undefined) conflicts.push('--where');
  if (options.body !== undefined) conflicts.push('--body');
  if (options.text !== undefined) conflicts.push('--text');
  if (options.name !== undefined) conflicts.push('--name');
  if (options.fuzzy !== undefined) conflicts.push('--fuzzy');
  if (options.matches === true) conflicts.push('--matches');
  if (options.threshold !== undefined) conflicts.push('--threshold');
  if (options.context !== undefined) conflicts.push(options.context === false ? '--no-context' : '--context');
  if (options.caseSensitive === true) conflicts.push('--case-sensitive');
  if (options.regex === true) conflicts.push('--regex');
  if (options.id !== undefined) conflicts.push('--id');
  if (options.fields !== undefined) conflicts.push('--fields');
  if (options.sort !== undefined) conflicts.push('--sort');
  if (options.desc === true) conflicts.push('--desc');
  if (options.limit !== undefined) conflicts.push('--limit');
  if (options.count === true) conflicts.push('--count');
  if (options.roots === true) conflicts.push('--roots');
  if (options.childrenOf !== undefined) conflicts.push('--children-of');
  if (options.descendantsOf !== undefined) conflicts.push('--descendants-of');
  if (options.tree === true) conflicts.push('--tree');
  if (options.depth !== undefined) conflicts.push('--depth');
  if (options.open === true) conflicts.push('--open');
  if (options.app !== undefined) conflicts.push('--app');
  if (options.picker !== undefined) conflicts.push('--picker');
  if (options.preview === true) conflicts.push('--preview');
  if (options.saveAs !== undefined) conflicts.push('--save-as');
  if (options.force === true) conflicts.push('--force');
  if (options.json === true) conflicts.push('--json');
  if (options.paths === true) conflicts.push('--paths');

  if (conflicts.length > 0) {
    return `--lineage cannot be combined with ${conflicts.join(', ')}.`;
  }

  const allowedOutputs = new Set(['default', 'tree', 'paths', 'link', 'content', 'json']);
  if (options.output !== undefined && !allowedOutputs.has(options.output)) {
    return '--lineage supports only --output default, tree, paths, link, content, or json.';
  }
  return undefined;
}

function hasCanonicalSearchMode(options: ListCommandOptions): boolean {
  return options.name !== undefined || options.fuzzy !== undefined || options.matches === true;
}

function validateCanonicalSearchMode(
  positional: string | undefined,
  mode: string | undefined,
  options: ListCommandOptions
): string | undefined {
  const selectedModes = [
    options.name !== undefined ? '--name' : undefined,
    options.fuzzy !== undefined ? '--fuzzy' : undefined,
    options.matches ? '--matches' : undefined,
  ].filter((value): value is string => value !== undefined);

  if (selectedModes.length > 1) {
    return `Cannot combine ${selectedModes.join(', ')}. Choose one search mode.`;
  }
  if ((options.name !== undefined || options.fuzzy !== undefined) && (options.body !== undefined || options.text !== undefined)) {
    return '--name and --fuzzy cannot be combined with --body or --text.';
  }
  if (options.matches && !options.body) {
    return '--matches requires --body <query>';
  }
  if ((options.context !== undefined || options.caseSensitive || options.regex) && !options.matches) {
    return '--context, --no-context, --case-sensitive, and --regex require --matches';
  }
  if (options.threshold !== undefined && options.fuzzy === undefined) {
    return '--threshold requires --fuzzy <query>';
  }
  if (hasCanonicalSearchMode(options) && (positional !== undefined || mode !== undefined)) {
    return 'Search modes do not accept positional filters or app modes; use targeting flags and --app instead.';
  }
  if (hasCanonicalSearchMode(options) && (options.fields || options.count || options.sort || options.desc || options.roots || options.childrenOf || options.descendantsOf || options.tree || options.depth || options.saveAs || options.force)) {
    return '--name, --fuzzy, and --matches cannot be combined with table, hierarchy, sort, count, or dashboard options.';
  }
  if (hasCanonicalSearchMode(options) && options.id) {
    return '--id cannot be combined with --name, --fuzzy, or --matches; use --id with normal list targeting.';
  }
  if (hasCanonicalSearchMode(options) && options.output === 'tree') {
    return '--output tree is not available with --name, --fuzzy, or --matches.';
  }
  return undefined;
}

async function runCanonicalSearchMode(
  options: ListCommandOptions,
  cmd: Command
): Promise<void> {
  if (options.json) warnDeprecated('--json', '--output json');
  if (options.paths) warnDeprecated('--paths', '--output paths');
  const query = options.name ?? options.fuzzy ?? options.body;
  const searchOptions: SearchOptions = {
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.where !== undefined ? { where: options.where } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.open !== undefined ? { open: options.open } : {}),
    ...(options.app !== undefined ? { app: options.app } : {}),
    ...(options.picker !== undefined ? { picker: options.picker } : {}),
    ...(options.preview !== undefined ? { preview: options.preview } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(typeof options.context === 'string' ? { context: options.context } : {}),
    ...(options.context === false ? { noContext: true } : {}),
    ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
    ...(options.regex !== undefined ? { regex: options.regex } : {}),
    output: options.json ? 'json' : options.paths ? 'paths' : (options.output ?? 'text'),
    fuzzy: options.fuzzy !== undefined,
    body: options.matches === true,
  };
  await runSearchCommand(query, undefined, searchOptions, cmd);
}

async function runLineageMode(options: ListCommandOptions, cmd: Command): Promise<void> {
  const output = options.output ?? 'tree';
  const jsonMode = output === 'json';

  try {
    const globalOpts = getGlobalOpts(cmd);
    const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
    if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
    const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
    const schema = await loadSchema(vaultDir);
    const resolved = await resolveExactNoteTarget(
      schema,
      vaultDir,
      options.lineage!,
      { purpose: 'lineage' }
    );
    if (!isValidNoteId(resolved.frontmatter.id)) {
      throw new Error(`Lineage target ${resolved.file.relativePath} must have a valid UUID id.`);
    }

    const targetEntry = resolved.snapshot.notes.find(note => note.path === resolved.file.path);
    if (!targetEntry) {
      throw new Error(`Lineage target disappeared during discovery: ${resolved.file.relativePath}`);
    }
    const graph = collectLineage(targetEntry, buildLineageMaps(resolved.snapshot));

    if (jsonMode) {
      console.log(JSON.stringify({
        target: graph.target,
        nodes: graph.nodes.map(node => ({
          path: node.path,
          id: node.id,
          forked_from: node.forkedFrom,
          depth: node.depth,
          relationship: node.relationship,
        })),
        warnings: graph.warnings,
      }, null, 2));
      return;
    }

    for (const warning of graph.warnings) {
      console.error(`Warning [${warning.code}]: ${warning.message}`);
    }

    switch (output) {
      case 'default':
      case 'tree':
        printLineageTree(graph);
        return;
      case 'paths':
        for (const node of graph.nodes) console.log(node.path);
        return;
      case 'link':
        for (const node of graph.nodes) console.log(`[[${basename(node.path, '.md')}]]`);
        return;
      case 'content':
        for (const node of graph.nodes) {
          process.stdout.write(await readFile(node.absolutePath, 'utf-8'));
        }
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode) {
      printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR }));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(message);
    process.exit(ExitCodes.VALIDATION_ERROR);
  }
}

function printLineageTree(graph: CollectedLineage): void {
  const byId = new Map<string, LineageNode>();
  for (const node of graph.nodes) {
    if (node.id) byId.set(normalizeNoteId(node.id), node);
  }

  const childrenByPath = new Map<string, LineageNode[]>();
  const attachedPaths = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.forkedFrom) continue;
    const parent = byId.get(normalizeNoteId(node.forkedFrom));
    if (!parent || parent.path === node.path) continue;
    const children = childrenByPath.get(parent.path) ?? [];
    children.push(node);
    childrenByPath.set(parent.path, children);
    attachedPaths.add(node.path);
  }
  for (const children of childrenByPath.values()) {
    children.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }

  let roots = graph.nodes.filter(node => !attachedPaths.has(node.path));
  if (roots.length === 0) {
    roots = [graph.nodes.reduce((earliest, node) =>
      node.depth < earliest.depth ||
      (node.depth === earliest.depth && node.path.localeCompare(earliest.path, 'en') < 0)
        ? node
        : earliest
    )];
  }
  roots.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const printed = new Set<string>();
  type PrintFrame = {
    node: LineageNode;
    prefix: string;
    connector: string;
    childPrefix: string;
  };
  const printFrom = (initial: PrintFrame): void => {
    const stack: PrintFrame[] = [initial];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (printed.has(frame.node.path)) continue;
      printed.add(frame.node.path);
      console.log(
        `${frame.prefix}${frame.connector}${frame.node.path}${frame.node.relationship === 'target' ? ' (target)' : ''}`
      );
      const children = childrenByPath.get(frame.node.path) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        const last = index === children.length - 1;
        stack.push({
          node: children[index]!,
          prefix: `${frame.prefix}${frame.childPrefix}`,
          connector: last ? '└── ' : '├── ',
          childPrefix: last ? '    ' : '│   ',
        });
      }
    }
  };

  for (let index = 0; index < roots.length; index++) {
    printFrom({
      node: roots[index]!,
      prefix: '',
      connector: index === 0 ? '' : '└── ',
      childPrefix: '',
    });
  }

  // Defensive fallback for malformed cyclic input whose structural edge set
  // leaves a disconnected note after the chosen cycle break.
  for (const node of graph.nodes) {
    if (!printed.has(node.path)) {
      printFrom({ node, prefix: '', connector: '', childPrefix: '' });
    }
  }
}

const RESERVED_DISPLAY_FIELDS = new Set(['name', '_name', '_path']);

/**
 * Stat the given file paths and build a {@link FileStatMap} for the `file.*`
 * sort keys. Files that can't be stat'd are simply omitted (the comparator
 * treats a missing stat as a missing sort value, sorting them last) rather than
 * failing the whole command.
 */
async function collectFileStats(paths: string[]): Promise<FileStatMap> {
  const map: FileStatMap = new Map();
  await Promise.all(
    paths.map(async path => {
      try {
        const stats = await stat(path);
        map.set(path, {
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.birthtimeMs,
          size: stats.size,
        });
      } catch {
        // Skip unreadable files
      }
    })
  );
  return map;
}

export const listCommand = new Command('list')
  .description('Find, filter, inspect, and open notes')
  .addHelpText('after', `
Targeting Selectors (compose via AND):
  --type <type>        Filter by type (e.g., task, objective/milestone)
  --path <glob>        Filter by file path (e.g., Projects/**, Ideas/)
  --where <expr>       Filter by frontmatter expression (can repeat)
  --id <uuid>          Filter by stable note id
  --lineage <target>   Show a document's complete fork lineage
  --body <query>       Filter by Markdown body content (uses ripgrep)
  --name <query>       Resolve notes by name, path, or alias
  --fuzzy <query>      Rank approximate name and alias matches with scores
  --sort <field>       Sort by frontmatter field, name, _name, _path,
                       or a file stat: file.mtime, file.ctime, file.size
  --desc               Sort descending (requires --sort)
  --limit <n>          Limit displayed results (never narrows --name selection)
  --count              Print only the number of matching notes

Expression Filters (--where):
  bwrb list --type task --where "status == 'in-progress'"
  bwrb list --type task --where "priority < 3 && !isEmpty(deadline)"
  bwrb list --type task --where "deadline < today() + '7d'"

Smart Positional Detection:
  bwrb list task                    # Detected as --type task
  bwrb list Projects/**             # Detected as --path Projects/**
  bwrb list "status=active"         # Detected as --where "status=active"

Examples:
  bwrb list --type idea
  bwrb list --type task --where "status == 'done'"
  bwrb list --path "Projects/**" --body "TODO"
  bwrb list --name "My Note" --output link
  bwrb list --fuzzy "Stephen Yeg" --output json
  bwrb list --body "TODO" --matches --regex --context 0
  bwrb list --lineage "Briefs/Launch Brief" --output tree
  bwrb list --type task --sort deadline
  bwrb list --type task --sort priority --desc
  bwrb list --sort file.mtime --desc              # Most recently modified first
  bwrb list --type task --limit 5
  bwrb list --type task --count
  bwrb list --type task --output json
  bwrb list --type task --open                    # Pick from tasks and open
  bwrb list --type task --where "status=inbox" --open
  bwrb list task print --open                      # Positional filter + app mode

Open Options:
  --open               Open a note from the results (picker if multiple)
  --app <mode>         How to open: system (default), editor, visual, obsidian, print

App Modes:
  system      Open with OS default handler (default)
  editor      Open in terminal editor ($EDITOR or config.editor)
  visual      Open in GUI editor ($VISUAL or config.visual)
  obsidian    Open in Obsidian via URI scheme
  print       Print the resolved path (for scripting)

App-Mode Precedence (for --open):
  --app flag > [mode] positional > BWRB_DEFAULT_APP env > config.open_with > system

  Note: [mode] is the second positional, after the smart [positional] filter.
  A single positional is always the filter (type/path/where), never the mode —
  so use 'bwrb list task print --open', not 'bwrb list print --open' (which
  would treat 'print' as a type filter). To set the app mode without a filter
  positional, use the --app flag.

Dashboard Save:
  --save-as <name>   Save the query as a reusable dashboard
  --force            Overwrite if dashboard already exists

  bwrb list --type task --where "status='active'" --save-as "active-tasks"
  bwrb list --type task --output tree --save-as "task-tree" --force

Note: In zsh, use single quotes for expressions with '!' to avoid history expansion:
  bwrb list --type task --where '!isEmpty(deadline)'`)
  .argument('[positional]', 'Smart positional: type, path (contains /), or where expression (contains =<>~)')
  .argument('[mode]', 'App mode for --open: system, editor, visual, obsidian, print')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**, Ideas/)')
  .option('-b, --body <query>', 'Filter by Markdown body content')
  .option('--name <query>', 'Resolve notes by name, path, or alias')
  .option('--fuzzy <query>', 'Rank approximate name and alias matches with scores')
  .option('--matches', 'Show detailed body matches instead of filtering note rows')
  .option('--threshold <score>', 'Minimum similarity from 0 to 1 for --fuzzy (default: 0.5)')
  .option('-C, --context <lines>', 'Lines of context around detailed body matches (default: 2)')
  .option('--no-context', 'Do not show context around detailed body matches')
  .option('-S, --case-sensitive', 'Use case-sensitive matching with --matches')
  .option('-E, --regex', 'Treat the --body query as a regex with --matches')
  .option('--text <query>', 'Filter by body content search (deprecated: use --body)', undefined)
  .option('--paths', 'Output file paths (deprecated: use --output paths)')
  .option('--json', 'Output as JSON (deprecated: use --output json)')
  .option('--fields <fields>', 'Show frontmatter fields in a table (comma-separated)')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('--id <uuid>', 'Filter by stable note id')
  .option('--lineage <target>', 'Show the complete fork lineage for an exact note target')
  .option('--sort <field>', 'Sort by frontmatter field, name, _name, _path, or file stat (file.mtime, file.ctime, file.size)')
  .option('--desc', 'Sort descending (requires --sort)')
  .option('--limit <n>', 'Limit displayed results (never narrows --name selection)')
  .option('--count', 'Print only the number of matching notes')
  .option('--output <format>', 'Output format: text (default), paths, tree, link, content, json')
  // Open options
  .option('-o, --open', 'Open the first result (or pick from results interactively)')
  .option('--app <mode>', 'How to open: system (default), editor, visual, obsidian, print')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('--preview', 'Show file preview in the fzf picker')
  // Hierarchy options for recursive types (deprecated in favor of --where functions)
  .option('--roots', 'Only show root notes (deprecated: use --where "isRoot()")')
  .option('--children-of <note>', 'Only show direct children (deprecated: use --where "isChildOf(\'[[Note]]\')")')
  .option('--descendants-of <note>', 'Only show descendants (deprecated: use --where "isDescendantOf(\'[[Note]]\')")')
  .option('--tree', 'Display as tree (deprecated: use --output tree)')
  .option('-L, --depth <n>', 'Limit tree/descendants depth')
  // Dashboard save options
  .option('--save-as <name>', 'Save this query as a dashboard')
  .option('--force', 'Overwrite existing dashboard when using --save-as')
  // Let the handler reject excess args so --lineage --output json can preserve
  // its machine-readable error contract. Ordinary list still emits the same
  // Commander-style text error below.
  .allowExcessArguments(true)
  .action(async (positional: string | undefined, mode: string | undefined, options: ListCommandOptions, cmd: Command) => {
    if (cmd.args.length > 2) {
      const excessError = `too many arguments. Expected 2 arguments but got ${cmd.args.length}.`;
      if (options.lineage !== undefined && (options.json || options.output === 'json')) {
        printJson(jsonError(excessError, { code: ExitCodes.VALIDATION_ERROR }));
      } else {
        console.error(`error: ${excessError}`);
      }
      process.exit(ExitCodes.VALIDATION_ERROR);
    }

    const lineageModeError = validateLineageMode(positional, mode, options);
    if (lineageModeError) {
      const requestedJson = options.json || options.output === 'json';
      if (requestedJson) {
        printJson(jsonError(lineageModeError, { code: ExitCodes.VALIDATION_ERROR }));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(lineageModeError);
      process.exit(ExitCodes.VALIDATION_ERROR);
    }

    if (options.lineage !== undefined) {
      await runLineageMode(options, cmd);
      return;
    }

    const searchModeError = validateCanonicalSearchMode(positional, mode, options);
    if (searchModeError) {
      const requestedJson = options.json || options.output === 'json';
      if (requestedJson) {
        printJson(jsonError(searchModeError));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(searchModeError);
      process.exit(1);
    }

    if (hasCanonicalSearchMode(options)) {
      await runCanonicalSearchMode(options, cmd);
      return;
    }

    // Resolve output format from --output flag and deprecated flags
    const outputFormat = resolveListOutputFormat(options);
    const jsonMode = outputFormat === 'json';

    // App-mode precedence: an explicit --app flag wins over the positional
    // [mode] (the convenience form). The positional is the SECOND positional;
    // a single positional is always the smart filter, never the mode.
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

      // Pre-flight check: if --save-as is provided without --force, check if dashboard exists
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
      if (options.id) targeting.id = options.id;
      // Handle --body (new) and --text (deprecated)
      if (options.text) {
        console.error('Warning: --text is deprecated, use --body instead');
      }
      const bodyQuery = options.body ?? options.text;
      if (bodyQuery) targeting.body = bodyQuery;

      // Handle smart positional detection
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
        
        // Merge parsed options
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
        // Normalize slash-notation to canonical type name
        targeting.type = typeDef.name;
      }

      // Resolve targets using shared targeting module
      const targetResult = await resolveTargets(targeting, schema, vaultDir);
      
      if (targetResult.error) {
        exitWithResolutionError(targetResult.error, targetResult.files, jsonMode);
      }

      // Show targeting summary if no results
      if (targetResult.files.length === 0 && !jsonMode && hasAnyTargeting(targeting)) {
        console.log(`No notes found matching: ${formatTargetingSummary(targeting)}`);
      }

      const fields = options.fields?.split(',').map(f => f.trim());
      const depth = options.depth ? parseInt(options.depth, 10) : undefined;
      const limit = parseListLimit(options.limit, jsonMode);

      if (options.desc && !options.sort) {
        const error = 'Cannot use --desc without --sort';
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Validate display/sort fields when --type is specified (strict mode)
      if (targeting.type && ((fields && fields.length > 0) || options.sort)) {
        const allFieldNames = getAllFieldsForType(schema, targeting.type);
        const fieldNamesToValidate = [
          ...(fields ?? []),
          ...(options.sort ? [options.sort] : []),
        ];

        for (const field of fieldNamesToValidate) {
          // `file.*` stat keys are valid sort keys but not frontmatter/display
          // fields, so they bypass the per-type field validation.
          if (isFileSortKey(field)) continue;
          if (!allFieldNames.has(field) && !RESERVED_DISPLAY_FIELDS.has(field)) {
            const fieldList = Array.from(allFieldNames);
            const suggestion = suggestFieldName(field, fieldList);
            let msg = `Unknown field '${field}' for type '${targeting.type}'`;
            if (suggestion) msg += `. Did you mean '${suggestion}'?`;
            if (jsonMode) {
              printJson(jsonError(msg));
              process.exit(ExitCodes.VALIDATION_ERROR);
            }
            printError(msg);
            process.exit(1);
          }
        }
      }

      // Emit deprecation warnings for hierarchy flags (unless in JSON mode)
      if (!jsonMode) {
        if (options.roots) {
          warnDeprecated('--roots', '--where "isRoot()"');
        }
        if (options.childrenOf) {
          warnDeprecated('--children-of', `--where "isChildOf('[[${extractNoteName(options.childrenOf) ?? options.childrenOf}]]')"`);
        }
        if (options.descendantsOf) {
          warnDeprecated('--descendants-of', `--where "isDescendantOf('[[${extractNoteName(options.descendantsOf) ?? options.descendantsOf}]]')"`);
        }
      }
      
      await listObjects(schema, vaultDir, targeting.type, targetResult.files, {
        outputFormat,
        ...(fields !== undefined && { fields }),
        // Open options
        open: options.open,
        app: appModeInput,
        pickerMode: resolveGlobalPickerMode(options.picker, globalOpts, 'auto'),
        preview: options.preview,
        // Hierarchy options
        roots: options.roots,
        childrenOf: options.childrenOf,
        descendantsOf: options.descendantsOf,
        depth,
        count: options.count,
        sortField: options.sort,
        sortDesc: options.desc,
        ...(limit !== undefined && { limit }),
      });

      // Save as dashboard if --save-as was provided
      // Note: pre-flight check already errored if dashboard exists without --force
      if (options.saveAs) {
        // Build DashboardDefinition from query options
        const definition: DashboardDefinition = {};
        if (targeting.type) definition.type = targeting.type;
        if (targeting.path) definition.path = targeting.path;
        if (targeting.where?.length) definition.where = targeting.where;
        if (targeting.body) definition.body = targeting.body;
        if (outputFormat !== 'default') definition.output = outputFormat;
        if (fields?.length) definition.fields = fields;
        if (limit !== undefined) definition.limit = limit;
        if (options.count) definition.count = true;
        if (options.sort) definition.sort = options.sort;
        if (options.desc) definition.desc = true;

        try {
          if (options.force) {
            // --force: update if exists, create if not
            const existing = await getDashboard(vaultDir, options.saveAs);
            if (existing) {
              await updateDashboard(vaultDir, options.saveAs, definition);
              console.error(`Dashboard "${options.saveAs}" updated.`);
            } else {
              await createDashboard(vaultDir, options.saveAs, definition);
              console.error(`Dashboard "${options.saveAs}" saved.`);
            }
          } else {
            // No --force: pre-flight already confirmed it doesn't exist
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

export interface ListOptions {
  outputFormat: ListOutputFormat;
  fields?: string[] | undefined;
  limit?: number | undefined;
  count?: boolean | undefined;
  sortField?: string | undefined;
  sortDesc?: boolean | undefined;
  // Open options
  open?: boolean | undefined;
  app?: string | undefined;
  pickerMode?: string | undefined;
  preview?: boolean | undefined;
  // Hierarchy options
  roots?: boolean | undefined;
  childrenOf?: string | undefined;
  descendantsOf?: string | undefined;
  depth?: number | undefined;
}

/**
 * List objects with pre-resolved files from targeting.
 * Exported for use by dashboard command.
 */
export async function listObjects(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string | undefined,
  files: Array<{ path: string; relativePath: string; frontmatter: Record<string, unknown> }>,
  options: ListOptions
): Promise<void> {
  // Convert to the format expected by the rest of the function
  let filteredFiles = files.map(f => ({
    path: f.path,
    frontmatter: f.frontmatter,
  }));

  const jsonMode = options.outputFormat === 'json';

  // Check if type is recursive for hierarchy options
  const typeDef = typePath ? getType(schema, typePath) : undefined;
  const isRecursive = typeDef?.recursive ?? false;

  // Apply hierarchy filters for recursive types
  if (isRecursive) {
    // Build parent map for hierarchy queries
    const parentMap = buildParentMapFromFiles(filteredFiles);
    const childrenMap = buildChildrenMap(parentMap);

    if (options.roots) {
      // Only show notes with no parent
      filteredFiles = filteredFiles.filter(f => {
        const name = basename(f.path, '.md');
        return !parentMap.has(name);
      });
    }

    if (options.childrenOf) {
      // Only show direct children of the specified note
      const targetName = extractNoteName(options.childrenOf);
      if (targetName) {
        const children = childrenMap.get(targetName) ?? new Set();
        filteredFiles = filteredFiles.filter(f => {
          const name = basename(f.path, '.md');
          return children.has(name);
        });
      }
    }

    if (options.descendantsOf) {
      // Show all descendants of the specified note
      const targetName = extractNoteName(options.descendantsOf);
      if (targetName) {
        const descendants = collectDescendants(targetName, childrenMap, options.depth);
        filteredFiles = filteredFiles.filter(f => {
          const name = basename(f.path, '.md');
          return descendants.has(name);
        });
      }
    }
  }

  // Stat the files first when a `file.*` stat key is needed — either for
  // SORTING (`--sort file.mtime`) or for DISPLAY (`--fields file.size`). The
  // same {@link FileStatMap} is threaded into the comparator (which stays
  // pure/synchronous) and into the table/JSON renderers so `file.*` columns
  // render real values instead of an empty column (#689).
  const needsFileStats =
    (options.sortField !== undefined && isFileSortKey(options.sortField)) ||
    (options.fields?.some(isFileStatField) ?? false);
  const fileStats = needsFileStats
    ? await collectFileStats(filteredFiles.map(f => f.path))
    : undefined;

  const relativeDateFields = await resolveRelativeDateFieldsForList(schema, vaultDir);
  const fileComparator = createFileComparator(
    vaultDir,
    options.sortField,
    options.sortDesc,
    fileStats
  );
  const sortFrontmatterFiles = options.sortField
    ? new Map(filteredFiles.map(file => [
        file.path,
        {
          ...file,
          frontmatter: frontmatterForCalendarDateSort(
            schema,
            file,
            options.sortField!,
            frontmatterForRelativeDateSort(file, options.sortField!, relativeDateFields)
          ),
        },
      ]))
    : undefined;
  warnOnCrossCalendarSort(options.sortField, sortFrontmatterFiles);
  filteredFiles.sort((a, b) => fileComparator(
    sortFrontmatterFiles?.get(a.path) ?? a,
    sortFrontmatterFiles?.get(b.path) ?? b
  ));

  const matchCount = filteredFiles.length;

  if (options.count) {
    if (jsonMode) {
      console.log(JSON.stringify({ count: matchCount }, null, 2));
    } else {
      console.log(String(matchCount));
    }
    return;
  }

  if (options.limit !== undefined) {
    filteredFiles = filteredFiles.slice(0, options.limit);
  }

  // Handle no results
  if (filteredFiles.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify([], null, 2));
    }
    return;
  }

  // Handle --open flag
  if (options.open) {
    let targetPath: string;
    
    if (filteredFiles.length === 1) {
      // Single result - open directly
      targetPath = filteredFiles[0]!.path;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      // Multiple results - use picker
      const pickerFiles = filteredFiles.map(f => ({
        path: f.path,
        relativePath: relative(vaultDir, f.path),
      }));
      const pickerResult = await pickFile(pickerFiles, {
        mode: parsePickerMode(options.pickerMode),
        prompt: `${filteredFiles.length} notes - select to open`,
        ...(options.preview !== undefined ? { preview: options.preview } : {}),
        vaultDir,
      });

      if (pickerResult.error) {
        exitWithResolutionError(
          pickerResult.error,
          pickerResult.candidates,
          jsonMode
        );
      }
      
      if (pickerResult.cancelled || !pickerResult.selected) {
        process.exit(0);
      }
      targetPath = pickerResult.selected.path;
    } else {
      exitWithResolutionError(
        `Ambiguous query: ${filteredFiles.length} matches found`,
        filteredFiles.map(f => ({ relativePath: relative(vaultDir, f.path) })),
        jsonMode
      );
    }
    
    await openNote(vaultDir, targetPath, resolveAppMode(options.app, schema.config), schema.config, jsonMode);
    return;
  }

  // Output based on format
  const showPaths = options.outputFormat === 'paths';

  switch (options.outputFormat) {
    case 'json': {
      const jsonOutput = await Promise.all(filteredFiles.map(async ({ path }) => {
        // The row and revision must describe one observation, not adjacent
        // reads of a note that an editor could change between them.
        const snapshot = await parseNote(path);
        const frontmatter = snapshot.frontmatter;
        const notePath = relative(vaultDir, path);
        const noteName = basename(path, '.md');
        const base = {
          _path: notePath,
          _name: noteName,
          revision: noteRevision(snapshot.raw),
        };

        if (!options.fields || options.fields.length === 0) {
          return {
            ...base,
            ...frontmatterWithCalendarDateJson(
              schema,
              frontmatterWithRelativeDates(path, frontmatter, relativeDateFields)
            ),
          };
        }

        const selected: Record<string, unknown> = { ...base };
        for (const field of options.fields) {
          if (field === '_path') continue;
          if (field === '_name' || field === 'name') {
            selected[field] = noteName;
            continue;
          }
          if (isFileStatField(field)) {
            // `file.*` stat fields render from the stat map collected above
            // (times as ISO-8601, size as a number). Mirrors the text table so
            // JSON consumers see the same data the table shows (#689).
            const value = fileStatJsonValue(field, fileStats?.get(path));
            if (value !== undefined) selected[field] = value;
            continue;
          }
          const relativeValue = relativeDateFields.get(path)?.get(field);
          if (relativeValue !== undefined) {
            selected[field] = relativeValue;
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(frontmatter, field)) {
            selected[field] = calendarDateJsonFieldValue(schema, frontmatter, field) ?? frontmatter[field];
          }
        }

        return selected;
      }));
      console.log(JSON.stringify(jsonOutput, null, 2));
      return;
    }

    case 'tree': {
      // Render a parent-based hierarchy tree whenever the result set actually
      // has `parent` links — regardless of whether the type is `recursive`.
      // This lets any entity type with a parent hierarchy (e.g. a context /
      // domain type per #554) render its nesting via `--output tree` (#637).
      // The directory tree remains the fallback when there are no parent links.
      const parentMap = buildParentMapFromFiles(filteredFiles);
      const tree = buildTree(filteredFiles, parentMap, options.depth, fileComparator);
      if (treeHasNestedNotes(tree)) {
        printTree(tree, vaultDir, showPaths);
        return;
      }

      const directoryTree = buildDirectoryTree(filteredFiles, vaultDir, options.depth, fileComparator);
      printDirectoryTree(directoryTree, showPaths);
      return;
    }

    case 'link': {
      for (const { path } of filteredFiles) {
        const name = basename(path, '.md');
        console.log(`[[${name}]]`);
      }
      return;
    }

    case 'content': {
      for (const { path } of filteredFiles) {
        process.stdout.write(await readFile(path, 'utf-8'));
      }
      return;
    }

    case 'paths': {
      for (const { path } of filteredFiles) {
        console.log(relative(vaultDir, path));
      }
      return;
    }
  }

  // Default output (table with fields or simple names)
  if (options.fields && options.fields.length > 0) {
    printTable(filteredFiles, vaultDir, showPaths, options.fields, fileStats, relativeDateFields);
  } else {
    for (const { path } of filteredFiles) {
      console.log(basename(path, '.md'));
    }
  }
}

function frontmatterWithCalendarDateJson(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
  if (!typePath) return frontmatter;

  const fields = getFieldsForType(schema, typePath);
  let result: Record<string, unknown> | undefined;
  for (const [fieldName, field] of Object.entries(fields)) {
    const calendarId = resolveDateCalendar(schema, typePath, fieldName, field);
    if (!calendarId || !(fieldName in frontmatter)) continue;
    const parsed = parseCalendarDate(
      frontmatter[fieldName],
      calendarId,
      schema.config.calendars[calendarId]!
    );
    if (!parsed.valid) continue;
    result ??= { ...frontmatter };
    result[fieldName] = calendarDateJsonValue(
      calendarDateValue(parsed.date, schema.config.calendars[calendarId]!)
    );
  }
  return result ?? frontmatter;
}

function calendarDateJsonFieldValue(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>,
  fieldName: string
): unknown {
  const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
  if (!typePath) return undefined;
  const field = getFieldsForType(schema, typePath)[fieldName];
  if (!field) return undefined;
  const calendarId = resolveDateCalendar(schema, typePath, fieldName, field);
  if (!calendarId) return undefined;
  const parsed = parseCalendarDate(
    frontmatter[fieldName],
    calendarId,
    schema.config.calendars[calendarId]!
  );
  return parsed.valid
    ? calendarDateJsonValue(calendarDateValue(parsed.date, schema.config.calendars[calendarId]!))
    : undefined;
}

function frontmatterWithRelativeDates(
  path: string,
  frontmatter: Record<string, unknown>,
  relativeDateFields: RelativeDateFieldMap | undefined
): Record<string, unknown> {
  const relativeFields = relativeDateFields?.get(path);
  if (!relativeFields || relativeFields.size === 0) return frontmatter;
  const result = { ...frontmatter };
  for (const [field, value] of relativeFields) {
    result[field] = value;
  }
  return result;
}

/**
 * Print results as a table.
 */
function printTable(
  files: { path: string; frontmatter: Record<string, unknown> }[],
  vaultDir: string,
  showPaths: boolean,
  fields: string[],
  fileStats?: FileStatMap,
  relativeDateFields?: RelativeDateFieldMap
): void {
  const context = getTtyContext();
  const headerStyle = context.colorEnabled ? (text: string) => chalk.gray(text) : null;

  const columns = [
    {
      key: 'primary',
      title: showPaths ? 'PATH' : 'NAME',
      minWidth: 12,
      weight: 2,
      priority: 0,
      canDrop: false,
      ...(headerStyle ? { style: headerStyle } : {}),
    },
    ...fields.map((field, index) => ({
      key: field,
      title: field.toUpperCase(),
      minWidth: 8,
      weight: 1,
      priority: index + 1,
      canDrop: true,
      ...(headerStyle ? { style: headerStyle } : {}),
    })),
  ];

  const rows: Array<Record<string, string>> = [];

  for (const { path, frontmatter } of files) {
    const name = showPaths ? relative(vaultDir, path) : basename(path, '.md');
    const row: Record<string, string> = {
      primary: name,
    };

    for (const field of fields) {
      if (isFileStatField(field)) {
        // `file.*` stat columns render from the stat map collected for sorting
        // and/or fields (times as YYYY-MM-DD HH:MM, size as bytes) (#689).
        row[field] = formatFileStatDisplay(field, fileStats?.get(path)) ?? '—';
        continue;
      }
      const value = field === 'name' || field === '_name'
        ? basename(path, '.md')
        : field === '_path'
          ? relative(vaultDir, path)
          : getListJsonFieldValue(path, field, frontmatter, relativeDateFields);
      row[field] = formatDisplayValue(value, { empty: '—' });
    }

    rows.push(row);
  }

  const lines = renderTable({ columns, rows, context });
  for (const line of lines) {
    console.log(line);
  }
}

async function resolveRelativeDateFieldsForList(
  schema: LoadedSchema,
  vaultDir: string
): Promise<RelativeDateFieldMap> {
  if (!schemaHasRelativeDateFields(schema)) return new Map();

  const index = await buildVaultNoteIndex(schema, vaultDir);
  const result = buildRelativeDateFieldMap(
    schema,
    vaultDir,
    index.snapshot,
    index.noteTargetIndex
  );
  return result.fields;
}

function schemaHasRelativeDateFields(schema: LoadedSchema): boolean {
  for (const type of schema.types.values()) {
    for (const field of Object.values(type.fields)) {
      if (field.prompt === 'relative-date') return true;
    }
  }
  return false;
}

function getListJsonFieldValue(
  path: string,
  field: string,
  frontmatter: Record<string, unknown>,
  relativeDateFields: RelativeDateFieldMap | undefined
): unknown {
  return relativeDateFields?.get(path)?.get(field) ?? frontmatter[field];
}

function frontmatterForRelativeDateSort(
  file: { path: string; frontmatter: Record<string, unknown> },
  sortField: string,
  relativeDateFields: RelativeDateFieldMap
): Record<string, unknown> {
  const resolved = relativeDateFields.get(file.path)?.get(sortField);
  if (!resolved) return file.frontmatter;
  return {
    ...file.frontmatter,
    [sortField]: resolved.calendar && resolved.linear !== undefined && resolved.resolved
      ? {
          __bwrbCalendarDate: true,
          value: resolved.resolved,
          calendar: resolved.calendar,
          linear: resolved.linear,
        }
      : resolved.resolved,
  };
}

function frontmatterForCalendarDateSort(
  schema: LoadedSchema,
  file: { path: string; frontmatter: Record<string, unknown> },
  sortField: string,
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const typePath = resolveTypeFromFrontmatter(schema, file.frontmatter);
  if (!typePath) return frontmatter;
  const field = getFieldsForType(schema, typePath)[sortField];
  if (!field) return frontmatter;
  const calendarId = resolveDateCalendar(schema, typePath, sortField, field);
  if (!calendarId) return frontmatter;
  const parsed = parseCalendarDate(
    frontmatter[sortField],
    calendarId,
    schema.config.calendars[calendarId]!
  );
  if (!parsed.valid) return frontmatter;
  return {
    ...frontmatter,
    [sortField]: calendarDateValue(parsed.date, schema.config.calendars[calendarId]!),
  };
}

function warnOnCrossCalendarSort(
  sortField: string | undefined,
  files: Map<string, { frontmatter: Record<string, unknown> }> | undefined
): void {
  if (!sortField || !files) return;
  const calendars = new Set<string>();
  for (const file of files.values()) {
    const value = file.frontmatter[sortField];
    if (isCalendarDateValue(value)) calendars.add(value.calendar);
  }
  if (calendars.size > 1) {
    console.error(
      `Warning: cannot compare ${sortField} across different calendars (${Array.from(calendars).join(', ')}); cross-calendar ties use name order.`
    );
  }
}

// ============================================================================
// Tree Rendering (I/O) for Recursive Types
//
// Pure sort/comparison and tree-building helpers live in ../lib/list-helpers.ts.
// The functions below handle console output and stay in the command.
// ============================================================================

/**
 * Print tree structure to console.
 */
function printTree(
  roots: TreeNode[],
  vaultDir: string,
  showPaths: boolean
): void {
  function printNode(node: TreeNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    const display = showPaths ? relative(vaultDir, node.path) : node.name;
    console.log(prefix + connector + display);
    
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const childIsLast = i === node.children.length - 1;
      printNode(child, childPrefix, childIsLast);
    }
  }
  
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const isLast = i === roots.length - 1;
    printNode(root, '', isLast);
  }
}

function printDirectoryTree(roots: DirectoryTreeNode[], showPaths: boolean): void {
  type PrintableNode =
    | { kind: 'directory'; name: string; children: PrintableNode[] }
    | { kind: 'note'; name: string };

  const toPrintable = (directory: DirectoryTreeNode): PrintableNode => ({
    kind: 'directory',
    name: `${directory.name}/`,
    children: [
      ...directory.directories.map(toPrintable),
      ...directory.notes.map(note => ({
        kind: 'note' as const,
        name: showPaths
          ? String(note.frontmatter._relativePath ?? relative('', note.path))
          : String(note.frontmatter._displayName ?? basename(note.path, '.md')),
      })),
    ],
  });

  const rootsToPrint = roots.map(toPrintable);

  function printNode(node: PrintableNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    console.log(prefix + connector + node.name);

    if (node.kind === 'directory') {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      for (let i = 0; i < node.children.length; i++) {
        printNode(node.children[i]!, childPrefix, i === node.children.length - 1);
      }
    }
  }

  for (let i = 0; i < rootsToPrint.length; i++) {
    printNode(rootsToPrint[i]!, '', i === rootsToPrint.length - 1);
  }
}
