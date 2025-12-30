/**
 * Search command - find notes and output in various formats.
 *
 * Resolves a query to one or more notes and outputs them in the requested format.
 * Replaces the old `link` command with more flexible output options.
 */

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { resolveVaultDir } from '../lib/vault.js';
import { loadSchema } from '../lib/schema.js';
import { printError } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
import {
  buildNoteIndex,
  generateWikilink,
  type ManagedFile,
  type NoteIndex,
} from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';

// ============================================================================
// Types
// ============================================================================

interface SearchOptions {
  picker?: string;
  output?: string;
  wikilink?: boolean;
  path?: boolean;
  content?: boolean;
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
  .description('Search for notes and output in various formats')
  .argument('[query]', 'Note name, basename, or path to find (omit to browse all)')
  .option('--wikilink', 'Output [[Name]] format for Obsidian links')
  .option('--path', 'Output vault-relative path with extension')
  .option('--content', 'Output full file contents (frontmatter + body)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .addHelpText('after', `
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
              In JSON mode with --picker none, returns all matches

JSON Output:
  Returns an array of matches. Each match includes name, wikilink, path,
  and absolutePath. Add --content to include file contents (can be large).

Examples:
  ovault search                              # Browse all notes with picker
  ovault search "My Note"                    # Output: My Note
  ovault search "My Note" --wikilink         # Output: [[My Note]]
  ovault search "My Note" --path             # Output: Ideas/My Note.md
  ovault search "My Note" --content          # Output: full file contents
  ovault search "idea" --output json         # JSON array of all matches
  ovault search "idea" --output json --content  # JSON with file contents
  
  # Use with clipboard (macOS)
  ovault search "My Note" --wikilink | pbcopy
  
  # Get content for processing
  ovault search "My Note" --content | grep "status:"`)
  .action(async (query: string | undefined, options: SearchOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const pickerMode = parsePickerMode(options.picker);
    const outputFormat = determineOutputFormat(options, jsonMode);

    // JSON mode implies non-interactive (but returns all matches instead of error)
    const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

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
