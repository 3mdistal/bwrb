#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new.js';
import { editCommand } from './commands/edit.js';
import { listCommand } from './commands/list.js';
import { openCommand } from './commands/open.js';
import { schemaCommand } from './commands/schema.js';
import { auditCommand } from './commands/audit.js';

const program = new Command();

program
  .name('ovault')
  .description('Schema-driven template creation and editing for Obsidian vaults')
  .version('2.0.0')
  .option('-v, --vault <path>', 'Path to the vault directory');

program.addCommand(newCommand);
program.addCommand(editCommand);
program.addCommand(listCommand);
program.addCommand(openCommand);
program.addCommand(schemaCommand);
program.addCommand(auditCommand);

program.parse();
