/**
 * Edit command - modify note frontmatter.
 * 
 * This is an alias for `search --edit` with the same targeting options.
 * Supports both interactive prompts and non-interactive JSON mode.
 */

import { Command } from 'commander';
import { basename, isAbsolute, relative } from 'path';
import fs from 'fs/promises';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts, resolveGlobalPickerMode } from '../lib/command.js';
import { loadSchema, getType, formatUnknownTypeError } from '../lib/schema.js';
import { configurePromptMode, printError, printSuccess } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
import {
  buildNoteIndex,
  hydrateNoteIndexAliases,
  resolveExactNoteQuery,
  type ManagedFile,
} from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';
import { editNoteFromJson, editNoteInteractive } from '../lib/edit.js';
import {
  getOpenResultData,
  openNote,
  resolveAppMode,
  parseAppMode,
  OpenConfigurationError,
  type AppMode,
  type OpenResultData,
} from './open.js';
import { resolveTargets, hasAnyTargeting, type TargetingOptions } from '../lib/targeting.js';
import { ConcurrentNoteModificationError, UserCancelledError } from '../lib/errors.js';
import { concurrentModificationData } from '../lib/note-write-concurrency.js';
import { RevisionMismatchError } from '../lib/note-revision.js';
import type { ResolvedConfig } from '../types/schema.js';

// ============================================================================
// Types
// ============================================================================

interface EditOptions {
  picker?: string;
  type?: string;
  path?: string;
  where?: string[];
  id?: string;
  body?: string;
  json?: string;
  jsonFile?: string;
  expectedRevision?: string;
  output?: string;
  open?: boolean;
  app?: string;
}

function resolveEditJsonMode(options: EditOptions, globalOutput?: string): boolean {
  const requested = options.output ?? globalOutput;
  if (requested === undefined) {
    return options.json !== undefined || options.jsonFile !== undefined;
  }
  return requested === 'json';
}

interface EditOpenJsonData {
  open: OpenResultData;
}

async function openAfterEdit(
  vaultDir: string,
  notePath: string,
  appMode: AppMode,
  config: ResolvedConfig,
  jsonMode: boolean
): Promise<EditOpenJsonData | undefined> {
  if (jsonMode) {
    const openData = getOpenResultData(vaultDir, notePath, appMode, config);
    if (appMode !== 'print') {
      await openNote(vaultDir, notePath, appMode, config, false);
    }
    return { open: openData };
  }

  await openNote(vaultDir, notePath, appMode, config, false);
  return undefined;
}

function printEditSuccess(
  path: string,
  updatedFields: string[],
  jsonMode: boolean,
  revision?: string,
  data?: EditOpenJsonData
): void {
  if (jsonMode) {
    printJson(jsonSuccess({
      path,
      updated: updatedFields,
      ...(revision ? { revision } : {}),
      ...(data ? { data } : {}),
    }));
    return;
  }

  const updatedText = updatedFields.length > 0
    ? ` (${updatedFields.join(', ')})`
    : '';
  printSuccess(`Updated: ${path}${updatedText}`);
}

// ============================================================================
// Command Definition
// ============================================================================

