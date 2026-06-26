/**
 * Search command - find notes and output in various formats.
 *
 * Two modes:
 * 1. Name search (default): Resolves a query to notes by name/path
 * 2. Content search (--body): Full-text search using ripgrep
 */

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts, resolveGlobalPickerMode } from '../lib/command.js';
import { loadSchema, getTypeDefByPath, formatUnknownTypeError } from '../lib/schema.js';
import { configurePromptMode, printError, printSuccess, printWarning } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError, warnDeprecated, type SearchOutputFormat } from '../lib/output.js';
import { openNote, resolveAppMode, parseAppMode } from './open.js';
import { editNoteFromJson, editNoteInteractive } from '../lib/edit.js';
import {
  buildNoteIndex,
  generateWikilink,
  type ManagedFile,
  type NoteIndex,
} from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, pickFile, type PickerMode } from '../lib/picker.js';
import {
  searchContent,
  formatResultsText,
  formatResultsJson,
  type ContentMatch,
} from '../lib/content-search.js';
import {
  fuzzySearch,
  DEFAULT_FUZZY_LIMIT,
  DEFAULT_FUZZY_THRESHOLD,
  type FuzzyMatch,
} from '../lib/fuzzy-search.js';
import { parseNote } from '../lib/frontmatter.js';
import { applyWhereExpressions } from '../lib/where-targeting.js';
import { UserCancelledError } from '../lib/errors.js';

// ============================================================================
// Types
// ============================================================================

interface SearchOptions {
  picker?: string;
  output?: string;
  // Deprecated output flags (use --output instead)
  wikilink?: boolean;
  pathOutput?: boolean;  // old --path (output flag), now deprecated
  content?: boolean;
  // Targeting options
  path?: string;  // new --path for targeting (was --path-glob)
  pathGlob?: string;  // deprecated alias for --path
  // Open options
  open?: boolean;
  app?: string;
  preview?: boolean;
  // Edit options
  edit?: boolean;
  json?: string;  // JSON patch data for --edit mode
  // Content search options
  body?: boolean;
  /** @deprecated Use body instead */
  text?: boolean;
  type?: string;
  where?: string[];
  context?: string;
  noContext?: boolean;
  caseSensitive?: boolean;
  regex?: boolean;
  limit?: string;
  // Fuzzy search options
  fuzzy?: boolean;
  threshold?: string;
}

interface SearchResultData {
  name: string;
  wikilink: string;
  path: string;
  absolutePath: string;
  content?: string;
}

// ============================================================================
// Output Format Resolution
// ============================================================================

/**
 * Resolve the search output format from options.
 * Handles deprecated flags (--wikilink, --path-output, --content) with warnings.
 * Priority: explicit --output > deprecated flags > default
 */
function resolveSearchOutputFormat(options: SearchOptions): SearchOutputFormat {
  // Check for deprecated flags first and emit warnings
  if (options.wikilink) {
    warnDeprecated('--wikilink', '--output link');
  }
  if (options.pathOutput) {
    warnDeprecated('--path-output', '--output paths');
  }
  if (options.content) {
    warnDeprecated('--content', '--output content');
  }

  // If explicit --output is provided, use it (takes precedence)
  if (options.output) {
    // 'text' is an alias for 'default'
    if (options.output === 'text') {
      return 'default';
    }
    const format = options.output as SearchOutputFormat;
    // Validate the format
    const validFormats: SearchOutputFormat[] = ['default', 'paths', 'link', 'content', 'json'];
    if (validFormats.includes(format)) {
      return format;
    }
    // Invalid format - fall through to deprecated flag handling
  }

  // Fall back to deprecated flags (priority: content > path > wikilink > default)
  if (options.content) return 'content';
  if (options.pathOutput) return 'paths';
  if (options.wikilink) return 'link';

  return 'default';
}

// ============================================================================
// Command Definition
// ============================================================================

