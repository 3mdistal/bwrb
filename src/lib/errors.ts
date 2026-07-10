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

/**
 * A note changed after a command's authoritative read but before its guarded
 * write. Callers must retry from a fresh snapshot rather than overwriting the
 * newer bytes.
 */
export class ConcurrentNoteModificationError extends Error {
  readonly path: string;
  readonly attempts: number;

  constructor(path: string, attempts = 1) {
    super('Note changed on disk during a guarded write; newer bytes were preserved. Retry the command.');
    this.name = 'ConcurrentNoteModificationError';
    this.path = path;
    this.attempts = attempts;
  }
}
