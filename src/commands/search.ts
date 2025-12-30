/**
 * Search command - find notes and output in various formats.
 *
 * Two modes:
 * 1. Name search (default): Resolves a query to notes by name/path
 * 2. Content search (--text): Full-text search using ripgrep
 */

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { basename, dirname, relative } from 'path';
import { stat } from 'fs/promises';
import { resolveVaultDir } from '../lib/vault.js';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
import { printError } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
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
  type ContentSearchResult,
} from '../lib/content-search.js';
import { parseNote } from '../lib/frontmatter.js';
import { matchesExpression, type EvalContext } from '../lib/expression.js';
import { parseFilters, matchesAllFilters, type Filter } from '../lib/query.js';

// ============================================================================
// Types
// ============================================================================

interface SearchOptions {
  picker?: string;
  output?: string;
  wikilink?: boolean;
  path?: boolean;
  content?: boolean;
  // Content search options
  text?: boolean;
  type?: string;
  where?: string[];
  context?: string;
  noContext?: boolean;
  caseSensitive?: boolean;
  regex?: boolean;
  limit?: string;
}

type OutputFormat = 'name' | 'wikilink' | 'path' | 'content';

interface SearchResultData {
  name: string;
  wikilink: string;
  path: string;
  absolutePath: string;
  content?: string;
}

// ============================================================================
// Command Definition
// ============================================================================