export const editCommand = new Command('edit')
  .description('Edit an existing note')
  .argument('[query]', 'Note name or path to edit')
  .argument('[mode]', 'App mode for --open: system, editor, visual, obsidian, print')
  .option('--picker <mode>', 'Picker mode: fzf, numbered, none', 'fzf')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-p, --path <glob>', 'Filter by path pattern')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression')
  .option('--id <uuid>', 'Filter by stable note id')
  .option('-b, --body <pattern>', 'Filter by body content')
  .option('--json <patch>', 'Non-interactive patch/merge mode')
  .option('--json-file <path>', 'Read the non-interactive JSON patch from a file (avoids command-line size limits)')
  .option('--expected-revision <revision>', 'Require this opaque revision when using --json')
  .option('--output <format>', 'Output format: text or json (default: json with --json)')
  .option('-o, --open', 'Open the note in Obsidian after editing')
  .option('--app <mode>', 'App mode for --open: system (default), editor, visual, obsidian, print')
  .addHelpText('after', `
Targeting Options:
  All targeting options compose (AND logic):
  -t, --type <type>    Filter by note type (e.g., task, idea)
  -p, --path <glob>    Filter by path pattern (e.g., "Projects/**")
  -w, --where <expr>   Filter by frontmatter (e.g., "status == 'active'")
  --id <uuid>          Filter by stable note id
  -b, --body <pattern> Filter by body content

Examples:
  # Interactive editing
  bwrb edit "My Note"                       # Find and edit interactively
  bwrb edit -t task "Review"                # Edit a task by name
  bwrb edit --path "Projects/**" "Design"   # Edit within Projects folder

  # Non-interactive JSON mode (scripting)
  bwrb edit "My Task" --json '{"status":"done"}'
  bwrb edit "My Task" --json-file /secure/path/task-patch.json
  bwrb edit "My Task" --json '{"_body":"A replacement Markdown body."}'
  bwrb edit "My Task" --json '{"_body":{"Steps":["One","Two"]}}'
  bwrb edit "My Task" --json '{"status":"done"}' --output json
  bwrb edit "My Task" --json '{"status":"done"}' --output text
  bwrb edit -t task --where "status == 'active'" "Deploy" --json '{"priority":"high"}'

Body replacement (JSON mode):
  The _body field replaces the current body atomically. It accepts a raw Markdown
  string or section names as keys, with string or string[] values.

  # Edit and open
  bwrb edit "My Note" --open                # Open the note after editing
  bwrb edit "My Note" --open --app editor   # Edit then open in $EDITOR
  bwrb edit "My Note" --open print          # Positional mode (for --open)

App Modes (for --open):
  system      Open with OS default handler (default)
  editor      Open in terminal editor ($EDITOR or config.editor)
  visual      Open in GUI editor ($VISUAL or config.visual)
  obsidian    Open in Obsidian via URI scheme
  print       Print the resolved path (for scripting)

Precedence (for --open app mode):
  1. --app flag (explicit)
  2. [mode] positional argument (e.g. bwrb edit "My Note" --open print)
  3. BWRB_DEFAULT_APP environment variable
  4. config.open_with in .bwrb/schema.json
  5. Fallback: system`)
  // Reject excess positional args (e.g. `edit "Note" print bogus`). Only
  // [query] and [mode] are accepted; a third+ token is almost certainly a
  // typo, and silently swallowing it (commander's default) hides the mistake.
  .allowExcessArguments(false)
  .action(async (query: string | undefined, mode: string | undefined, options: EditOptions, cmd: Command) => {
    const patchMode = options.json !== undefined || options.jsonFile !== undefined;
    // App-mode precedence: an explicit --app flag wins over the positional
    // [mode]; the positional is the convenience form. An invalid positional
    // mode surfaces via parseAppMode (inside resolveAppMode) as a clear error
    // rather than silently falling back to the default app.
    const appModeInput = options.app ?? mode;
    let jsonMode = patchMode;
    let resolvedVaultDir: string | undefined;
    let selectedTargetPath: string | undefined;
    try {
      if (options.json !== undefined && options.jsonFile !== undefined) {
        throw new Error('--json and --json-file are mutually exclusive.');
      }
      const jsonPatch = options.json ?? (options.jsonFile !== undefined
        ? await fs.readFile(options.jsonFile, 'utf8')
        : undefined);
      const globalOpts = getGlobalOpts(cmd);
      jsonMode = resolveEditJsonMode(options, globalOpts.output);
      const outputFormat = options.output ?? globalOpts.output;
      if (outputFormat !== undefined && outputFormat !== 'json' && outputFormat !== 'text') {
        printError(`Unknown output format: ${outputFormat}`);
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      if (options.expectedRevision !== undefined && !patchMode) {
        const error = '--expected-revision requires --json <patch>';
        if (jsonMode) {
          printJson(jsonError(error));
        } else {
          printError(error);
        }
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      configurePromptMode({
        forcedNonInteractive: globalOpts.nonInteractive === true,
        bypassHint: 'Use --json <patch> to update notes without prompts.',
      });
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      resolvedVaultDir = vaultDir;
      const schema = await loadSchema(vaultDir);

      if (globalOpts.nonInteractive && !patchMode) {
        printError('bwrb edit requires --json <patch> when --non-interactive is set.');
        process.exit(1);
      }

      // Validate the app mode eagerly (mirrors `open`): an invalid value from
      // either --app or the positional [mode] errors loudly here rather than
      // being silently ignored when --open isn't requested. Surface it as a
      // VALIDATION_ERROR (exit 1) with a clear message, consistent with `open`.
      if (appModeInput !== undefined) {
        try {
          parseAppMode(appModeInput);
        } catch (modeErr) {
          const message = modeErr instanceof Error ? modeErr.message : String(modeErr);
          if (jsonMode) {
            printJson(jsonError(message));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(message);
          process.exit(1);
        }
      }

      // Validate type if provided
      if (options.type) {
        const typeDef = getType(schema, options.type);
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

      // Check if query is an absolute path to an existing file
      if (query && isAbsolute(query)) {
        // Only the existence check may fall through to name resolution. Once we
        // know the file exists, edit errors (e.g. a recurrence spawn failure:
        // "Recurrence template 'X' was not found", "Cannot compute recurrence
        // offset: ...") MUST propagate to the outer catch so the user sees the
        // real message — never swallowed into a misleading "No matching notes".
        let fileExists = false;
        try {
          await fs.access(query);
          fileExists = true;
        } catch {
          // File doesn't exist or isn't accessible - fall through to normal resolution.
        }

        if (fileExists) {
          // It's a valid absolute path - use it directly.
          if (patchMode) {
            const editResult = await editNoteFromJson(schema, vaultDir, query, jsonPatch!, {
              jsonMode,
              ...(options.expectedRevision !== undefined
                ? { expectedRevision: options.expectedRevision }
                : {}),
            });
            let openData: EditOpenJsonData | undefined;
            if (options.open) {
              const appMode = resolveAppMode(appModeInput, schema.config);
              if (!jsonMode) {
                printEditSuccess(relative(vaultDir, query), editResult.updatedFields, jsonMode);
                await openAfterEdit(vaultDir, query, appMode, schema.config, jsonMode);
                return;
              }
              openData = await openAfterEdit(vaultDir, query, appMode, schema.config, jsonMode);
            }
            printEditSuccess(relative(vaultDir, query), editResult.updatedFields, jsonMode, editResult.revision, openData);
          } else {
            await editNoteInteractive(schema, vaultDir, query, {});
            printSuccess(`Updated ${basename(query, '.md')}`);
            if (options.open) {
              const appMode = resolveAppMode(appModeInput, schema.config);
              await openNote(vaultDir, query, appMode, schema.config, false);
            }
          }
          return;
        }
      }

      // Build targeting options
      const targeting: TargetingOptions = {};
      if (options.type) targeting.type = options.type;
      if (options.path) targeting.path = options.path;
      if (options.where) targeting.where = options.where;
      if (options.id) targeting.id = options.id;
      if (options.body) targeting.body = options.body;

      // Determine if we have targeting constraints
      const hasTargeting = hasAnyTargeting(targeting);

      // Determine picker mode
      const pickerMode = parsePickerMode(resolveGlobalPickerMode(options.picker, globalOpts, 'fzf'));
      const effectivePickerMode: PickerMode = patchMode ? 'none' : pickerMode;

      // In JSON mode without interactive picker, require a query or targeting
      if (patchMode && !query && !hasTargeting) {
        const error = 'Query required when using --json without targeting options';
        if (jsonMode) {
          printJson(jsonError(error));
        } else {
          printError(error);
        }
        process.exit(ExitCodes.VALIDATION_ERROR);
      }

      // Build candidates based on targeting
      let candidates: ManagedFile[];
      // A plain `edit <query>` can resolve a path or basename solely from the
      // canonical discovery result. Avoid parsing every note's frontmatter
      // until that exact tier misses; aliases and fuzzy matching still hydrate
      // below with the same discovered files. Targeted modes deliberately keep
      // their eager behavior because filtering depends on parsed metadata.
      const directQueryFastPath = query !== undefined && !hasTargeting;
      const index = await buildNoteIndex(schema, vaultDir, undefined, {
        includeAliases: !directQueryFastPath,
      });

      if (hasTargeting) {
        // Use resolveTargets for proper filtering
        const targetingResult = await resolveTargets(targeting, schema, vaultDir);
        if (targetingResult.error) {
          exitWithResolutionError(targetingResult.error, targetingResult.files, jsonMode);
        }
        candidates = targetingResult.files;
      } else {
        candidates = index.allFiles;
      }

      // Create a filtered index for resolution
      const candidatePaths = new Set(candidates.map((candidate) => candidate.relativePath));
      const filteredIndex = {
        ...index,
        allFiles: candidates,
        byPath: new Map(
          [...index.byPath].filter(([path]) => candidatePaths.has(path))
        ),
        byBasename: new Map<string, ManagedFile[]>(),
        byAlias: new Map(
          [...index.byAlias]
            .map(([alias, files]): [string, ManagedFile[]] => [
              alias,
              files.filter((file) => candidatePaths.has(file.relativePath)),
            ])
            .filter(([, files]) => files.length > 0)
        ),
      };
      // Rebuild byBasename for filtered candidates
      for (const file of candidates) {
        const fileBasename = basename(file.relativePath, '.md');
        const existing = filteredIndex.byBasename.get(fileBasename) ?? [];
        existing.push(file);
        filteredIndex.byBasename.set(fileBasename, existing);
      }

      if (directQueryFastPath) {
        const exactResolution = resolveExactNoteQuery(filteredIndex, query);
        // An exact file or an ambiguous basename is already decisive. Only an
        // actual path/basename miss pays the snapshot parse required for aliases
        // and fuzzy fallback.
        if (!exactResolution.exact && exactResolution.candidates.length === 0) {
          await hydrateNoteIndexAliases(schema, filteredIndex);
        }
      }

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
      selectedTargetPath = targetFile.relativePath;

      // Perform the edit
      if (patchMode) {
        // JSON patch mode: non-interactive patch with selectable output format
        const editResult = await editNoteFromJson(schema, vaultDir, targetFile.path, jsonPatch!, {
          jsonMode,
          ...(options.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
        });
        let openData: EditOpenJsonData | undefined;

        // Open after edit if requested
        if (options.open) {
          const appMode = resolveAppMode(appModeInput, schema.config);
          if (!jsonMode) {
            printEditSuccess(targetFile.relativePath, editResult.updatedFields, jsonMode);
            await openAfterEdit(vaultDir, targetFile.path, appMode, schema.config, jsonMode);
            return;
          }
          openData = await openAfterEdit(vaultDir, targetFile.path, appMode, schema.config, jsonMode);
        }
        printEditSuccess(targetFile.relativePath, editResult.updatedFields, jsonMode, editResult.revision, openData);
        return;
      } else {
        // Interactive mode
        await editNoteInteractive(schema, vaultDir, targetFile.path);
        printSuccess(`Updated: ${targetFile.relativePath}`);

        // Open after edit if requested
        if (options.open) {
          const appMode = resolveAppMode(appModeInput, schema.config);
          await openNote(vaultDir, targetFile.path, appMode, schema.config, false);
        }
        return;
      }
    } catch (err) {
      if (err instanceof RevisionMismatchError) {
        if (jsonMode) {
          printJson(jsonError(err.message, {
            code: 'REVISION_MISMATCH',
            expectedRevision: err.expectedRevision,
            currentRevision: err.currentRevision,
          }));
        } else {
          printError(err.message);
        }
        process.exit(ExitCodes.IO_ERROR);
      }
      if ((err as { code?: string }).code === 'TRANSITION_GUARD_FAILED') {
        const guardError = err as Error & { explanation: unknown };
        if (jsonMode) {
          printJson(jsonError(guardError.message, {
            code: 'TRANSITION_GUARD_FAILED',
            data: guardError.explanation,
          }));
        } else {
          printError(guardError.message);
        }
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      if (err instanceof ConcurrentNoteModificationError) {
        if (jsonMode) {
          printJson(jsonError(err.message, {
            code: ExitCodes.IO_ERROR,
            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), err),
          }));
          process.exit(ExitCodes.IO_ERROR);
        }
        printError(err.message);
        process.exit(ExitCodes.IO_ERROR);
      }
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      const actionableMessage = err instanceof Error && err.name === 'YAMLException' && selectedTargetPath
        ? `Could not edit ${selectedTargetPath}: malformed YAML frontmatter. ${message} Fix the YAML in that file and retry.`
        : message;
      if (err instanceof OpenConfigurationError) {
        if (jsonMode) {
          printJson(jsonError(actionableMessage));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(actionableMessage);
        process.exit(1);
      }
      if (jsonMode) {
        printJson(jsonError(actionableMessage));
        process.exit(ExitCodes.IO_ERROR);
      }
      printError(actionableMessage);
      process.exit(1);
    }
  });