export const searchCommand = new Command('search')
  .description('Search for notes by name or content')
  .argument('[query]', 'Search pattern (name/path for default mode, content pattern for --body)')
  .argument('[mode]', 'App mode for --open: system, editor, visual, obsidian, print')
  // Output format (new unified flag)
  .option('--output <format>', 'Output format: text (default), paths, link, content, json')
  // Deprecated output flags (still work but emit warnings)
  .option('--wikilink', 'DEPRECATED: use --output link')
  .option('--path-output', 'DEPRECATED: use --output paths')
  .option('--content', 'DEPRECATED: use --output content')
  // Open and picker options
  .option('-o, --open', 'Open the selected note after search')
  .option('--edit', 'Edit the selected note\'s frontmatter after search')
  .option('--json <patch>', 'JSON patch data for --edit mode (non-interactive)')
  .option('--app <mode>', 'How to open: system (default), editor, visual, obsidian, print')
  .option('--preview', 'Show file preview in fzf picker (requires fzf)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  // Content search options
  .option('-b, --body', 'Full-text content search (uses ripgrep)')
  .option('--text', 'DEPRECATED: use --body')
  .option('-t, --type <type>', 'Restrict search to a type (e.g., idea, objective/task)')
  .option('-p, --path <pattern>', 'Filter by file path glob pattern, e.g. "Projects/**" (works in name, --fuzzy, and --body modes)')
  .option('--path-glob <pattern>', 'DEPRECATED: use --path')
  .option('-w, --where <expression...>', 'Filter results by frontmatter expression')
  .option('-C, --context <lines>', 'Lines of context around matches (default: 2)')
  // NOTE: Commander maps --no-context to options.context === false.
  .option('--no-context', 'Do not show context lines')
  .option('-S, --case-sensitive', 'Case-sensitive search (default: case-insensitive)')
  .option('-E, --regex', 'Treat pattern as regex (default: literal)')
  .option('-l, --limit <count>', 'Maximum files to return (default: 100)')
  // Fuzzy search options
  .option('--fuzzy', 'Fuzzy name/alias search: ranked approximate matches with scores')
  .option('--threshold <score>', 'Minimum similarity 0-1 for --fuzzy (default: 0.5)')
  .addHelpText('after', `
Name Search (default):
  Searches by note name, basename, or path.

  -p, --path <pat>     Scope resolution to a path glob (e.g. "Projects/**").
                       Applies in name, --fuzzy, and --body modes. If both
                       --path and the deprecated --path-glob are passed, --path
                       wins and --path-glob is ignored (with a warning).

  Output Formats (--output):
    name        Output just the note name (default)
    paths       Output vault-relative path with extension
    link        Output [[Name]] format for Obsidian links
    content     Output full file contents (frontmatter + body)
    json        Output as JSON

  Picker Modes:
    auto        Use fzf if available, else numbered select (default)
    fzf         Force fzf (error if unavailable)
    numbered    Force numbered select
    none        Error on ambiguity (for non-interactive use)

Fuzzy Search (--fuzzy):
  Ranked approximate matching over note names and aliases. Use this to ask
  "does an entity like X already exist?" before creating a new note.

  Options:
    --fuzzy              Enable fuzzy ranked matching
    --threshold <0-1>    Minimum similarity score (default: 0.5)
    -l, --limit <n>      Max ranked results (default: 10)

  Each result carries a similarity score (1.0 = exact). Use --output json to
  consume scores programmatically.

Content Search (--body):
  Full-text search across note contents using ripgrep.
  
  Options:
    -b, --body           Enable content search mode
    -t, --type <type>    Restrict to specific type (e.g., task, objective/task)
    -p, --path <pat>     Filter by path pattern (e.g., "Projects/**")
    -w, --where <expr>   Filter by frontmatter (e.g., "status != 'done'")
    -C, --context <n>    Show n lines of context (default: 2)
    --no-context         Don't show context lines
    -S, --case-sensitive Case-sensitive matching
    -E, --regex          Treat pattern as regex
    -l, --limit <n>      Max files to return (default: 100)

Open Options:
  --open               Open the selected note in an app
  --app <mode>         How to open: system (default), editor, visual, obsidian, print

Edit Options:
  --edit               Edit the selected note's frontmatter
  --json <patch>       JSON patch data for non-interactive edit (use with --edit)

App Modes:
  system      Open with OS default handler (default)
  editor      Open in terminal editor ($EDITOR or config.editor)
  visual      Open in GUI editor ($VISUAL or config.visual)
  obsidian    Open in Obsidian via URI scheme
  print       Print the resolved path (for scripting)

Precedence (for default app):
  1. --app flag (explicit)
  2. [mode] positional argument (e.g. bwrb search "My Note" --open print)
  3. BWRB_DEFAULT_APP environment variable
  4. config.open_with in .bwrb/schema.json
  5. Fallback: system

Examples:
  # Name search
  bwrb search "My Note"                    # Find by name
  bwrb search "My Note" --output link      # Output: [[My Note]]
  bwrb search "My Note" --open             # Find and open in Obsidian
  bwrb search "My Note" --open --app editor  # Find and open in $EDITOR
  bwrb search "My Note" --open print        # Positional mode (for --open)
  bwrb search "My Note" --edit             # Find and edit frontmatter
  bwrb search "My Note" --edit --json '{"status":"done"}'  # Non-interactive edit
  
  # Content search
  bwrb search "deploy" --body              # Search all notes for "deploy"
  bwrb search "deploy" -b -t task          # Search only in tasks
  bwrb search "TODO" -b --where "status != 'done'"  # Expression filter
  bwrb search "error.*log" -b --regex      # Regex search
  bwrb search "deploy" -b --output json    # JSON output with matches
  bwrb search "deploy" -b --open           # Search and open first match

  # Fuzzy search (ranked candidates with scores)
  bwrb search "Stephen Yeg" --fuzzy        # Ranked near-matches by name/alias
  bwrb search "Steve" --fuzzy --output json  # Scores for an agent to consume
  bwrb search "Steve" --fuzzy --threshold 0.7  # Tighter match cutoff

  # Piping
  bwrb search "bug" -t --output paths | xargs -I {} code {}`)
  .allowExcessArguments(false)
  .action(async (query: string | undefined, mode: string | undefined, options: SearchOptions, cmd: Command) => {
    // Resolve output format from deprecated flags and new --output option
    const outputFormat = resolveSearchOutputFormat(options);
    const jsonMode = outputFormat === 'json';

    // App-mode precedence: an explicit --app flag wins over the positional
    // [mode] (the convenience form). Fold the resolved value back into
    // options.app so every downstream resolveAppMode(options.app, ...) call
    // (name/content/fuzzy paths) honors the positional without further plumbing.
    if (options.app === undefined && mode !== undefined) {
      options.app = mode;
    }
    // Validate the app mode eagerly (mirrors `open`): an invalid value errors
    // loudly here rather than being silently ignored when --open isn't used.
    if (options.app !== undefined) {
      try {
        parseAppMode(options.app);
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

    // Handle deprecated --text flag
    if (options.text) {
      warnDeprecated('--text', '--body');
      options.body = true;
    }

    // Handle deprecated --path-glob flag.
    // --path-glob is a deprecated alias for --path. If both are given, --path
    // wins and --path-glob is ignored; warn so the user isn't surprised that
    // their --path-glob value silently had no effect (#705).
    if (options.pathGlob) {
      if (options.path) {
        printWarning(
          `Warning: both --path and --path-glob were provided; --path-glob is a deprecated alias for --path, so --path ("${options.path}") wins and --path-glob ("${options.pathGlob}") is ignored.`
        );
      } else {
        warnDeprecated('--path-glob', '--path');
        options.path = options.pathGlob;
      }
    }

    // Validate mutual exclusivity of --open and --edit
    if (options.open && options.edit) {
      const error = 'Cannot use --open and --edit together. Choose one action.';
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }

    // --json requires --edit
    if (options.json && !options.edit) {
      const error = '--json requires --edit flag';
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }

    try {
      const globalOpts = getGlobalOpts(cmd);
      configurePromptMode({
        forcedNonInteractive: globalOpts.nonInteractive === true,
        bypassHint: 'Use --picker none for selection-only flows, or add --json <patch> with --edit.',
      });
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadSchema(vaultDir);

      if (globalOpts.nonInteractive && options.edit && !options.json) {
        printError('bwrb search --edit requires --json <patch> when --non-interactive is set.');
        process.exit(1);
      }

      const effectiveOptions = {
        ...options,
        picker: resolveGlobalPickerMode(options.picker, globalOpts, 'auto'),
      };

      // Dispatch to appropriate search mode
      if (effectiveOptions.fuzzy) {
        await handleFuzzySearch(query, effectiveOptions, vaultDir, schema, jsonMode, outputFormat);
      } else if (effectiveOptions.body) {
        await handleContentSearch(query, effectiveOptions, vaultDir, schema, jsonMode, outputFormat);
      } else {
        await handleNameSearch(query, effectiveOptions, vaultDir, schema, jsonMode, outputFormat);
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

// ============================================================================
// Content Search Handler
// ============================================================================

async function handleContentSearch(
  query: string | undefined,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  jsonMode: boolean,
  outputFormat: SearchOutputFormat
): Promise<void> {
  // Validate query is provided for content search
  if (!query) {
    const error = 'Search pattern is required for content search (--body)';
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  // Validate type if provided
  if (options.type) {
    const typeDef = getTypeDefByPath(schema, options.type);
    if (!typeDef) {
      const error = formatUnknownTypeError(schema, options.type);
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }
  }

  // Parse options. Use the same strict integer parsing as the fuzzy path so
  // malformed values (e.g. "abc", "2.7", "1e1") are rejected with a clear error
  // instead of being silently coerced by parseInt's lenient parsing (#705).
  // Commander maps --no-context to options.context === false (see the option
  // definition). Treat that sentinel (and the legacy noContext flag) as 0 lines
  // BEFORE strict parsing, so we never try to parse the boolean as an integer.
  let contextLines = 2;
  if (options.noContext || (options.context as unknown) === false) {
    contextLines = 0;
  } else if (options.context !== undefined) {
    const parsed = parseStrictInteger(options.context);
    if (parsed === null || parsed < 0) {
      const error = `Invalid --context "${options.context}": must be a non-negative integer`;
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }
    contextLines = parsed;
  }

  let limit = 100;
  if (options.limit !== undefined) {
    const parsed = parseStrictInteger(options.limit);
    if (parsed === null || parsed < 1) {
      const error = `Invalid --limit "${options.limit}": must be a positive integer`;
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }
    limit = parsed;
  }

  // Run content search.
  //
  // The path glob is threaded into searchContent as `pathFilter` so it
  // prefilters the candidate file set BEFORE the content scan sorts and slices
  // to `limit`. This makes the limit apply to the already-path-scoped set,
  // rather than the global top-N (which previously let higher-ranked
  // out-of-path matches starve out in-path matches). Reads the canonical
  // `options.path` (the same field --path sets and the deprecated --path-glob
  // is normalized into earlier in the action handler), so both
  // `--body --path <glob>` and `--body --path-glob <glob>` filter correctly.
  // (fixes #675)
  const searchResult = await searchContent({
    pattern: query,
    vaultDir,
    schema,
    ...(options.type !== undefined ? { typePath: options.type } : {}),
    ...(options.path !== undefined ? { pathFilter: options.path } : {}),
    contextLines,
    caseSensitive: options.caseSensitive ?? false,
    regex: options.regex ?? false,
    limit,
  });

  if (!searchResult.success) {
    if (jsonMode) {
      printJson(jsonError(searchResult.error ?? 'Search failed'));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(searchResult.error ?? 'Search failed');
    process.exit(1);
  }

  // Path filtering already happened inside searchContent (via `pathFilter`),
  // before the sort/slice limit was applied — see the searchContent call above.
  let filteredResults = searchResult.results;

  // Apply frontmatter filters if specified (--where expressions)
  if (options.where && options.where.length > 0) {
    filteredResults = await filterByFrontmatter(
      filteredResults,
      options.where,
      vaultDir,
      schema,
      options.type
    );
  }

  // Handle no results
  if (filteredResults.length === 0) {
    if (jsonMode) {
      // Content search has a custom JSON shape with totalMatches/truncated
      console.log(JSON.stringify({
        success: true,
        data: [],
        totalMatches: 0,
        truncated: false,
      }, null, 2));
    } else {
      // Silent output for no matches (consistent with grep behavior)
    }
    process.exit(0);
  }

  // Check if we should use picker for interactive selection
  const pickerMode = parsePickerMode(options.picker);
  const shouldPick = !jsonMode && pickerMode !== 'none' && process.stdin.isTTY && process.stdout.isTTY;

  if (shouldPick) {
    // Interactive mode: let user pick from results
    const files = filteredResults.map(r => r.file);
    const pickerResult = await pickFile(files, {
      mode: pickerMode,
      prompt: options.open 
        ? `${filteredResults.length} files with matches - select to open`
        : `${filteredResults.length} files with matches`,
      preview: options.preview ?? false,
      vaultDir,
    });

    if (pickerResult.cancelled || !pickerResult.selected) {
      process.exit(0);
    }

    // Handle --open flag
    if (options.open) {
      const appMode = resolveAppMode(options.app, schema.config);
      await openNote(vaultDir, pickerResult.selected.path, appMode, schema.config, false);
      return;
    }

    // Handle --edit flag
    if (options.edit) {
      if (options.json) {
        // Non-interactive JSON edit mode
        await editNoteFromJson(schema, vaultDir, pickerResult.selected.path, options.json, { jsonMode: false });
        printSuccess(`Updated: ${pickerResult.selected.relativePath}`);
      } else {
        // Interactive edit mode
        await editNoteInteractive(schema, vaultDir, pickerResult.selected.path);
      }
      return;
    }

    // Output the selected file based on format
    const index = await buildNoteIndex(schema, vaultDir);
    await outputTextResult(index, pickerResult.selected, outputFormat);
  } else {
    // Non-interactive mode
    // Handle --open flag (open first result)
    if (options.open && filteredResults.length > 0) {
      const firstResult = filteredResults[0]!;
      const appMode = resolveAppMode(options.app, schema.config);
      await openNote(vaultDir, firstResult.file.path, appMode, schema.config, jsonMode);
      return;
    }

    // Handle --edit flag (edit first result)
    if (options.edit && filteredResults.length > 0) {
      const firstResult = filteredResults[0]!;
      if (options.json) {
        const result = await editNoteFromJson(schema, vaultDir, firstResult.file.path, options.json, { jsonMode });
        if (jsonMode) {
          printJson(jsonSuccess({
            path: firstResult.file.relativePath,
            updated: result.updatedFields,
          }));
        }
      } else {
        await editNoteInteractive(schema, vaultDir, firstResult.file.path);
      }
      return;
    }

    // Output all results
    if (jsonMode) {
      const jsonOutput = formatResultsJson({
        ...searchResult,
        results: filteredResults,
        totalMatches: filteredResults.reduce((sum, r) => sum + r.matches.length, 0),
      });
      // Content search has a custom JSON shape, output directly
      console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      const showContext = !options.noContext && contextLines > 0;
      const textOutput = formatResultsText(filteredResults, showContext);
      if (textOutput) {
        console.log(textOutput);
      }
    }
  }
}

/**
 * Filter content search results by frontmatter expressions.
 */
async function filterByFrontmatter(
  results: ContentMatch[],
  whereExpressions: string[],
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  typePath?: string
): Promise<ContentMatch[]> {
  // Parse frontmatter for each result and prepare for filtering
  const resultsWithFrontmatter: Array<{
    original: ContentMatch;
    path: string;
    frontmatter: Record<string, unknown>;
  }> = [];

  for (const result of results) {
    try {
      const { frontmatter } = await parseNote(result.file.path);
      resultsWithFrontmatter.push({
        original: result,
        path: result.file.path,
        frontmatter,
      });
    } catch {
      // Skip files that can't be parsed
    }
  }

  const filtered = await applyWhereExpressions(resultsWithFrontmatter, {
    schema,
    ...(typePath ? { typePath } : {}),
    whereExpressions,
    vaultDir,
  });

  if (!filtered.ok) {
    throw new Error(filtered.error);
  }

  // Return the original ContentMatch objects
  return filtered.files.map(f => f.original);
}

// ============================================================================
// Fuzzy Search Handler
// ============================================================================

/**
 * Strictly parse a finite decimal number from a raw flag string.
 *
 * Unlike `Number.parseFloat`, this rejects trailing garbage ("0.5abc"),
 * exponent notation ("1e1"), and other non-decimal forms, returning `null`
 * for anything that is not a plain finite number.
 */
function parseStrictNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Strictly parse an integer from a raw flag string.
 *
 * Unlike `Number.parseInt`, this rejects non-integer values ("2.7"), trailing
 * garbage ("3abc"), and exponent notation ("1e1"), returning `null` for
 * anything that is not a plain integer.
 */
function parseStrictInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

/**
 * Fuzzy search: ranked approximate matching over note names and aliases.
 *
 * Returns scored candidates (best first) so an agent or human can decide
 * whether an entity like the query already exists before creating a note.
 * Always non-interactive; honors the existing --output json contract by
 * exposing the score on each result.
 */
async function handleFuzzySearch(
  query: string | undefined,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  jsonMode: boolean,
  outputFormat: SearchOutputFormat
): Promise<void> {
  if (!query) {
    const error = 'Search query is required for fuzzy search (--fuzzy)';
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  // Parse and validate threshold / limit. Use strict format checks so that
  // malformed values (e.g. "0.5abc", "2.7", "1e1") error cleanly rather than
  // being silently coerced by parseFloat/parseInt's lenient parsing.
  const threshold = options.threshold !== undefined
    ? parseStrictNumber(options.threshold)
    : DEFAULT_FUZZY_THRESHOLD;
  if (threshold === null || threshold < 0 || threshold > 1) {
    const error = `Invalid --threshold "${options.threshold}": must be a number between 0 and 1`;
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  const limit = options.limit !== undefined
    ? parseStrictInteger(options.limit)
    : DEFAULT_FUZZY_LIMIT;
  if (limit === null || limit < 1) {
    const error = `Invalid --limit "${options.limit}": must be a positive integer`;
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  // Scope to --path when provided, consistent with name and content search (#705).
  const index = await buildNoteIndex(schema, vaultDir, options.path);
  const matches = await fuzzySearch(index, query, schema, vaultDir, { threshold, limit });

  // --open / --edit: act on the matched note(s), reusing the exact open/edit +
  // app-mode + picker logic that plain and content search use. Without this,
  // fuzzy silently ignored these flags (#676). Mutual exclusivity of
  // --open/--edit, "--json requires --edit", and the non-interactive
  // "--edit requires --json" rule are all enforced up front in the action
  // handler before dispatch, so we only have to wire the behavior here.
  if (options.open || options.edit) {
    await handleFuzzyOpenOrEdit(query, options, vaultDir, schema, jsonMode, matches);
    return;
  }

  if (jsonMode) {
    printJson(jsonSuccess({
      data: matches.map(m => ({
        name: m.name,
        score: Number(m.score.toFixed(4)),
        matchedField: m.matchedField,
        matchedValue: m.matchedValue,
        aliases: m.aliases,
        wikilink: generateWikilink(index, m.file),
        path: m.file.relativePath,
        absolutePath: m.file.path,
      })),
    }));
    return;
  }

  if (matches.length === 0) {
    // Silent for no matches (consistent with content search / grep behavior).
    return;
  }

  for (const match of matches) {
    await outputFuzzyResult(index, match, outputFormat);
  }
}

/**
 * Apply --open / --edit to fuzzy results.
 *
 * Behavior mirrors content search (which, like fuzzy, returns a ranked list of
 * candidates):
 * - Interactive (TTY, picker != none, not JSON, >1 match): present the picker
 *   over the ranked candidates (best first) and act on the selection.
 * - Non-interactive (no TTY, --picker none, or JSON) or a single match: act on
 *   the best (top) match — never a silent no-op.
 *
 * No matches is an error (not a silent no-op), consistent with failing to find
 * a note to open/edit. This is the key difference from the read-only fuzzy
 * paths, which stay silent on no-match like grep.
 */
async function handleFuzzyOpenOrEdit(
  query: string,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  jsonMode: boolean,
  matches: FuzzyMatch[]
): Promise<void> {
  if (matches.length === 0) {
    const error = `No matching notes found for: ${query}`;
    if (jsonMode) {
      printJson(jsonError(error));
      process.exit(ExitCodes.VALIDATION_ERROR);
    }
    printError(error);
    process.exit(1);
  }

  const pickerMode = parsePickerMode(options.picker);
  const shouldPick =
    !jsonMode &&
    pickerMode !== 'none' &&
    matches.length > 1 &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let target: ManagedFile;
  if (shouldPick) {
    // Interactive: pick among ranked candidates (already best-first).
    const pickerResult = await pickFile(matches.map(m => m.file), {
      mode: pickerMode,
      prompt: options.open ? 'Select note to open' : 'Select note to edit',
      preview: options.preview ?? false,
      vaultDir,
    });

    if (pickerResult.cancelled || !pickerResult.selected) {
      process.exit(0);
    }
    target = pickerResult.selected;
  } else {
    // Non-interactive (or single match): act on the best match.
    target = matches[0]!.file;
  }

  if (options.open) {
    const appMode = resolveAppMode(options.app, schema.config);
    await openNote(vaultDir, target.path, appMode, schema.config, jsonMode);
    return;
  }

  // --edit
  if (options.json) {
    const result = await editNoteFromJson(schema, vaultDir, target.path, options.json, { jsonMode });
    if (jsonMode) {
      printJson(jsonSuccess({
        path: target.relativePath,
        updated: result.updatedFields,
      }));
    } else {
      printSuccess(`Updated: ${target.relativePath}`);
    }
  } else {
    await editNoteInteractive(schema, vaultDir, target.path);
  }
}

/**
 * Output a single fuzzy match in the requested text format.
 *
 * The default format shows the score so ranking is visible; pipe-friendly
 * formats (paths, link, content) stay clean for scripting. `content` prints
 * the full file contents (frontmatter + body) — identical in shape to plain
 * `search --output content` — with matches emitted best-first by score.
 */
async function outputFuzzyResult(
  index: NoteIndex,
  match: FuzzyMatch,
  format: SearchOutputFormat
): Promise<void> {
  switch (format) {
    case 'content':
      // Reuse the shared text output path so fuzzy `content` is byte-for-byte
      // consistent with plain `search --output content` (full file contents).
      await outputTextResult(index, match.file, format);
      break;
    case 'paths':
      console.log(match.file.relativePath);
      break;
    case 'link':
      console.log(generateWikilink(index, match.file));
      break;
    case 'default':
    default: {
      const score = match.score.toFixed(2);
      const via = match.matchedField === 'alias'
        ? ` (alias: ${match.matchedValue})`
        : '';
      console.log(`${score}  ${match.name}${via}`);
      break;
    }
  }
}

// ============================================================================
// Name Search Handler (Original Behavior)
// ============================================================================

async function handleNameSearch(
  query: string | undefined,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  jsonMode: boolean,
  outputFormat: SearchOutputFormat
): Promise<void> {
  const pickerMode = parsePickerMode(options.picker);

  // JSON mode implies non-interactive (but returns all matches instead of error)
  const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

  // Build note index, scoping to --path when provided. Name-mode --path is
  // honored (not ignored) for consistency with content search: the same
  // filterByPath glob normalization narrows the candidate set before every
  // resolution step (path/basename/alias/fuzzy) runs against it (#705).
  const index = await buildNoteIndex(schema, vaultDir, options.path);

  // Resolve query to file(s)
  const result = await resolveAndPick(index, query, {
    pickerMode: effectivePickerMode,
    prompt: options.open ? 'Select note to open' : 'Select note',
    preview: options.preview ?? false,
    vaultDir,
  });

  if (!result.ok) {
    if (result.cancelled) {
      process.exit(0);
    }

    // In JSON mode with candidates, return all matches as success
    if (jsonMode && result.candidates && result.candidates.length > 0) {
      const data = await buildSearchResults(index, result.candidates, options.content ?? false);
      printJson(jsonSuccess({
        data,
      }));
      process.exit(0);
    }

    // For pipe-friendly output formats (link, paths, content), output all
    // candidates instead of erroring on ambiguity. This enables workflows
    // like `bwrb search Idea --output link` to return disambiguated
    // wikilinks for all matches. (fixes #544)
    if (result.candidates && result.candidates.length > 0) {
      const pipeFormats: SearchOutputFormat[] = ['link', 'paths', 'content'];
      if (pipeFormats.includes(outputFormat)) {
        for (const candidate of result.candidates) {
          await outputTextResult(index, candidate, outputFormat);
        }
        process.exit(0);
      }
    }

    exitWithResolutionError(result.error, result.candidates, jsonMode);
  }

  const targetFile = result.file;

  // Handle --open flag
  if (options.open) {
    const appMode = resolveAppMode(options.app, schema.config);
    await openNote(vaultDir, targetFile.path, appMode, schema.config, jsonMode);
    return;
  }

  // Handle --edit flag
  if (options.edit) {
    if (options.json) {
      // Non-interactive JSON edit mode
      const result = await editNoteFromJson(schema, vaultDir, targetFile.path, options.json, { jsonMode });
      if (jsonMode) {
        printJson(jsonSuccess({
          path: targetFile.relativePath,
          updated: result.updatedFields,
        }));
      }
    } else {
      // Interactive edit mode
      await editNoteInteractive(schema, vaultDir, targetFile.path);
    }
    return;
  }

  if (jsonMode) {
    // JSON output - always return array for consistency
    const data = await buildSearchResults(index, [targetFile], options.content ?? false);
    printJson(jsonSuccess({
      data,
    }));
  } else {
    // Text output - single result
    await outputTextResult(index, targetFile, outputFormat);
  }
}

// ============================================================================
// Helpers
// ============================================================================

// determineOutputFormat is now replaced by resolveSearchOutputFormat above

/**
 * Build search result data for one or more files.
 */
async function buildSearchResults(
  index: NoteIndex,
  files: ManagedFile[],
  includeContent: boolean
): Promise<SearchResultData[]> {
  const results: SearchResultData[] = [];

  for (const file of files) {
    const name = basename(file.relativePath, '.md');
    const wikilink = generateWikilink(index, file);

    const result: SearchResultData = {
      name,
      wikilink,
      path: file.relativePath,
      absolutePath: file.path,
    };

    if (includeContent) {
      result.content = await readFile(file.path, 'utf-8');
    }

    results.push(result);
  }

  return results;
}

/**
 * Output a single result in text format.
 */
async function outputTextResult(
  index: NoteIndex,
  file: ManagedFile,
  format: SearchOutputFormat
): Promise<void> {
  switch (format) {
    case 'content': {
      const content = await readFile(file.path, 'utf-8');
      console.log(content);
      break;
    }
    case 'paths':
      console.log(file.relativePath);
      break;
    case 'link':
      console.log(generateWikilink(index, file));
      break;
    case 'default':
    default:
      console.log(basename(file.relativePath, '.md'));
      break;
  }
}
