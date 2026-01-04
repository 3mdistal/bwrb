/**
 * Picker abstraction for selecting among candidate files.
 * 
 * Modes:
 * - auto: Use fzf if available and TTY, else use numberedSelect
 * - fzf: Force fzf (error if not available)
 * - numbered: Force numberedSelect
 * - none: Disallow ambiguity (for scripting/non-interactive use)
 */

import { spawn } from 'child_process';
import { numberedSelect } from './numberedSelect.js';
import type { ManagedFile } from './discovery.js';

// ============================================================================
// Types
// ============================================================================

export type PickerMode = 'auto' | 'fzf' | 'numbered' | 'none';

export interface PickerOptions {
  /** Which picker mode to use */
  mode: PickerMode;
  /** Prompt message to display */
  prompt?: string;
  /** Enable preview pane in fzf (requires fzf, ignored for numbered) */
  preview?: boolean;
  /** Vault directory path (needed for preview to resolve full paths) */
  vaultDir?: string | undefined;
}

export interface PickerResult {
  /** The selected file, or null if cancelled/no selection */
  selected: ManagedFile | null;
  /** Whether user explicitly cancelled (Ctrl+C, Escape) */
  cancelled: boolean;
  /** Error message if mode=none and multiple candidates */
  error?: string;
  /** Candidates that were available (for error reporting) */
  candidates?: ManagedFile[];
}

// ============================================================================
// Picker Implementation
// ============================================================================

/**
 * Check if fzf is available on the system.
 */
