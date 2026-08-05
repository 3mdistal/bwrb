#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new.js';
import { editCommand } from './commands/edit.js';
import { deleteCommand } from './commands/delete.js';
import { listCommand } from './commands/list.js';
import { recentCommand } from './commands/recent.js';
import { schemaCommand } from './commands/schema/index.js';
import { auditCommand } from './commands/audit.js';
import { bulkCommand } from './commands/bulk.js';
import { templateCommand } from './commands/template.js';
import { completionCommand } from './commands/completion.js';
import { lineageCommand } from './commands/lineage/index.js';
import { identityCommand } from './commands/identity/index.js';
import { configCommand } from './commands/config.js';
import { dashboardCommand } from './commands/dashboard.js';
import { initCommand } from './commands/init.js';
import { explainCommand } from './commands/explain.js';
import { priorityCommand } from './commands/priority.js';
import { handleCompletionRequest } from './lib/completion.js';
import { cleanupPromptMode } from './lib/prompt.js';
import { BWRB_VERSION } from './version.js';
import { configureLogicalActor } from './lib/logical-actor.js';

const program = new Command();

// Handle --completions before normal parsing (hidden flag for shell completion)
const completionsIndex = process.argv.indexOf('--completions');
if (completionsIndex !== -1) {
  // Extract everything after --completions as the words to complete
  const completionArgs = process.argv.slice(completionsIndex + 1);
  
  // Extract the global vault target if present in the completion args
  const vaultIndex = completionArgs.findIndex(arg => arg === '--vault' || arg === '-v');
  const vault = vaultIndex !== -1 ? completionArgs[vaultIndex + 1] : undefined;
  
  handleCompletionRequest(completionArgs, vault ? { vault } : {})
    .then(completions => {
      // Output one completion per line
      for (const c of completions) {
        console.log(c);
      }
      process.exit(0);
    })
    .catch(() => {
      // Fail silently for completions
      process.exit(0);
    });
} else {
  program
    .name('bwrb')
    .description('Schema-driven note management for markdown vaults')
    .version(BWRB_VERSION)
    .option(
      '-v, --vault <path>',
      'Vault directory (precedence: --vault, nearest ancestor, BWRB_VAULT, then discovery below cwd)'
    )
    .option('--non-interactive', 'Disable interactive prompts and require explicit non-interactive flags')
    .option('--actor <actor>', 'Logical workflow actor provenance (overrides BWRB_ACTOR)')
    .hook('preAction', (_thisCommand, actionCommand) => {
      const options = actionCommand.optsWithGlobals() as { actor?: string };
      configureLogicalActor(options.actor);
    })
    .hook('postAction', () => {
      cleanupPromptMode();
    })
    .enablePositionalOptions();

  // Help output order follows registration order.
  // See "Help Output Ordering" in docs/product/vision.md and the regression test
  // in tests/ts/commands/help-ordering.test.ts.
  // CRUD operations
  program.addCommand(newCommand);
  program.addCommand(editCommand);
  program.addCommand(deleteCommand);

  // Query operations
  program.addCommand(listCommand);
  program.addCommand(recentCommand);
  program.addCommand(explainCommand);
  program.addCommand(priorityCommand);

  // Schema and management
  program.addCommand(schemaCommand);
  program.addCommand(auditCommand);
  program.addCommand(bulkCommand);
  program.addCommand(templateCommand);
  program.addCommand(lineageCommand);
  program.addCommand(identityCommand);

  // Saved queries
  program.addCommand(dashboardCommand);

  // Meta/utility
  program.addCommand(initCommand);
  program.addCommand(configCommand);
  program.addCommand(completionCommand);

  program.parse();
}
