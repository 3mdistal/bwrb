/**
 * Link command - generate a wikilink to a note.
 * 
 * Resolves a query to a note and outputs the shortest unambiguous
 * wikilink (basename if unique, else vault-relative path without .md).
 */

import { Command } from 'commander';
import { resolveVaultDir } from '../lib/vault.js';
import { loadSchema } from '../lib/schema.js';
import { printError } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
import {
  buildNoteIndex,
  getShortestWikilinkTarget,
  generateWikilink,
} from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';

// ============================================================================
// Types
// ============================================================================

interface LinkOptions {
  picker?: string;
  output?: string;
  bare?: boolean;
}

// ============================================================================
// Command Definition
// ============================================================================

export const linkCommand = new Command('link')
  .description('Generate a wikilink to a note')
  .argument('[query]', 'Note name, basename, or path to link to (omit to browse all)')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--bare', 'Output just the link target without brackets')
  .addHelpText('after', `
Output:
  By default, outputs [[Target]] format.
  Use --bare to get just the target (without brackets).
  
  Link target uses shortest unambiguous form:
  - Basename if unique across vault (e.g., "My Note")
  - Vault-relative path without .md if not unique (e.g., "Ideas/My Note")

Picker Modes:
  auto        Use fzf if available, else numbered select (default)
  fzf         Force fzf (error if unavailable)
  numbered    Force numbered select
  none        Error on ambiguity (for non-interactive use)

Examples:
  ovault link                              # Browse all notes with picker
  ovault link "My Note"                    # Output: [[My Note]]
  ovault link "My Note" --bare             # Output: My Note
  ovault link "Amb" --picker none --output json  # Scripting mode
  
  # Use with clipboard (macOS)
  ovault link "My Note" | pbcopy
  
  # Use in Neovim (Lua)
  local link = vim.fn.system("ovault link 'My Note' --picker none --bare")`)
  .action(async (query: string | undefined, options: LinkOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const pickerMode = parsePickerMode(options.picker);
    const bare = options.bare ?? false;

    // JSON mode implies non-interactive
    const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Build note index
      const index = await buildNoteIndex(schema, vaultDir);

      // Resolve query to a file (with picker if needed)
      const result = await resolveAndPick(index, query, {
        pickerMode: effectivePickerMode,
        prompt: 'Select note to link',
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const targetFile = result.file;

      // Generate wikilink
      const linkTarget = getShortestWikilinkTarget(index, targetFile);
      const wikilink = generateWikilink(index, targetFile);

      if (jsonMode) {
        printJson(jsonSuccess({
          data: {
            target: linkTarget,
            wikilink: wikilink,
            relativePath: targetFile.relativePath,
            absolutePath: targetFile.path,
          },
        }));
      } else {
        console.log(bare ? linkTarget : wikilink);
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