async function isFzfAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['fzf'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Check if we're running in an interactive terminal.
 */
function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Check if a command is available on the system.
 * Tries the command with --version to verify it works.
 */
async function isCommandAvailable(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// Cache for bat command availability (null = not checked, string = command name, false = not available)
let batCommand: string | false | null = null;

/**
 * Get the bat command if available (bat or batcat on some Linux distros).
 * Returns the command name or null if not available.
 */
async function getBatCommand(): Promise<string | null> {
  if (batCommand !== null) {
    return batCommand === false ? null : batCommand;
  }
  
  // Try 'bat' first (most common)
  if (await isCommandAvailable('bat')) {
    batCommand = 'bat';
    return 'bat';
  }
  
  // Try 'batcat' (Debian/Ubuntu package name)
  if (await isCommandAvailable('batcat')) {
    batCommand = 'batcat';
    return 'batcat';
  }
  
  batCommand = false;
  return null;
}

/**
 * Run fzf to pick from candidates.
 */
async function pickWithFzf(
  candidates: ManagedFile[],
  prompt: string,
  preview: boolean = false,
  vaultDir?: string
): Promise<ManagedFile | null> {
  // Build fzf args
  const fzfArgs = [
    '--prompt', `${prompt}: `,
    '--height', '40%',
    '--reverse',
    '--no-multi',
  ];

  // Add preview if enabled and we have a vault dir
  if (preview && vaultDir) {
    const batCmd = await getBatCommand();
    // Escape single quotes in vaultDir for shell safety
    const escapedVaultDir = vaultDir.replace(/'/g, "'\\''");
    // Use bat for syntax highlighting if available, otherwise cat
    // The preview command uses single quotes and proper escaping for paths with spaces
    const previewCmd = batCmd
      ? `${batCmd} --style=numbers --color=always --line-range=:100 -- '${escapedVaultDir}/'{}`
      : `cat -- '${escapedVaultDir}/'{}`; 
    fzfArgs.push('--preview', previewCmd);
    fzfArgs.push('--preview-window', 'right:50%:wrap');
  }

  return new Promise((resolve) => {
    const fzf = spawn('fzf', fzfArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let output = '';
    fzf.stdout.on('data', (data) => {
      output += data.toString();
    });

    // Write candidates to fzf stdin (relative paths)
    const input = candidates.map(c => c.relativePath).join('\n');
    fzf.stdin.write(input);
    fzf.stdin.end();

    fzf.on('close', (code) => {
      if (code === 0 && output.trim()) {
        const selected = output.trim();
        const match = candidates.find(c => c.relativePath === selected);
        resolve(match ?? null);
      } else {
        // User cancelled or no selection
        resolve(null);
      }
    });

    fzf.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Run numbered select to pick from candidates.
 */
async function pickWithNumbered(
  candidates: ManagedFile[],
  prompt: string
): Promise<ManagedFile | null> {
  const options = candidates.map(c => c.relativePath);
  const selected = await numberedSelect(prompt, options);
  
  if (selected === null) {
    return null;
  }
  
  const match = candidates.find(c => c.relativePath === selected);
  return match ?? null;
}

/**
 * Pick a file from a list of candidates.
 * 
 * @param candidates List of candidate files to choose from
 * @param options Picker options (mode, prompt)
 * @returns PickerResult with selected file or error info
 */
export async function pickFile(
  candidates: ManagedFile[],
  options: PickerOptions
): Promise<PickerResult> {
  const { mode, prompt = 'Select file', preview = false, vaultDir } = options;

  // Handle empty candidates
  if (candidates.length === 0) {
    return { selected: null, cancelled: false, error: 'No candidates to select from' };
  }

  // Handle single candidate - always return it directly
  if (candidates.length === 1) {
    return { selected: candidates[0]!, cancelled: false };
  }

  // Multiple candidates - behavior depends on mode
  switch (mode) {
    case 'none':
      // Non-interactive mode: error on ambiguity
      return {
        selected: null,
        cancelled: false,
        error: `Ambiguous query: ${candidates.length} matches found`,
        candidates,
      };

    case 'fzf': {
      // Force fzf
      if (!(await isFzfAvailable())) {
        return {
          selected: null,
          cancelled: false,
          error: 'fzf is not available',
          candidates,
        };
      }
      if (!isTTY()) {
        return {
          selected: null,
          cancelled: false,
          error: 'fzf requires an interactive terminal',
          candidates,
        };
      }
      const selected = await pickWithFzf(candidates, prompt, preview, vaultDir);
      return { selected, cancelled: selected === null };
    }

    case 'numbered': {
      // Force numbered select
      if (!isTTY()) {
        return {
          selected: null,
          cancelled: false,
          error: 'Interactive selection requires a terminal',
          candidates,
        };
      }
      const selected = await pickWithNumbered(candidates, prompt);
      return { selected, cancelled: selected === null };
    }

    case 'auto':
    default: {
      // Auto: prefer fzf if available + TTY, else numbered, else error
      if (!isTTY()) {
        return {
          selected: null,
          cancelled: false,
          error: 'Interactive selection requires a terminal. Use --picker none for non-interactive mode.',
          candidates,
        };
      }

      if (await isFzfAvailable()) {
        const selected = await pickWithFzf(candidates, prompt, preview, vaultDir);
        return { selected, cancelled: selected === null };
      } else {
        const selected = await pickWithNumbered(candidates, prompt);
        return { selected, cancelled: selected === null };
      }
    }
  }
}

/**
 * Parse picker mode from CLI option string.
 */
export function parsePickerMode(value: string | undefined): PickerMode {
  if (!value) return 'auto';
  
  const normalized = value.toLowerCase();
  if (normalized === 'fzf') return 'fzf';
  if (normalized === 'numbered') return 'numbered';
  if (normalized === 'none') return 'none';
  return 'auto';
}

// ============================================================================
// Resolve and Pick Helper
// ============================================================================

// Import here to avoid circular dependency at module load time
import { resolveNoteQuery, type NoteIndex } from './navigation.js';

export interface ResolveAndPickOptions {
  /** Picker mode to use */
  pickerMode: PickerMode;
  /** Prompt message for picker */
  prompt: string;
  /** Enable preview pane in fzf */
  preview?: boolean | undefined;
  /** Vault directory path (needed for preview) */
  vaultDir?: string | undefined;
}

/**
 * Result of resolveAndPick - either success with a file, cancellation, or error.
 */
export type ResolveAndPickResult =
  | { ok: true; file: ManagedFile }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string; candidates?: ManagedFile[] };

/**
 * Resolve a query to a file, using the picker if needed.
 * 
 * This handles the common pattern shared by open/link commands:
 * 1. No query → show all files in picker
 * 2. Query provided → resolve it
 * 3. Exact match → return directly
 * 4. Candidates → invoke picker
 * 5. No matches → return error
 * 
 * Returns a discriminated union:
 * - `{ ok: true, file }` on success
 * - `{ ok: false, cancelled: true }` if user cancelled picker
 * - `{ ok: false, cancelled: false, error, candidates? }` on error
 */
export async function resolveAndPick(
  index: NoteIndex,
  query: string | undefined,
  options: ResolveAndPickOptions
): Promise<ResolveAndPickResult> {
  const { pickerMode, prompt, preview = false, vaultDir } = options;

  if (!query) {
    // No query - show picker with all files
    if (index.allFiles.length === 0) {
      return { ok: false, cancelled: false, error: 'No notes found in vault' };
    }

    const pickerResult = await pickFile(index.allFiles, {
      mode: pickerMode,
      prompt,
      preview,
      vaultDir,
    });

    if (pickerResult.error) {
      const result: ResolveAndPickResult = {
        ok: false,
        cancelled: false,
        error: pickerResult.error,
      };
      if (pickerResult.candidates) {
        result.candidates = pickerResult.candidates;
      }
      return result;
    }

    if (pickerResult.cancelled || !pickerResult.selected) {
      return { ok: false, cancelled: true };
    }

    return { ok: true, file: pickerResult.selected };
  }

  // Query provided - resolve it
  const resolution = resolveNoteQuery(index, query);

  if (resolution.exact) {
    // Unambiguous match
    return { ok: true, file: resolution.exact };
  }

  if (resolution.candidates.length > 0) {
    // Ambiguous or fuzzy match - use picker
    const pickerResult = await pickFile(resolution.candidates, {
      mode: pickerMode,
      prompt,
      preview,
      vaultDir,
    });

    if (pickerResult.error) {
      const result: ResolveAndPickResult = {
        ok: false,
        cancelled: false,
        error: pickerResult.error,
      };
      if (pickerResult.candidates) {
        result.candidates = pickerResult.candidates;
      }
      return result;
    }

    if (pickerResult.cancelled || !pickerResult.selected) {
      return { ok: false, cancelled: true };
    }

    return { ok: true, file: pickerResult.selected };
  }

  // No matches at all
  return {
    ok: false,
    cancelled: false,
    error: `No matching notes found for: ${query}`,
  };
}
