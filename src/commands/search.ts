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
import { resolveVaultDir } from '../lib/vault.js';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
import { printError } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError, warnDeprecated, type SearchOutputFormat } from '../lib/output.js';
import { openNote } from './open.js';
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
import { parseNote } from '../lib/frontmatter.js';
import { parseFilters, validateFilters, applyFrontmatterFilters, type Filter } from '../lib/query.js';
import { minimatch } from 'minimatch';

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
  // Output format (new unified flag)
  .option('-o, --output <format>', 'Output format: text (default), paths, link, content, json')
  // Deprecated output flags (still work but emit warnings)
  .option('--wikilink', 'DEPRECATED: use --output link')
  .option('--path-output', 'DEPRECATED: use --output paths')
  .option('--content', 'DEPRECATED: use --output content')
  // Open and picker options
  .option('--open', 'Open the selected note after search')
  .option('--app <mode>', 'How to open: obsidian (default), editor, system, print')
  .option('--preview', 'Show file preview in fzf picker (requires fzf)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  // Content search options
  .option('-b, --body', 'Full-text content search (uses ripgrep)')
  .option('--text', 'DEPRECATED: use --body')
  .option('-t, --type <type>', 'Restrict search to a type (e.g., idea, objective/task)')
  .option('-p, --path <pattern>', 'Filter by file path glob pattern (e.g., "Projects/**")')
  .option('--path-glob <pattern>', 'DEPRECATED: use --path')
  .option('-w, --where <expression...>', 'Filter results by frontmatter expression')
  .option('-C, --context <lines>', 'Lines of context around matches (default: 2)')
  .option('--no-context', 'Do not show context lines')
  .option('-S, --case-sensitive', 'Case-sensitive search (default: case-insensitive)')
  .option('-E, --regex', 'Treat pattern as regex (default: literal)')
  .option('-l, --limit <count>', 'Maximum files to return (default: 100)')
  .allowUnknownOption(true)
  .addHelpText('after', `
Name Search (default):
  Searches by note name, basename, or path.
  
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

  Simple Filters (same as list command):
    --field=value        Include where field equals value
    --field=a,b          Include where field equals a OR b
    --field!=value       Exclude where field equals value
    --field=             Include where field is empty/missing
    --field!=            Include where field exists

Open Options:
  --open               Open the selected note in an app
  --app <mode>         How to open: obsidian (default), editor, system, print

App Modes:
  obsidian    Open in Obsidian via URI scheme (default)
  editor      Open in $VISUAL or $EDITOR
  system      Open with system default handler
  print       Print the resolved path (for scripting)

Environment Variables:
  BWRB_DEFAULT_APP    Default app mode (obsidian, editor, system, print)

Examples:
  # Name search
  bwrb search "My Note"                    # Find by name
  bwrb search "My Note" --output link      # Output: [[My Note]]
  bwrb search "My Note" --open             # Find and open in Obsidian
  bwrb search "My Note" --open --app editor  # Find and open in $EDITOR
  
  # Content search
  bwrb search "deploy" --body              # Search all notes for "deploy"
  bwrb search "deploy" -b -t task          # Search only in tasks
  bwrb search "TODO" -b --status!=done     # Simple filter syntax
  bwrb search "TODO" -b --where "status != 'done'"  # Expression filter
  bwrb search "error.*log" -b --regex      # Regex search
  bwrb search "deploy" -b --output json    # JSON output with matches
  bwrb search "deploy" -b --open           # Search and open first match
  
  # Piping
  bwrb search "bug" -t --output paths | xargs -I {} code {}`)
  .action(async (query: string | undefined, options: SearchOptions, cmd: Command) => {
    // Resolve output format from deprecated flags and new --output option
    const outputFormat = resolveSearchOutputFormat(options);
    const jsonMode = outputFormat === 'json';

    // Handle deprecated --text flag
    if (options.text) {
      warnDeprecated('--text', '--body');
      options.body = true;
    }

    // Handle deprecated --path-glob flag
    if (options.pathGlob && !options.path) {
      warnDeprecated('--path-glob', '--path');
      options.path = options.pathGlob;
    }

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Dispatch to appropriate search mode
      if (options.body) {
        await handleContentSearch(query, options, vaultDir, schema, jsonMode, outputFormat, cmd);
      } else {
        await handleNameSearch(query, options, vaultDir, schema, jsonMode, outputFormat, cmd);
      }
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

// ============================================================================
// Content Search Handler
// ============================================================================

async function handleContentSearch(
  query: string | undefined,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').LoadedSchema,
  jsonMode: boolean,
  outputFormat: SearchOutputFormat,
  cmd: Command
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
      const error = `Unknown type: ${options.type}`;
      if (jsonMode) {
        printJson(jsonError(error));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(error);
      process.exit(1);
    }
  }

  // Parse options
  const contextLines = options.noContext ? 0 : parseInt(options.context ?? '2', 10);
  const limit = parseInt(options.limit ?? '100', 10);

  // Parse simple filters from remaining arguments (e.g., --status=done)
  const filterArgs = cmd.args.slice(1); // Skip the query argument
  const simpleFilters = parseFilters(filterArgs);

  // Validate filters if type is specified (provides schema context for validation)
  if (options.type && simpleFilters.length > 0) {
    const validation = validateFilters(schema, options.type, simpleFilters);
    if (!validation.valid) {
      if (jsonMode) {
        printJson(jsonError(validation.errors.join('; ')));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      for (const error of validation.errors) {
        printError(error);
      }
      process.exit(1);
    }
  }

  // Run content search
  const searchResult = await searchContent({
    pattern: query,
    vaultDir,
    schema,
    ...(options.type !== undefined ? { typePath: options.type } : {}),
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

  // Apply path glob filter if specified
  let filteredResults = searchResult.results;
  if (options.pathGlob) {
    filteredResults = filteredResults.filter(r => 
      minimatch(r.file.relativePath, options.pathGlob!, { matchBase: true })
    );
  }

  // Apply frontmatter filters if specified (simple filters and/or --where expressions)
  const hasFilters = simpleFilters.length > 0 || (options.where && options.where.length > 0);
  if (hasFilters) {
    filteredResults = await filterByFrontmatter(
      searchResult.results,
      options.where ?? [],
      simpleFilters,
      vaultDir,
      jsonMode
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
      await openNote(vaultDir, pickerResult.selected.path, options.app, false);
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
      await openNote(vaultDir, firstResult.file.path, options.app, jsonMode);
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
 * Filter content search results by frontmatter (simple filters and/or expressions).
 */
async function filterByFrontmatter(
  results: ContentMatch[],
  whereExpressions: string[],
  simpleFilters: Filter[],
  vaultDir: string,
  jsonMode: boolean
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

  // Apply filters using shared helper
  const filtered = await applyFrontmatterFilters(resultsWithFrontmatter, {
    filters: simpleFilters,
    whereExpressions,
    vaultDir,
    silent: jsonMode,
  });

  // Return the original ContentMatch objects
  return filtered.map(f => f.original);
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
  outputFormat: SearchOutputFormat,
  _cmd: Command
): Promise<void> {
  const pickerMode = parsePickerMode(options.picker);

  // JSON mode implies non-interactive (but returns all matches instead of error)
  const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

  // Build note index
  const index = await buildNoteIndex(schema, vaultDir);

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

    exitWithResolutionError(result.error, result.candidates, jsonMode);
  }

  const targetFile = result.file;

  // Handle --open flag
  if (options.open) {
    await openNote(vaultDir, targetFile.path, options.app, jsonMode);
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
