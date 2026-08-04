import { Command } from 'commander';
import { getGlobalOpts } from '../../lib/command.js';
import {
  IdentityMigrationBlockedError,
  migrateIdentityStore,
} from '../../lib/identity-migration.js';
import { ExitCodes, jsonError, printJson } from '../../lib/output.js';
import { printError, printInfo, printSuccess } from '../../lib/prompt.js';
import { loadSchema } from '../../lib/schema.js';
import type { NoteIdentityStore } from '../../lib/note-id.js';
import { resolveVaultDirWithSelection } from '../../lib/vaultSelection.js';

interface IdentityMigrateOptions {
  to?: string;
  dryRun?: boolean;
  execute?: boolean;
  output?: string;
}

const migrateCommand = new Command('migrate')
  .description('Migrate stable note identity storage after a guarded vault preflight')
  .requiredOption('--to <store>', 'Target store: frontmatter-v1 or registry-v1')
  .option('--dry-run', 'Preview the migration (default)')
  .option('-x, --execute', 'Apply the migration after revalidation')
  .option('--output <format>', 'Output format: text or json', 'text')
  .addHelpText('after', `
Examples:
  bwrb identity migrate --to frontmatter-v1 --dry-run --output json
  bwrb identity migrate --to frontmatter-v1 --execute --output json
  bwrb identity migrate --to registry-v1 --execute --output json
`)
  .action(async (options: IdentityMigrateOptions, command: Command) => {
    const jsonMode = options.output === 'json';
    try {
      if (options.output !== 'text' && options.output !== 'json') {
        throw new Error('--output must be text or json.');
      }
      if (options.execute === true && options.dryRun === true) {
        throw new Error('--execute cannot be combined with --dry-run.');
      }
      if (options.to !== 'frontmatter-v1' && options.to !== 'registry-v1') {
        throw new Error('--to must be frontmatter-v1 or registry-v1.');
      }

      const globalOpts = getGlobalOpts(command);
      const vaultDir = await resolveVaultDirWithSelection({
        ...(globalOpts.vault ? { vault: globalOpts.vault } : {}),
        allowFindDown: true,
        jsonMode,
      });
      const schema = await loadSchema(vaultDir);
      const result = await migrateIdentityStore(
        schema,
        vaultDir,
        options.to as NoteIdentityStore,
        options.execute === true
      );

      if (jsonMode) {
        printJson({ success: true, ...result });
        return;
      }
      const verb = result.mode === 'execute' ? 'Migrated' : 'Dry run: would migrate';
      const message = `${verb} identity storage ${result.from} -> ${result.to}`;
      if (result.mode === 'execute') printSuccess(message);
      else printInfo(message);
      printInfo(
        `Notes: ${result.notes.total} total, ${result.notes.valid} valid, ` +
        `${result.blockers.length} blocker(s)`
      );
      for (const blocker of result.blockers) {
        printInfo(`  ${blocker.code}: ${blocker.path}`);
      }
      if (result.mode === 'dry-run' && result.blockers.length === 0 && result.changes.length > 0) {
        printInfo('Run again with --execute to apply these changes.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const data = error instanceof IdentityMigrationBlockedError
        ? { blockers: error.blockers }
        : undefined;
      if (jsonMode) printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR, data }));
      else printError(message);
      process.exitCode = ExitCodes.VALIDATION_ERROR;
    }
  });

export const identityCommand = new Command('identity')
  .description('Inspect and migrate stable note identity storage')
  .addCommand(migrateCommand);
