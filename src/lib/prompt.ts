import prompts from 'prompts';
import chalk from 'chalk';
import { numberedSelect } from './numberedSelect.js';

/**
 * Prompt Module Architecture
 * ==========================
 * 
 * This module provides unified interactive prompts for bwrb commands.
 * All prompt functions return `null` when the user cancels (Ctrl+C / Escape),
 * allowing callers to distinguish cancellation from valid input.
 * 
 * Two underlying implementations:
 * 
 * 1. **numberedSelect** (src/lib/numberedSelect.ts)
 *    - Custom TTY-based selection UI
 *    - Supports number keys (1-9, 0) for immediate selection
 *    - Arrow key navigation with Enter to confirm
 *    - Pagination (-/+/=) for lists > 10 items
 *    - Used by: promptSelection
 * 
 * 2. **prompts** (npm package)
 *    - Lightweight library for simple confirm/text inputs
 *    - Returns `{}` on Ctrl+C (response.value === undefined)
 *    - Used by: promptConfirm, promptInput, promptMultiInput, promptRequired
 * 
 * Cancellation Contract
 * ---------------------
 * - All prompt functions return `T | null` where `null` means user cancelled
 * - Callers should use `=== null` checks (not truthiness) since `false` and `''`
 *   are valid non-cancelled values
 * - Ctrl+C means "quit the entire operation", not just "skip this question"
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result type for all prompts: the value T, or null if cancelled.
 */
export type PromptResult<T> = T | null;

// ============================================================================
// Selection Prompts (powered by numberedSelect)
// ============================================================================

/**
 * Prompt for selection from a list of options.
 * Returns the selected value, or null if user cancels (Ctrl+C/Escape).
 * 
 * Features:
 * - Number keys (1-9, 0) for immediate selection
 * - Arrow keys for navigation (Enter to confirm)
 * - -/+/= for page navigation when > 10 options
 */
export async function promptSelection(
  message: string,
  options: string[]
): Promise<PromptResult<string>> {
  return numberedSelect(message, options);
}

// ============================================================================
// Text Input Prompts (powered by prompts npm package)
// ============================================================================

/**
 * Prompt for text input.
 * Returns the entered string, or null if user cancels (Ctrl+C/Escape).
 */
export async function promptInput(
  message: string,
  defaultValue?: string
): Promise<PromptResult<string>> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message,
    initial: defaultValue,
  });

  // prompts returns {} on Ctrl+C, so response.value is undefined
  if (response.value === undefined) {
    return null; // User cancelled
  }
  return response.value as string;
}

/**
 * Prompt for required text input (loops until non-empty).
 * Returns the entered string, or null if user cancels (Ctrl+C/Escape).
 */
export async function promptRequired(message: string): Promise<PromptResult<string>> {
  while (true) {
    const response = await prompts({
      type: 'text',
      name: 'value',
      message: `${message} (required)`,
      validate: (v: string) => v.trim() ? true : 'This field is required',
    });

    // prompts returns {} on Ctrl+C, so response.value is undefined
    if (response.value === undefined) {
      return null; // User cancelled
    }

    const value = (response.value as string).trim();
    if (value) {
      return value;
    }
    // Empty value - loop continues (validation message shown by prompts)
  }
}

/**
 * Prompt for multi-line input (comma-separated).
 * Returns the array of entered values, or null if user cancels (Ctrl+C/Escape).
 * An empty input (just pressing Enter) returns an empty array, not null.
 */
export async function promptMultiInput(message: string): Promise<PromptResult<string[]>> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message: `${message} (comma-separated)`,
  });

  // prompts returns {} on Ctrl+C, so response.value is undefined
  if (response.value === undefined) {
    return null; // User cancelled
  }

  const value = response.value as string;
  if (!value) return []; // Empty input is valid (not cancelled)

  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ============================================================================
// Confirmation Prompts (powered by prompts npm package)
// ============================================================================

/**
 * Prompt for confirmation.
 * Returns true (yes), false (no), or null (cancelled/quit via Ctrl+C).
 * 
 * IMPORTANT: Use `=== null` to check for cancellation, not truthiness,
 * since `false` is a valid non-cancelled answer.
 */
export async function promptConfirm(message: string): Promise<PromptResult<boolean>> {
  const response = await prompts({
    type: 'confirm',
    name: 'value',
    message,
    initial: false,
  });

  // prompts returns {} on Ctrl+C, so response.value is undefined
  if (response.value === undefined) {
    return null; // User cancelled - signal quit
  }
  return response.value as boolean;
}

// ============================================================================
// Output Helpers
// ============================================================================

/**
 * Print an error message.
 */
export function printError(message: string): void {
  console.error(chalk.red(message));
}

/**
 * Print a warning message.
 */
export function printWarning(message: string): void {
  console.error(chalk.yellow(message));
}

/**
 * Print a success message.
 */
export function printSuccess(message: string): void {
  console.log(chalk.green(message));
}

/**
 * Print an info message.
 */
export function printInfo(message: string): void {
  console.log(chalk.cyan(message));
}
