/**
 * Shared note-opening helpers for canonical commands.
 *
 * @module
 */

import { basename, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { detectObsidianVault } from "../lib/schema.js";
import {
  printJson,
  jsonError,
  exitWithError,
  ExitCodes,
} from "../lib/output.js";
import type { ResolvedConfig } from "../types/schema.js";

// App modes for opening notes
// - system: Open with OS default handler (default)
// - editor: Open in terminal editor ($EDITOR or config.editor)
// - visual: Open in GUI editor ($VISUAL or config.visual)
// - obsidian: Open via Obsidian URI
// - print: Print path to stdout (for scripting)
export type AppMode = "system" | "editor" | "visual" | "obsidian" | "print";

export interface OpenPathData {
  relativePath: string;
  fullPath: string;
}
export interface OpenResultData extends OpenPathData {
  app?: string;
}

export class OpenConfigurationError extends Error {}

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

function resolveOpenPath(vaultDir: string, notePath: string): OpenPathData {
  const fullPath = isAbsolute(notePath) ? resolve(notePath) : resolve(vaultDir, notePath);
  return {
    relativePath: relative(vaultDir, fullPath),
    fullPath,
  };
}

function missingOpenAppMessage(appMode: AppMode): string | undefined {
  if (appMode === "editor") {
    return "No terminal editor configured. Set $EDITOR or config.editor.";
  }
  if (appMode === "visual") {
    return "No GUI editor configured. Set $VISUAL or config.visual.";
  }
  return undefined;
}

function resolveOpenAppMetadata(appMode: AppMode, config: ResolvedConfig): string | undefined {
  switch (appMode) {
    case "print":
      return undefined;
    case "system":
      return "system";
    case "obsidian":
      return "obsidian";
    case "editor":
      if (!config.editor) {
        throw new OpenConfigurationError(missingOpenAppMessage(appMode)!);
      }
      return config.editor;
    case "visual":
      if (!config.visual) {
        throw new OpenConfigurationError(missingOpenAppMessage(appMode)!);
      }
      return config.visual;
  }
}

export function getOpenResultData(
  vaultDir: string,
  notePath: string,
  appMode: AppMode,
  config: ResolvedConfig
): OpenResultData {
  const pathData = resolveOpenPath(vaultDir, notePath);
  const app = resolveOpenAppMetadata(appMode, config);
  return app ? { ...pathData, app } : pathData;
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
  let openData: OpenResultData;
  try {
    openData = getOpenResultData(vaultDir, notePath, appMode, config);
  } catch (err) {
    if (err instanceof OpenConfigurationError) {
      if (jsonMode) {
        printJson(jsonError(err.message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      exitWithError(err.message);
    }
    throw err;
  }

  switch (appMode) {
    case "print":
      if (jsonMode) {
        printJson({ success: true, data: openData });
      } else {
        console.log(openData.fullPath);
      }
      return;

    case "system":
      await openWithSystem(openData.fullPath);
      if (jsonMode) {
        printJson({ success: true, data: openData });
      }
      return;

    case "obsidian":
      await openInObsidian(vaultDir, openData.relativePath, config);
      if (jsonMode) {
        printJson({ success: true, data: openData });
      }
      return;

    case "editor": {
      const editorCmd = openData.app!;
      await openWithCommand(editorCmd, openData.fullPath, jsonMode);
      if (jsonMode) {
        printJson({ success: true, data: openData });
      }
      return;
    }

    case "visual": {
      const visualCmd = openData.app!;
      await openWithCommand(visualCmd, openData.fullPath, jsonMode);
      if (jsonMode) {
        printJson({ success: true, data: openData });
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
