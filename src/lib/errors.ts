/**
 * Shared error types for bwrb commands.
 */

/**
 * Thrown when the user cancels an interactive prompt (Ctrl+C / Escape).
 *
 * Prompt functions in src/lib/prompt.ts return `null` on cancellation.
 * Commands throw UserCancelledError to propagate cancellation up the call
 * stack, where it's caught at the top level to print "Cancelled." and exit.
 *
 * @example
 * ```ts
 * const value = await promptInput('Enter name:');
 * if (value === null) throw new UserCancelledError();
 * ```
 */
export class UserCancelledError extends Error {
  constructor() {
    super('User cancelled');
    this.name = 'UserCancelledError';
  }
}
