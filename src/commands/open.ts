/**
 * Open command - opens notes in editor or Obsidian
 *
 * This is an alias for `search --open`. It uses the unified targeting model
 * (--type, --path, --where, --body) to resolve notes, then opens them.
 *
 * @module
 */

import { Command } from "commander";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { loadSchema } from "../lib/schema.js";
import { resolveVaultDir } from "../lib/vault.js";
import { buildNoteIndex, type ManagedFile } from "../lib/navigation.js";
import { resolveAndPick, parsePickerMode } from "../lib/picker.js";
import {
  printJson,
  jsonError,
  exitWithError,
  ExitCodes,
  exitWithResolutionError,
} from "../lib/output.js";
import { resolveTargets, type TargetingOptions } from "../lib/targeting.js";

// App modes for opening notes
export type AppMode = "editor" | "obsidian" | "print";

/**
 * Parse app mode from string
 */
export function parseAppMode(value?: string): AppMode {
  // Default to editor mode, respecting BWRB_DEFAULT_APP env var
  const effectiveValue = value || process.env.BWRB_DEFAULT_APP || 'editor';
  const normalized = effectiveValue.toLowerCase();
  if (normalized === "editor" || normalized === "obsidian" || normalized === "print") {
    return normalized;
  }
  throw new Error(`Invalid app mode: ${effectiveValue}. Must be 'editor', 'obsidian', or 'print'.`);
}

/**
 * Open a note in the specified application
 */
export async function openNote(
  vaultDir: string,
  notePath: string,
  appMode: AppMode,
  jsonMode: boolean = false
): Promise<void> {
  const fullPath = join(vaultDir, notePath);

  if (appMode === "print") {
    if (jsonMode) {
      printJson({ success: true, data: { relativePath: notePath, fullPath } });
    } else {
      console.log(fullPath);
    }
    return;
  }

  if (appMode === "obsidian") {
    await openInObsidian(vaultDir, notePath);
    if (jsonMode) {
      printJson({ success: true, data: { relativePath: notePath, fullPath, app: "obsidian" } });
    }
  } else {
    const editor = process.env['EDITOR'] || process.env['VISUAL'];
    if (!editor) {
      if (jsonMode) {
        jsonError("No editor configured. Set EDITOR or VISUAL environment variable.");
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      exitWithError("No editor configured. Set EDITOR or VISUAL environment variable.");
    }
    const child = spawn(editor, [fullPath], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          if (jsonMode) {
            printJson({ success: true, data: { relativePath: notePath, fullPath, app: editor } });
          }
          resolve();
        } else {
          reject(new Error(`Editor exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }
}

/**
 * Open a note in Obsidian
 */
export async function openInObsidian(
  vaultDir: string,
  notePath: string
): Promise<void> {
  const vaultName = basename(vaultDir);
  const encodedFile = encodeURIComponent(notePath);
  const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedFile}`;

  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  if (process.platform === "darwin") {
    await execAsync(`open "${obsidianUri}"`);
  } else if (process.platform === "win32") {
    await execAsync(`start "" "${obsidianUri}"`);
  } else {
    await execAsync(`xdg-open "${obsidianUri}"`);
  }
}

interface OpenOptions {
  app?: string;
  picker?: string;
  output?: string;
  preview?: boolean;
  type?: string;
  path?: string;
  where?: string[];
  body?: string;
  vault?: string;
}

export const openCommand = new Command("open")
  .description("Open a note in editor or Obsidian (alias for search --open)")
  .argument("[query]", "Note name or path to open")
  .option("-a, --app <mode>", "Application to open with: editor, obsidian, print", "editor")
  .option("--picker <mode>", "Picker mode: fzf, numbered, none", "fzf")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .option("--preview", "Show preview in fzf picker")
  .option("-t, --type <type>", "Filter by note type (e.g., task, objective/milestone)")
  .option("-p, --path <glob>", "Filter by path pattern")
  .option("-w, --where <expr...>", "Filter by frontmatter expression")
  .option("-b, --body <pattern>", "Filter by body content pattern")
  .option("--vault <path>", "Path to vault directory")
  .addHelpText(
    "after",
    `
App Modes:
  editor    Open in $EDITOR (default)
  obsidian  Open in Obsidian app
  print     Print path to stdout (for scripting)

Picker Modes:
  fzf       Interactive fuzzy finder (default)
  numbered  Numbered list selection
  none      No picker - fail if ambiguous

Environment:
  BWRB_DEFAULT_APP  Default app mode (editor, obsidian, print)

Examples:
  bwrb open "My Note"              Open note by name
  bwrb open "My Note" --app obsidian  Open in Obsidian
  bwrb open --type task            Pick from all tasks
  bwrb open --where "status=active" Pick from active notes
  bwrb open -t task -w "priority=high"  Open high-priority task
  bwrb open --body "TODO"          Find and open note containing TODO
`
  )
  .action(async (query: string | undefined, options: OpenOptions, cmd) => {
    const jsonMode = options.output === "json";

    try {
      // Merge parent options (global --vault) with command options
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const effectiveVault = options.vault || parentOpts?.vault;
      const vaultDir = resolveVaultDir(effectiveVault ? { vault: effectiveVault } : {});
      const schema = await loadSchema(vaultDir);

      // Parse picker mode
      const pickerMode = parsePickerMode(options.picker || "fzf");

      // Parse app mode
      const appMode = parseAppMode(options.app || "editor");

      // Check if we have any targeting options
      const hasTargeting = options.type || options.path || options.where?.length || options.body;

      let filteredIndex;

      if (hasTargeting) {
        // Use the unified targeting system for filtering
        // Build targeting options, only including defined values
        const targeting: TargetingOptions = {};
        if (options.type) targeting.type = options.type;
        if (options.path) targeting.path = options.path;
        if (options.where?.length) targeting.where = options.where;
        if (options.body) targeting.body = options.body;

        const targetResult = await resolveTargets(targeting, schema, vaultDir);

        if (targetResult.error) {
          if (jsonMode) {
            printJson(jsonError(targetResult.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          } else {
            console.error(targetResult.error);
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
        }

        // Build a filtered index from the targeted files
        const byPath = new Map<string, ManagedFile>();
        const byBasename = new Map<string, ManagedFile[]>();

        for (const file of targetResult.files) {
          byPath.set(file.relativePath, file);
          const name = basename(file.relativePath, ".md");
          const existing = byBasename.get(name) || [];
          existing.push(file);
          byBasename.set(name, existing);
        }

        filteredIndex = { byPath, byBasename, allFiles: targetResult.files as ManagedFile[] };
      } else {
        // No targeting - use full note index
        filteredIndex = await buildNoteIndex(schema, vaultDir);
      }

      // Resolve note using shared picker logic
      // In JSON mode, don't use interactive picker - fail on ambiguity instead
      const effectivePickerMode = jsonMode ? "none" : pickerMode;
      const result = await resolveAndPick(filteredIndex, query, {
        pickerMode: effectivePickerMode,
        prompt: "Select note to open",
        preview: options.preview,
        vaultDir,
      });

      if (!result.ok) {
        if (result.cancelled) {
          process.exit(ExitCodes.SUCCESS);
        }
        // Extract error info for exitWithResolutionError
        const candidates = result.candidates?.map((c) => ({ relativePath: c.relativePath }));
        exitWithResolutionError(result.error || "No match found", candidates, jsonMode);
      }

      // Open the selected note
      await openNote(vaultDir, result.file.relativePath, appMode, jsonMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      } else {
        console.error(message);
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
    }
  });
