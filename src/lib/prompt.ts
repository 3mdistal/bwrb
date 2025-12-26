import prompts from 'prompts';
import chalk from 'chalk';

/**
 * Prompt for selection from a list of options.
 * Returns undefined if user cancels or skips.
 */
export async function promptSelection(
  message: string,
  options: string[]
): Promise<string | undefined> {
  const choices = options.map((opt, i) => ({
    title: opt,
    value: opt,
    description: `${i + 1}`,
  }));

  const response = await prompts({
    type: 'select',
    name: 'value',
    message,
    choices,
    hint: 'Use arrow keys, Enter to select',
  });

  return response.value as string | undefined;
}

/**
 * Prompt for text input.
 */
export async function promptInput(
  message: string,
  defaultValue?: string
): Promise<string> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message,
    initial: defaultValue,
  });

  return (response.value as string) ?? defaultValue ?? '';
}

/**
 * Prompt for required text input (loops until non-empty).
 */
export async function promptRequired(message: string): Promise<string> {
  let value = '';
  while (!value) {
    const response = await prompts({
      type: 'text',
      name: 'value',
      message: `${message} (required)`,
      validate: (v: string) => v.trim() ? true : 'This field is required',
    });

    value = (response.value as string)?.trim() ?? '';
    if (response.value === undefined) {
      // User cancelled
      process.exit(1);
    }
  }
  return value;
}

/**
 * Prompt for multi-line input (comma-separated).
 */
export async function promptMultiInput(message: string): Promise<string[]> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message: `${message} (comma-separated)`,
  });

  const value = response.value as string;
  if (!value) return [];

  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Prompt for confirmation.
 */
export async function promptConfirm(message: string): Promise<boolean> {
  const response = await prompts({
    type: 'confirm',
    name: 'value',
    message,
    initial: false,
  });

  return response.value as boolean;
}

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
