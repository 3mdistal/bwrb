import { Command } from 'commander';
import { loadSchema } from '../../lib/schema.js';
import { resolveVaultDirWithSelection } from '../../lib/vaultSelection.js';
import { getGlobalOpts } from '../../lib/command.js';
import { ExitCodes, jsonError, printJson } from '../../lib/output.js';
import { printError, printInfo, printSuccess } from '../../lib/prompt.js';
import { adoptLineage } from './adopt.js';
import { ConcurrentNoteModificationError } from '../../lib/errors.js';
import { concurrentModificationData } from '../../lib/note-write-concurrency.js';

interface AdoptCommandOptions {
  from?: string;
  dryRun?: boolean;
  execute?: boolean;
  output?: string;
}

const adoptCommand = new Command('adopt')
  .description('Safely attach an existing note to known document lineage')
  .argument('<child>', 'Exact child path, basename, name, alias, or UUID')
  .option('--from <parent>', 'Exact immediate-source path, basename, name, alias, or UUID')
  .option('--dry-run', 'Preview the guarded mutation (default)')
  .option('-x, --execute', 'Apply the adoption after revalidation')
  .option('--output <format>', 'Output format (text or json)', 'text')
  .addHelpText('after', `
Examples:
  bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json
  bwrb lineage adopt "Child note" --from "Parent note" --execute --output json
`)
  .action(async (child: string, options: AdoptCommandOptions, command: Command) => {
    const jsonMode = options.output === 'json';
    let resolvedVaultDir: string | undefined;
    try {
      if (options.output !== 'text' && options.output !== 'json') {
        throw new Error('--output must be text or json.');
      }
      if (!options.from) {
        throw new Error('--from <parent> is required.');
      }
      if (options.execute === true && options.dryRun === true) {
        throw new Error('--execute cannot be combined with --dry-run.');
      }

      const globalOpts = getGlobalOpts(command);
      const vaultDir = await resolveVaultDirWithSelection({
        ...(globalOpts.vault ? { vault: globalOpts.vault } : {}),
        allowFindDown: true,
        jsonMode,
      });
      resolvedVaultDir = vaultDir;
      const schema = await loadSchema(vaultDir);
      const result = await adoptLineage(schema, vaultDir, {
        child,
        parent: options.from,
        execute: options.execute === true,
      });

      if (jsonMode) {
        printJson({ success: true, ...result });
        return;
      }

      const edge = `${result.child.path} -> ${result.parent.path}`;
      if (result.mode === 'dry-run') {
        printInfo(`Dry run: would adopt ${edge}`);
        printInfo('Run again with --execute to apply these changes.');
      } else {
        printSuccess(`Adopted lineage: ${edge}`);
      }
      for (const change of result.changes) {
        printInfo(`  ${change.status}: ${change.path} ${change.field}=${change.value}`);
      }
      for (const warning of result.warnings) printInfo(`Warning: ${warning}`);
      printInfo(
        `Bodies unchanged: child=${result.body_invariance.child.unchanged}, ` +
        `parent=${result.body_invariance.parent.unchanged}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ConcurrentNoteModificationError) {
        if (jsonMode) {
          printJson(jsonError(message, {
            code: ExitCodes.IO_ERROR,
            data: concurrentModificationData(resolvedVaultDir ?? process.cwd(), error),
          }));
        } else {
          printError(message);
        }
        process.exitCode = ExitCodes.IO_ERROR;
        return;
      }
      if (jsonMode) {
        printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR }));
      } else {
        printError(message);
      }
      process.exitCode = ExitCodes.VALIDATION_ERROR;
    }
  });

export const lineageCommand = new Command('lineage')
  .description('Manage immutable document lineage')
  .addCommand(adoptCommand);
