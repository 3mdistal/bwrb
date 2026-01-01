#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new.js';
import { editCommand } from './commands/edit.js';
import { deleteCommand } from './commands/delete.js';
import { listCommand } from './commands/list.js';
import { openCommand } from './commands/open.js';
import { searchCommand } from './commands/search.js';
import { schemaCommand } from './commands/schema.js';
import { auditCommand } from './commands/audit.js';
import { bulkCommand } from './commands/bulk.js';
import { templateCommand } from './commands/template.js';

const program = new Command();

program
  .name('pika')
  .description('Schema-driven note management for markdown vaults')
  .version('0.2.0')
  .option('-v, --vault <path>', 'Path to the vault directory');

program.addCommand(newCommand);
program.addCommand(editCommand);
program.addCommand(deleteCommand);
program.addCommand(listCommand);
program.addCommand(openCommand);
program.addCommand(searchCommand);
program.addCommand(schemaCommand);
program.addCommand(auditCommand);
program.addCommand(bulkCommand);
program.addCommand(templateCommand);

program.parse();
