/**
 * Edit command - modify note frontmatter.
 * 
 * This is an alias for `search --edit` with the same targeting options.
 * Supports both interactive prompts and non-interactive JSON mode.
 */

import { Command } from 'commander';
import { basename, isAbsolute, relative } from 'path';
import fs from 'fs/promises';
import { resolveVaultDir } from '../lib/vault.js';
import { loadSchema, getTypeDefByPath } from '../lib/schema.js';
import { printError, printSuccess } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
import { buildNoteIndex, type ManagedFile } from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';
import { editNoteFromJson, editNoteInteractive } from '../lib/edit.js';
import { openNote, parseAppMode } from './open.js';
import { parseFilters, validateFilters } from '../lib/query.js';
import { resolveTargets, hasAnyTargeting, type TargetingOptions } from '../lib/targeting.js';

// ============================================================================
// Types
// ============================================================================

interface EditOptions {
  picker?: string;
  type?: string;
  path?: string;
  where?: string[];
  body?: string;
  json?: string;
  open?: boolean;
  app?: string;
}

// ============================================================================
// Command Definition
// ============================================================================

export const editCommand = new Command('edit')
  .description('Edit an existing note')
  .argument('[query]', 'Note name or path to edit')
  .option('--picker <mode>', 'Picker mode: fzf, numbered, none', 'fzf')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-p, --path <glob>', 'Filter by path pattern')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression')
  .option('-b, --body <pattern>', 'Filter by body content')
  .option('--json <patch>', 'Non-interactive patch/merge mode')
  .option('-o, --open', 'Open the note in Obsidian after editing')
  .option('--app <mode>', 'App mode for --open: obsidian, editor, print, reveal')
  .addHelpText('after', `
Targeting Options:
  All targeting options compose (AND logic):
  -t, --type <type>    Filter by note type (e.g., task, idea)
  -p, --path <glob>    Filter by path pattern (e.g., "Projects/**")
  -w, --where <expr>   Filter by frontmatter (e.g., "status=active")
  -b, --body <pattern> Filter by body content

Simple Filters (shorthand for --where):
  field=value          Match where field equals value
  field!=value         Exclude where field equals value

Examples:
  # Interactive editing
  bwrb edit "My Note"                       # Find and edit interactively
  bwrb edit -t task "Review"                # Edit a task by name
  bwrb edit --path "Projects/**" "Design"   # Edit within Projects folder

  # Non-interactive JSON mode (scripting)
  bwrb edit "My Task" --json '{"status":"done"}'
  bwrb edit -t task --where "status=active" "Deploy" --json '{"priority":"high"}'

  # Edit and open
  bwrb edit "My Note" --open                # Open the note after editing
  bwrb edit "My Note" --open --app editor   # Edit then open in $EDITOR`)
  .action(async (query: string | undefined, options: EditOptions, cmd: Command) => {
    const jsonMode = options.json !== undefined;

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

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

      // Parse simple filters from remaining arguments
      const filterArgs = cmd.args.slice(query ? 1 : 0);
      const simpleFilters = parseFilters(filterArgs);

      // Validate filters if type is specified
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

      // Check if query is an absolute path to an existing file
      if (query && isAbsolute(query)) {
        try {
          await fs.access(query);
          // It's a valid absolute path - use it directly
          if (options.json) {
            const editResult = await editNoteFromJson(schema, vaultDir, query, options.json, { jsonMode: true });
            printJson(jsonSuccess({
              path: relative(vaultDir, query),
              updated: editResult.updatedFields,
            }));
            if (options.open) {
              const appMode = parseAppMode(options.app || "default");
              await openNote(vaultDir, query, appMode, true);
            }
          } else {
            await editNoteInteractive(schema, vaultDir, query, {});
            printSuccess(`Updated ${basename(query, '.md')}`);
            if (options.open) {
              const appMode = parseAppMode(options.app || "default");
              await openNote(vaultDir, query, appMode, false);
            }
          }
          process.exit(0);
        } catch {
          // File doesn't exist or isn't accessible - fall through to normal resolution
        }
      }

      // Build targeting options
      const targeting: TargetingOptions = {};
      if (options.type) targeting.type = options.type;
      if (options.path) targeting.path = options.path;
      if (options.where) targeting.where = options.where;
      if (options.body) targeting.body = options.body;

      // Determine if we have targeting constraints
      const hasTargeting = hasAnyTargeting(targeting);

      // Determine picker mode
      const pickerMode = parsePickerMode(options.picker);
      const effectivePickerMode: PickerMode = jsonMode ? 'none' : pickerMode;

      // In JSON mode without interactive picker, require a query or targeting
      if (jsonMode && !query && !hasTargeting) {
        printJson(jsonError('Query required when using --json without targeting options'));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      // Build candidates based on targeting
      let candidates: ManagedFile[];
      const index = await buildNoteIndex(schema, vaultDir);

      if (hasTargeting) {
        // Use resolveTargets for proper filtering
        const targetingResult = await resolveTargets(targeting, schema, vaultDir);
        if (targetingResult.error) {
          if (jsonMode) {
            printJson(jsonError(targetingResult.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(targetingResult.error);
          process.exit(1);
        }
        candidates = targetingResult.files;
      } else {
        candidates = index.allFiles;
      }

      // Create a filtered index for resolution
      const filteredIndex = {
        ...index,
        allFiles: candidates,
        byPath: new Map([...index.byPath].filter(([, f]) => candidates.includes(f))),
        byBasename: new Map<string, ManagedFile[]>(),
      };
      // Rebuild byBasename for filtered candidates
      for (const file of candidates) {
        const fileBasename = basename(file.relativePath, '.md');
        const existing = filteredIndex.byBasename.get(fileBasename) ?? [];
        existing.push(file);
        filteredIndex.byBasename.set(fileBasename, existing);
      }

      // Resolve to a single file
      const result = await resolveAndPick(filteredIndex, query, {
        pickerMode: effectivePickerMode,
        prompt: 'Select note to edit',
        preview: false,
        vaultDir,
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const targetFile = result.file;

      // Perform the edit
      if (options.json) {
        // JSON mode: non-interactive patch
        const editResult = await editNoteFromJson(schema, vaultDir, targetFile.path, options.json, { jsonMode: true });
        
        printJson(jsonSuccess({
          path: targetFile.relativePath,
          updated: editResult.updatedFields,
        }));

        // Open after edit if requested
        if (options.open) {
          const appMode = parseAppMode(options.app || "default");
          await openNote(vaultDir, targetFile.path, appMode, true);
        }
      } else {
        // Interactive mode
        await editNoteInteractive(schema, vaultDir, targetFile.path);
        printSuccess(`Updated: ${targetFile.relativePath}`);

        // Open after edit if requested
        if (options.open) {
          const appMode = parseAppMode(options.app || "default");
          await openNote(vaultDir, targetFile.path, appMode, false);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.IO_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });
