/**
 * Open command - alias for `search --open`.
 * 
 * This command is kept for backward compatibility and convenience.
 * It delegates to the search command with the --open flag.
 * 
 * Supports multiple output modes:
 * - obsidian: Open in Obsidian via URI scheme (default, or set BWRB_DEFAULT_APP)
 * - editor: Open in $VISUAL or $EDITOR
 * - system: Open with system default (xdg-open/open/start)
 * - print: Just print the resolved path (for scripting)
 * 
 * If no query is provided, shows a picker with all vault files.
 */

import { Command } from 'commander';
import { exec, spawn } from 'child_process';
import { join, relative, basename } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolveVaultDir, isFile } from '../lib/vault.js';
import { loadSchema } from '../lib/schema.js';
import { printError, printSuccess, printInfo } from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes, exitWithResolutionError } from '../lib/output.js';
import { buildNoteIndex } from '../lib/navigation.js';
import { parsePickerMode, resolveAndPick, type PickerMode } from '../lib/picker.js';

// ============================================================================
// Types
// ============================================================================

export type AppMode = 'obsidian' | 'editor' | 'system' | 'print';

interface OpenOptions {
  app?: string;
  picker?: string;
  output?: string;
}

// ============================================================================
// Command Definition
// ============================================================================

export const openCommand = new Command('open')
  .description('Open a note by name or path query (alias for: search --open)')
  .argument('[query]', 'Note name, basename, or path to open (omit to browse all)')
  .option('--app <mode>', 'How to open: obsidian (default), editor, system, print')
  .option('--picker <mode>', 'Selection mode: auto (default), fzf, numbered, none')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .addHelpText('after', `
This command is an alias for: bwrb search <query> --open

App Modes:
  obsidian    Open in Obsidian via URI scheme (default)
  editor      Open in $VISUAL or $EDITOR
  system      Open with system default handler
  print       Print the resolved path (for scripting)

Picker Modes:
  auto        Use fzf if available, else numbered select (default)
  fzf         Force fzf (error if unavailable)
  numbered    Force numbered select
  none        Error on ambiguity (for non-interactive use)

Environment Variables:
  BWRB_DEFAULT_APP    Default app mode (obsidian, editor, system, print)

Examples:
  bwrb open                        # Browse all notes with picker
  bwrb open "My Note"              # Open by basename
  bwrb open Ideas/My\\ Note.md     # Open by path
  bwrb open "my note"              # Case-insensitive match
  bwrb open "My Note" --app editor # Open in $EDITOR
  bwrb open "My Note" --app print  # Just print path
  bwrb open "Amb" --picker none --output json  # Scripting mode

Equivalent search commands:
  bwrb open "My Note"              # = bwrb search "My Note" --open
  bwrb open "My Note" --app editor # = bwrb search "My Note" --open --app editor

Note: Obsidian must be running for --app obsidian to work.
      For --app editor, set $VISUAL or $EDITOR environment variable.`)
  .action(async (query: string | undefined, options: OpenOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const appMode = parseAppMode(options.app);
    const pickerMode = parsePickerMode(options.picker);

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
        prompt: 'Select note to open',
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(0);
        }
        exitWithResolutionError(result.error, result.candidates, jsonMode);
      }

      const targetFile = result.file;
      const fullPath = targetFile.path;

      // Verify file exists (it should, but be safe)
      if (!(await isFile(fullPath))) {
        const error = `File not found: ${fullPath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Open based on app mode
      switch (appMode) {
        case 'print':
          if (jsonMode) {
            printJson(jsonSuccess({
              path: fullPath,
              data: {
                relativePath: targetFile.relativePath,
                absolutePath: fullPath,
              },
            }));
          } else {
            console.log(fullPath);
          }
          break;

        case 'editor':
          await openInEditor(fullPath, jsonMode);
          break;

        case 'system':
          await openWithSystem(fullPath, jsonMode);
          break;

        case 'obsidian':
        default:
          await openInObsidian(vaultDir, fullPath, jsonMode);
          break;
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
 * Open a note using the configured app mode (respects BWRB_DEFAULT_APP).
 * This is the shared entry point for opening notes from other commands.
 * 
 * @param vaultDir - The vault directory path
 * @param filePath - Absolute path to the note file
 * @param appModeOverride - Optional app mode override (uses BWRB_DEFAULT_APP if not provided)
 * @param jsonMode - Whether to output JSON
 */
export async function openNote(
  vaultDir: string,
  filePath: string,
  appModeOverride?: string,
  jsonMode: boolean = false
): Promise<void> {
  const appMode = parseAppMode(appModeOverride);

  switch (appMode) {
    case 'print':
      console.log(filePath);
      break;
    case 'editor':
      await openInEditor(filePath, jsonMode);
      break;
    case 'system':
      await openWithSystem(filePath, jsonMode);
      break;
    case 'obsidian':
    default:
      await openInObsidian(vaultDir, filePath, jsonMode);
      break;
  }
}

export function parseAppMode(value: string | undefined): AppMode {
  // Use explicit value, then env var, then default to obsidian
  const effectiveValue = value ?? process.env['BWRB_DEFAULT_APP'];
  
  if (!effectiveValue) return 'obsidian';
  
  const normalized = effectiveValue.toLowerCase();
  if (normalized === 'editor') return 'editor';
  if (normalized === 'system') return 'system';
  if (normalized === 'print') return 'print';
  if (normalized === 'obsidian') return 'obsidian';
  return 'obsidian';
}

// ============================================================================
// Obsidian Opening
// ============================================================================

/**
 * Open a file in Obsidian using the obsidian:// URI scheme.
 */
export async function openInObsidian(
  vaultDir: string,
  filePath: string,
  jsonMode: boolean = false
): Promise<void> {
  const vaultName = await resolveVaultName(vaultDir);
  const relativePath = relative(vaultDir, filePath);

  // Build Obsidian URI
  const uri = buildObsidianUri(vaultName, relativePath);

  if (!jsonMode) {
    printInfo(`Opening in Obsidian: ${basename(filePath)}`);
  }

  // Open URI based on platform
  await openUri(uri);

  if (jsonMode) {
    printJson(jsonSuccess({
      message: 'Opened in Obsidian',
      path: filePath,
    }));
  } else {
    printSuccess('Opened in Obsidian');
  }
}

/**
 * Resolve the vault name from .obsidian/app.json or use directory name.
 */
async function resolveVaultName(vaultDir: string): Promise<string> {
  const appJsonPath = join(vaultDir, '.obsidian', 'app.json');

  if (existsSync(appJsonPath)) {
    try {
      const content = await readFile(appJsonPath, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;
      if (typeof config.vaultName === 'string') {
        return config.vaultName;
      }
    } catch {
      // Ignore errors, fall back to directory name
    }
  }

  return basename(vaultDir);
}

/**
 * Build an Obsidian URI for opening a file.
 */
function buildObsidianUri(vaultName: string, filePath: string): string {
  // Remove .md extension if present (Obsidian doesn't need it)
  const pathWithoutExt = filePath.replace(/\.md$/, '');

  // URI encode the components
  const encodedVault = encodeURIComponent(vaultName);
  const encodedFile = encodeURIComponent(pathWithoutExt);

  return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Open a URI using the system's default handler.
 */
async function openUri(uri: string): Promise<void> {
  const platform = process.platform;

  let command: string;
  if (platform === 'darwin') {
    command = `open "${uri}"`;
  } else if (platform === 'win32') {
    command = `start "" "${uri}"`;
  } else {
    command = `xdg-open "${uri}"`;
  }

  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        reject(new Error(`Failed to open Obsidian: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

// ============================================================================
// Editor Opening
// ============================================================================

/**
 * Open a file in the user's preferred editor ($VISUAL or $EDITOR).
 */
async function openInEditor(filePath: string, jsonMode: boolean): Promise<void> {
  const editor = process.env['VISUAL'] || process.env['EDITOR'];

  if (!editor) {
    throw new Error(
      'No editor configured. Set the VISUAL or EDITOR environment variable.'
    );
  }

  if (!jsonMode) {
    printInfo(`Opening in editor: ${basename(filePath)}`);
  }

  // Parse editor command (might be "code -w" or similar)
  const parts = editor.split(/\s+/);
  const cmd = parts[0]!;
  const args = [...parts.slice(1), filePath];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        if (jsonMode) {
          printJson(jsonSuccess({
            message: 'Opened in editor',
            path: filePath,
          }));
        } else {
          printSuccess('Opened in editor');
        }
        resolve();
      } else {
        reject(new Error(`Editor exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to open editor: ${err.message}`));
    });
  });
}

// ============================================================================
// System Opening
// ============================================================================

/**
 * Open a file with the system's default handler.
 */
async function openWithSystem(filePath: string, jsonMode: boolean): Promise<void> {
  if (!jsonMode) {
    printInfo(`Opening with system: ${basename(filePath)}`);
  }

  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    command = 'xdg-open';
    args = [filePath];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });

    proc.unref();

    proc.on('error', (err) => {
      reject(new Error(`Failed to open file: ${err.message}`));
    });

    // Give it a moment to start, then resolve
    setTimeout(() => {
      if (jsonMode) {
        printJson(jsonSuccess({
          message: 'Opened with system handler',
          path: filePath,
        }));
      } else {
        printSuccess('Opened with system handler');
      }
      resolve();
    }, 100);
  });
}
