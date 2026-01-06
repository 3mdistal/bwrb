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
import { loadSchema, detectObsidianVault } from "../lib/schema.js";
import { resolveVaultDir } from "../lib/vault.js";
import { getGlobalOpts } from "../lib/command.js";
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
import type { ResolvedConfig } from "../types/schema.js";

// App modes for opening notes
// - system: Open with OS default handler (default)
// - editor: Open in terminal editor ($EDITOR or config.editor)
// - visual: Open in GUI editor ($VISUAL or config.visual)
// - obsidian: Open via Obsidian URI
// - print: Print path to stdout (for scripting)
export type AppMode = "system" | "editor" | "visual" | "obsidian" | "print";

/**
 * Parse app mode from string. Returns undefined if value is undefined/empty,
 * allowing callers to apply their own defaults.
 */
export function parseAppMode(value?: string): AppMode | undefined {
  if (!value || value === "default") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const validModes: AppMode[] = ["system", "editor", "visual", "obsidian", "print"];
  if (validModes.includes(normalized as AppMode)) {
    return normalized as AppMode;
  }
  throw new Error(`Invalid app mode: ${value}. Must be one of: ${validModes.join(", ")}`);
}

/**
 * Resolve effective app mode using precedence:
 * 1. Explicit CLI flag (if provided)
 * 2. BWRB_DEFAULT_APP environment variable
 * 3. config.open_with from schema
 * 4. Fallback to 'system'
 */
export function resolveAppMode(
  cliValue: string | undefined,
  config: ResolvedConfig
): AppMode {
  // 1. Explicit CLI flag
  const parsed = parseAppMode(cliValue);
  if (parsed) {
    return parsed;
  }

  // 2. Environment variable
  const envValue = process.env.BWRB_DEFAULT_APP;
  if (envValue) {
    const envParsed = parseAppMode(envValue);
    if (envParsed) {
      return envParsed;
    }
  }

  // 3. Config default
  return config.openWith;
}

/**
 * Open a note in the specified application.
 * 
 * @param vaultDir - Vault root directory
 * @param notePath - Path to note relative to vault (or absolute)
 * @param appMode - How to open the note
 * @param config - Resolved config (needed for editor/visual/obsidian_vault settings)
 * @param jsonMode - Whether to output JSON
 */
export async function openNote(
  vaultDir: string,
  notePath: string,
  appMode: AppMode,
  config: ResolvedConfig,
  jsonMode: boolean = false
): Promise<void> {
  // Normalize path - if absolute, use as-is; if relative, join with vaultDir
  const fullPath = notePath.startsWith('/') ? notePath : join(vaultDir, notePath);
  const relativePath = notePath.startsWith('/') ? notePath.replace(vaultDir + '/', '') : notePath;

  switch (appMode) {
    case "print":
      if (jsonMode) {
        printJson({ success: true, data: { relativePath, fullPath } });
      } else {
        console.log(fullPath);
      }
      return;

    case "system":
      await openWithSystem(fullPath);
      if (jsonMode) {
        printJson({ success: true, data: { relativePath, fullPath, app: "system" } });
      }
      return;

    case "obsidian":
      await openInObsidian(vaultDir, relativePath, config);
      if (jsonMode) {
        printJson({ success: true, data: { relativePath, fullPath, app: "obsidian" } });
      }
      return;

    case "editor": {
      const editorCmd = config.editor;
      if (!editorCmd) {
        const error = "No terminal editor configured. Set $EDITOR or config.editor.";
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        exitWithError(error);
      }
      await openWithCommand(editorCmd!, fullPath, jsonMode);
      if (jsonMode) {
        printJson({ success: true, data: { relativePath, fullPath, app: editorCmd } });
      }
      return;
    }

    case "visual": {
      const visualCmd = config.visual;
      if (!visualCmd) {
        const error = "No GUI editor configured. Set $VISUAL or config.visual.";
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        exitWithError(error);
      }
      await openWithCommand(visualCmd!, fullPath, jsonMode);
      if (jsonMode) {
        printJson({ success: true, data: { relativePath, fullPath, app: visualCmd } });
      }
      return;
    }
  }
}

/**
 * Open a file with the OS default handler.
 */
async function openWithSystem(fullPath: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  if (process.platform === "darwin") {
    await execAsync(`open "${fullPath}"`);
  } else if (process.platform === "win32") {
    await execAsync(`start "" "${fullPath}"`);
  } else {
    await execAsync(`xdg-open "${fullPath}"`);
  }
}

/**
 * Open a file with a specific command (editor/visual).
 */
async function openWithCommand(
  command: string,
  fullPath: string,
  _jsonMode: boolean
): Promise<void> {
  const child = spawn(command, [fullPath], {
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

/**
 * Open a note in Obsidian via URI scheme.
 * 
 * Vault name resolution (in order of precedence):
 * 1. config.obsidian_vault (explicit user config)
 * 2. Auto-detect from .obsidian folder presence (uses folder basename)
 * 3. Fallback to vault directory basename
 */
async function openInObsidian(
  vaultDir: string,
  notePath: string,
  config: ResolvedConfig
): Promise<void> {
  // Resolve vault name using precedence
  const vaultName = config.obsidianVault 
    ?? detectObsidianVault(vaultDir) 
    ?? basename(vaultDir);
  
  const encodedVault = encodeURIComponent(vaultName);
  const encodedFile = encodeURIComponent(notePath);
  const obsidianUri = `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;

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
  .description("Open a note (alias for search --open)")
  .argument("[query]", "Note name or path to open")
  .option("-a, --app <mode>", "Application to open with: system, editor, visual, obsidian, print")
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
  system    Open with OS default handler (default, uses config.open_with)
  editor    Open in terminal editor ($EDITOR or config.editor)
  visual    Open in GUI editor ($VISUAL or config.visual)
  obsidian  Open in Obsidian app (uses config.obsidian_vault or auto-detect)
  print     Print path to stdout (for scripting)

Picker Modes:
  fzf       Interactive fuzzy finder (default)
  numbered  Numbered list selection
  none      No picker - fail if ambiguous

Precedence (for default app):
  1. --app flag (explicit)
  2. BWRB_DEFAULT_APP environment variable
  3. config.open_with in .bwrb/schema.json
  4. Fallback: system

Examples:
  bwrb open "My Note"                   Open note (uses config default)
  bwrb open "My Note" --app obsidian    Open in Obsidian
  bwrb open "My Note" --app editor      Open in $EDITOR
  bwrb open --type task                 Pick from all tasks
  bwrb open --where "status=active"     Pick from active notes
  bwrb open -t task -w "priority=high"  Open high-priority task
  bwrb open --body "TODO"               Find and open note containing TODO
`
  )
  .action(async (query: string | undefined, options: OpenOptions, cmd) => {
    const jsonMode = options.output === "json";

    try {
      // Merge global options with command options (local --vault takes precedence)
      const globalOpts = getGlobalOpts(cmd);
      const effectiveVault = options.vault || globalOpts.vault;
      const vaultDir = resolveVaultDir(effectiveVault ? { vault: effectiveVault } : {});
      const schema = await loadSchema(vaultDir);

      // Parse picker mode
      const pickerMode = parsePickerMode(options.picker || "fzf");

      // Resolve app mode using precedence: CLI > env > config > default
      const appMode = resolveAppMode(options.app, schema.config);

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
      await openNote(vaultDir, result.file.relativePath, appMode, schema.config, jsonMode);
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
