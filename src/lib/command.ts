import type { Command } from 'commander';

/**
 * Global options available at the root command level.
 * These are defined on the main `bwrb` command and accessible from any subcommand.
 */
export interface GlobalOptions {
  vault?: string;
  output?: string;
}

/**
 * Get global options (like --vault, --output) from any command depth.
 * 
 * Uses Commander's optsWithGlobals() to safely access root options regardless
 * of how deeply nested the current command is. This replaces brittle patterns like:
 * 
 *   cmd.parent?.parent?.opts()           // 2 levels deep
 *   cmd.parent?.parent?.parent?.opts()   // 3 levels deep
 * 
 * With a single, consistent call that works at any nesting level.
 * 
 * Note: This function returns an object with truly optional properties (absent if
 * not set), rather than properties with undefined values. This is required for
 * compatibility with exactOptionalPropertyTypes in tsconfig.
 * 
 * @param cmd - The Command object passed to the action handler
 * @returns Global options with only defined properties included
 */
export function getGlobalOpts(cmd: Command): GlobalOptions {
  const opts = cmd.optsWithGlobals() as Record<string, unknown>;
  const result: GlobalOptions = {};
  if (typeof opts.vault === 'string') result.vault = opts.vault;
  if (typeof opts.output === 'string') result.output = opts.output;
  return result;
}