export const searchCommand = new Command('search')
  .description('Search for notes by name or content')
  .argument('[query]', 'Search pattern (name/path for default mode, content pattern for --text)')
  .option('--wikilink', 'Output [[Name]] format for Obsidian links')
  .option('--path', 'Output vault-relative path with extension')
  .option('--content', 'Output full file contents (frontmatter + body)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  // Content search options
  .option('-t, --text', 'Full-text content search (uses ripgrep)')
  .option('--type <type>', 'Restrict search to a type (e.g., idea, objective/task)')
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
  
  Output Formats (mutually exclusive, priority: content > path > wikilink > name):
    (default)     Output just the note name (basename without .md)
    --wikilink    Output [[Name]] format for Obsidian links
    --path        Output vault-relative path with extension
    --content     Output full file contents (frontmatter + body)

  Picker Modes:
    auto        Use fzf if available, else numbered select (default)
    fzf         Force fzf (error if unavailable)
    numbered    Force numbered select
    none        Error on ambiguity (for non-interactive use)

Content Search (--text):
  Full-text search across note contents using ripgrep.
  
  Options:
    -t, --text           Enable content search mode
    --type <type>        Restrict to specific type (e.g., task, objective/task)
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

Examples:
  # Name search
  ovault search "My Note"                    # Find by name
  ovault search "My Note" --wikilink         # Output: [[My Note]]
  
  # Content search
  ovault search "deploy" --text              # Search all notes for "deploy"
  ovault search "deploy" -t --type task      # Search only in tasks
  ovault search "TODO" -t --status!=done     # Simple filter syntax
  ovault search "TODO" -t --where "status != 'done'"  # Expression filter
  ovault search "error.*log" -t --regex      # Regex search
  ovault search "deploy" -t --output json    # JSON output with matches
  
  # Piping
  ovault search "bug" -t --path | xargs -I {} code {}`)
  .action(async (query: string | undefined, options: SearchOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Dispatch to appropriate search mode
      if (options.text) {
        await handleContentSearch(query, options, vaultDir, schema, jsonMode, cmd);
      } else {
        await handleNameSearch(query, options, vaultDir, schema, jsonMode, cmd);
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
  schema: import('../types/schema.js').Schema,
  jsonMode: boolean,
  cmd: Command
): Promise<void> {
  // Validate query is provided for content search
  if (!query) {
    const error = 'Search pattern is required for content search (--text)';
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

  // Run content search
  const searchResult = await searchContent({
    pattern: query,
    vaultDir,
    schema,
    typePath: options.type,
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

  // Apply frontmatter filters if specified (simple filters and/or --where expressions)
  let filteredResults = searchResult.results;
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
      printJson(jsonSuccess({
        data: [],
        totalMatches: 0,
        truncated: false,
      }));
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
      prompt: `${filteredResults.length} files with matches`,
    });

    if (pickerResult.cancelled || !pickerResult.selected) {
      process.exit(0);
    }

    // Output the selected file based on format
    const index = await buildNoteIndex(schema, vaultDir);
    const outputFormat = determineOutputFormat(options, jsonMode);
    await outputTextResult(index, pickerResult.selected, outputFormat);
  } else {
    // Non-interactive: output all results
    if (jsonMode) {
      const jsonOutput = formatResultsJson({
        ...searchResult,
        results: filteredResults,
        totalMatches: filteredResults.reduce((sum, r) => sum + r.matches.length, 0),
      });
      printJson(jsonOutput);
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
  const filtered: ContentMatch[] = [];

  for (const result of results) {
    try {
      const { frontmatter } = await parseNote(result.file.path);

      // Apply simple filters first (--field=value style)
      if (!matchesAllFilters(frontmatter, simpleFilters)) {
        continue;
      }

      // Apply expression filters (--where style)
      if (whereExpressions.length > 0) {
        const context = await buildEvalContext(result.file.path, vaultDir, frontmatter);
        const allMatch = whereExpressions.every(expr => {
          try {
            return matchesExpression(expr, context);
          } catch (e) {
            if (!jsonMode) {
              printError(`Expression error in "${expr}": ${(e as Error).message}`);
            }
            return false;
          }
        });

        if (!allMatch) {
          continue;
        }
      }

      filtered.push(result);
    } catch {
      // Skip files that can't be parsed
    }
  }

  return filtered;
}

/**
 * Build evaluation context for expression filtering.
 */
async function buildEvalContext(
  filePath: string,
  vaultDir: string,
  frontmatter: Record<string, unknown>
): Promise<EvalContext> {
  const relativePath = relative(vaultDir, filePath);
  const fileName = basename(filePath, '.md');
  const folder = dirname(relativePath);

  let fileInfo: EvalContext['file'] = {
    name: fileName,
    path: relativePath,
    folder,
    ext: '.md',
  };

  try {
    const stats = await stat(filePath);
    fileInfo = {
      ...fileInfo,
      size: stats.size,
      ctime: stats.birthtime,
      mtime: stats.mtime,
    };
  } catch {
    // Ignore stat errors
  }

  return {
    frontmatter,
    file: fileInfo,
  };
}

// ============================================================================
// Name Search Handler (Original Behavior)
// ============================================================================

async function handleNameSearch(
  query: string | undefined,
  options: SearchOptions,
  vaultDir: string,
  schema: import('../types/schema.js').Schema,
  jsonMode: boolean,
  _cmd: Command
): Promise<void> {
  const pickerMode = parsePickerMode(options.picker);
  const outputFormat = determineOutputFormat(options, jsonMode);

  // JSON mode implies non-interactive (but returns all matches instead of error)
  const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

  // Build note index
  const index = await buildNoteIndex(schema, vaultDir);

  // Resolve query to file(s)
  const result = await resolveAndPick(index, query, {
    pickerMode: effectivePickerMode,
    prompt: 'Select note',
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

/**
 * Determine output format from options with priority handling.
 * Priority: content > path > wikilink > name (default)
 */
function determineOutputFormat(options: SearchOptions, jsonMode: boolean): OutputFormat {
  const flags: OutputFormat[] = [];

  if (options.content) flags.push('content');
  if (options.path) flags.push('path');
  if (options.wikilink) flags.push('wikilink');

  // Warn if multiple flags provided (to stderr so it doesn't break piping)
  if (flags.length > 1 && !jsonMode) {
    const flagNames = flags.map(f => `--${f}`).join(', ');
    console.error(`Warning: Multiple output format flags provided (${flagNames}). Using --${flags[0]}.`);
  }

  // Return highest priority flag, or default to 'name'
  return flags[0] ?? 'name';
}

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
  format: OutputFormat
): Promise<void> {
  switch (format) {
    case 'content': {
      const content = await readFile(file.path, 'utf-8');
      console.log(content);
      break;
    }
    case 'path':
      console.log(file.relativePath);
      break;
    case 'wikilink':
      console.log(generateWikilink(index, file));
      break;
    case 'name':
    default:
      console.log(basename(file.relativePath, '.md'));
      break;
  }
}
