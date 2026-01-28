#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new.js';
import { editCommand } from './commands/edit.js';
import { deleteCommand } from './commands/delete.js';
import { listCommand } from './commands/list.js';
import { openCommand } from './commands/open.js';
import { searchCommand } from './commands/search.js';
import { schemaCommand } from './commands/schema/index.js';
import { auditCommand } from './commands/audit.js';
import { bulkCommand } from './commands/bulk.js';
import { templateCommand } from './commands/template.js';
import { completionCommand } from './commands/completion.js';
import { configCommand } from './commands/config.js';
import { dashboardCommand } from './commands/dashboard.js';
import { initCommand } from './commands/init.js';
import { handleCompletionRequest } from './lib/completion.js';
import { BWRB_VERSION } from './version.js';

const program = new Command();

// Handle --completions before normal parsing (hidden flag for shell completion)
const completionsIndex = process.argv.indexOf('--completions');
if (completionsIndex !== -1) {
  // Extract everything after --completions as the words to complete
  const completionArgs = process.argv.slice(completionsIndex + 1);
  
  // Extract --vault if present in the completion args
  const vaultIndex = completionArgs.indexOf('--vault');
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
    .option('-v, --vault <path>', 'Path to the vault directory')
    .enablePositionalOptions();

  // CRUD operations
  program.addCommand(newCommand);
  program.addCommand(editCommand);
  program.addCommand(deleteCommand);

  // Query operations
  program.addCommand(listCommand);
  program.addCommand(openCommand);
  program.addCommand(searchCommand);

  // Schema and management
  program.addCommand(schemaCommand);
  program.addCommand(auditCommand);
  program.addCommand(bulkCommand);
  program.addCommand(templateCommand);

  // Saved queries
  program.addCommand(dashboardCommand);

  // Meta/utility
  program.addCommand(initCommand);
  program.addCommand(configCommand);
  program.addCommand(completionCommand);

  program.parse();
}
