import chalk from 'chalk';

/**
 * Output format options for list command.
 * 'text' is an alias for 'default' (the standard table/name output).
 */
export type ListOutputFormat = 'default' | 'text' | 'paths' | 'tree' | 'link' | 'json';

/**
 * Output format options for search command.
 * 'text' is an alias for 'default' (filename + matching lines).
 */
export type SearchOutputFormat = 'default' | 'text' | 'paths' | 'link' | 'content' | 'json';

/**
 * Emit a deprecation warning to stderr.
 * Warnings go to stderr so they don't interfere with piped output.
 */
export function warnDeprecated(oldFlag: string, newUsage: string): void {
  console.error(chalk.yellow(`Warning: ${oldFlag} is deprecated, use ${newUsage} instead`));
}

/**
 * JSON output wrapper for success results.
 */
export interface JsonSuccess<T = unknown> {
  success: true;
  data?: T;
  path?: string;
  updated?: string[];
  message?: string;
}

/**
 * JSON output wrapper for error results.
 */
export interface JsonError {
  success: false;
  error: string;
  errors?: Array<{
    field: string;
    value?: unknown;
    message: string;
    expected?: string[] | string;
    suggestion?: string;
  }>;
  code?: number;
}

/**
 * Combined JSON result type.
 */
export type JsonResult<T = unknown> = JsonSuccess<T> | JsonError;

/**
 * Exit codes for the CLI.
 */
export const ExitCodes = {
  SUCCESS: 0,
  VALIDATION_ERROR: 1,
  IO_ERROR: 2,
  SCHEMA_ERROR: 3,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

/**
 * Print output as JSON.
 */
export function printJson(data: JsonResult): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Create a success JSON response.
 */
export function jsonSuccess<T = unknown>(
  options: Omit<JsonSuccess<T>, 'success'> = {}
): JsonSuccess<T> {
  return { success: true, ...options };
}

/**
 * Create an error JSON response.
 */
export function jsonError(
  error: string,
  options: Omit<JsonError, 'success' | 'error'> = {}
): JsonError {
  return { success: false, error, ...options };
}

/**
 * Exit with appropriate code and output.
 */
export function exitWithError(
  message: string,
  code: ExitCode = ExitCodes.VALIDATION_ERROR,
  jsonMode: boolean = false
): never {
  if (jsonMode) {
    printJson(jsonError(message, { code }));
  } else {
    console.error(chalk.red(message));
  }
  process.exit(code);
}

/**
 * Exit with a standardized cancellation response.
 */
export function exitWithCancel(jsonMode: boolean): never {
  if (jsonMode) {
    printJson(jsonError('Cancelled', { code: ExitCodes.VALIDATION_ERROR }));
  } else {
    console.log('Cancelled.');
  }
  process.exit(ExitCodes.VALIDATION_ERROR);
}

/**
 * A candidate file for error reporting (minimal interface).
 */
export interface ErrorCandidate {
  relativePath: string;
}

export interface VaultErrorDetails {
  cwd: string;
  candidates: string[];
  truncated?: boolean;
}

/**
 * Exit with a resolution error, optionally showing candidates.
 * 
 * Used by open/link commands when query resolution fails.
 * In JSON mode, candidates are included in the errors array.
 * In text mode, candidates are listed after the error message.
 */
export function exitWithResolutionError(
  error: string,
  candidates: ErrorCandidate[] | undefined,
  jsonMode: boolean
): never {
  if (jsonMode) {
    const errorDetails = candidates
      ? {
          errors: candidates.map(c => ({
            field: 'candidate',
            value: c.relativePath,
            message: 'Matching file',
          })),
        }
      : {};
    printJson(jsonError(error, errorDetails));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  console.error(chalk.red(error));
  if (candidates && candidates.length > 0) {
    console.error('\nMatching files:');
    for (const c of candidates) {
      console.error(`  ${c.relativePath}`);
    }
  }
  process.exit(1);
}

/**
 * Exit with a vault resolution error, optionally showing candidates.
 *
 * In JSON mode, candidates are included in the errors array.
 * In text mode, candidates are listed after the error message.
 */
export function exitWithVaultResolutionError(
  details: VaultErrorDetails,
  jsonMode: boolean
): never {
  const error = `Multiple vaults found under ${details.cwd}. Re-run with --vault <path>.`;

  if (jsonMode) {
    const errors = details.candidates.map(candidate => ({
      field: 'candidate',
      value: candidate,
      message: 'Candidate vault',
    }));
    printJson(jsonError(error, { code: ExitCodes.VALIDATION_ERROR, errors }));
    process.exit(ExitCodes.VALIDATION_ERROR);
  }

  console.error(chalk.red(error));
  if (details.candidates.length > 0) {
    console.error('\nCandidate vaults:');
    for (const candidate of details.candidates) {
      console.error(`  ${candidate}`);
    }
    if (details.truncated) {
      console.error('  (truncated)');
    }
  }
  process.exit(ExitCodes.VALIDATION_ERROR);
}
