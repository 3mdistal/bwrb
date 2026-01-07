/**
 * Init Command
 * ============
 *
 * Initialize a new bwrb vault with initial configuration.
 *
 * Usage:
 *   bwrb init              - Interactive setup in current directory
 *   bwrb init /path/to/dir - Initialize at specific path
 *   bwrb init --yes        - Non-interactive with defaults
 *   bwrb init --force      - Overwrite existing .bwrb/ directory
 */

import { Command } from 'commander';
import { mkdir, rm, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';

import { detectObsidianVault } from '../lib/schema.js';
import { writeSchema } from '../lib/schema-writer.js';
import {
  promptSelection,
  promptInput,
  promptConfirm,
  printError,
  printSuccess,
  printWarning,
} from '../lib/prompt.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../lib/output.js';
import { UserCancelledError } from '../lib/errors.js';
import type { Schema, Config } from '../types/schema.js';

const BWRB_DIR = '.bwrb';
const SCHEMA_URL = 'https://bwrb.dev/schema.json';

interface InitOptions {
  yes?: boolean;
  force?: boolean;
  output?: string;
}

interface InitResult {
  vault: string;
  schema_path: string;
  config: {
    link_format: string;
    obsidian_vault?: string;
    editor?: string;
  };
}

export const initCommand = new Command('init')
  .description('Initialize a new bwrb vault')
  .argument('[path]', 'Path to initialize (defaults to current directory)')
  .option('-y, --yes', 'Skip prompts, use defaults')
  .option('-f, --force', 'Overwrite existing .bwrb/ directory')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .addHelpText(
    'after',
    `
Examples:
  bwrb init                    Initialize in current directory
  bwrb init ~/notes            Initialize at specific path
  bwrb init --yes              Non-interactive with defaults
  bwrb init --force            Overwrite existing configuration
  bwrb init --yes --output json   Machine-readable output`
  )
  .action(async (pathArg: string | undefined, options: InitOptions) => {
    const jsonMode = options.output === 'json';

    try {
      // Resolve vault path
      const vaultDir = pathArg ? resolve(pathArg) : process.cwd();
      const bwrbDir = join(vaultDir, BWRB_DIR);

      // Check if vault directory exists
      if (!existsSync(vaultDir)) {
        throw new Error(`Directory does not exist: ${vaultDir}`);
      }

      // Check for directory (not file)
      const vaultStat = await stat(vaultDir);
      if (!vaultStat.isDirectory()) {
        throw new Error(`Path is not a directory: ${vaultDir}`);
      }

      // Check for existing .bwrb/
      if (existsSync(bwrbDir)) {
        if (!options.force) {
          throw new Error(
            `Vault already initialized at ${vaultDir}\nUse --force to reinitialize.`
          );
        }

        // Force mode - show warning and get confirmation
        if (!options.yes) {
          const contents = await listBwrbContents(bwrbDir);
          if (contents.length > 0) {
            printWarning(`\nWarning: ${BWRB_DIR}/ already exists and contains:`);
            for (const item of contents) {
              console.log(`  - ${item}`);
            }
            console.log();

            const confirmed = await promptConfirm(
              'Continue? This will delete all existing configuration.'
            );
            if (confirmed === null) {
              throw new UserCancelledError();
            }
            if (!confirmed) {
              console.log('Aborted.');
              process.exit(0);
            }
          }
        }

        // Remove existing .bwrb/
        await rm(bwrbDir, { recursive: true });
      }

      // Gather configuration
      let linkFormat: 'wikilink' | 'markdown' = 'wikilink';
      let editor: string | undefined;

      if (!options.yes) {
        // Interactive mode

        // Link format
        const linkChoice = await promptSelection('Link format:', [
          'wikilink - [[Note Name]] (Obsidian-compatible)',
          'markdown - [Note Name](Note Name.md)',
        ]);
        if (linkChoice === null) {
          throw new UserCancelledError();
        }
        linkFormat = linkChoice.startsWith('wikilink') ? 'wikilink' : 'markdown';

        // Editor (optional)
        const envEditor = process.env.EDITOR || process.env.VISUAL;
        const editorInput = await promptInput(
          'Editor command (optional, press Enter to skip):',
          envEditor
        );
        if (editorInput === null) {
          throw new UserCancelledError();
        }
        editor = editorInput.trim() || undefined;
      }

      // Auto-detect Obsidian vault
      const obsidianVault = detectObsidianVault(vaultDir);

      // Build config
      const config: Config = {
        link_format: linkFormat,
      };

      if (obsidianVault) {
        config.obsidian_vault = obsidianVault;
      }

      if (editor) {
        config.editor = editor;
      }

      // Build schema
      const schema: Schema = {
        $schema: SCHEMA_URL,
        version: 2,
        config,
        types: {},
      };

      // Create .bwrb/ directory
      await mkdir(bwrbDir, { recursive: true });

      // Write schema.json
      await writeSchema(vaultDir, schema);

      const schemaPath = join(bwrbDir, 'schema.json');
      const result: InitResult = {
        vault: vaultDir,
        schema_path: schemaPath,
        config: {
          link_format: linkFormat,
          ...(obsidianVault && { obsidian_vault: obsidianVault }),
          ...(editor && { editor }),
        },
      };

      // Output result
      if (jsonMode) {
        printJson(jsonSuccess({ data: result }));
      } else {
        printSuccess(`\nInitialized bwrb vault at ${vaultDir}`);
        console.log(`\nConfiguration:`);
        console.log(`  Link format: ${chalk.cyan(linkFormat)}`);
        if (obsidianVault) {
          console.log(`  Obsidian vault: ${chalk.cyan(obsidianVault)} (auto-detected)`);
        }
        if (editor) {
          console.log(`  Editor: ${chalk.cyan(editor)}`);
        }
        console.log(`\nNext steps:`);
        console.log(`  ${chalk.gray('1.')} Create a type: ${chalk.cyan('bwrb schema new type')}`);
        console.log(`  ${chalk.gray('2.')} Create a note: ${chalk.cyan('bwrb new <type>')}`);
      }
    } catch (err) {
      if (err instanceof UserCancelledError) {
        if (jsonMode) {
          printJson(jsonError('Cancelled'));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(0);
      }

      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.IO_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

/**
 * List contents of .bwrb/ directory for display in force warning.
 */
async function listBwrbContents(bwrbDir: string): Promise<string[]> {
  const contents: string[] = [];

  try {
    const entries = await readdir(bwrbDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // List directory contents recursively (one level)
        const subEntries = await readdir(join(bwrbDir, entry.name));
        if (subEntries.length > 0) {
          contents.push(`${entry.name}/ (${subEntries.length} items)`);
        } else {
          contents.push(`${entry.name}/`);
        }
      } else {
        contents.push(entry.name);
      }
    }
  } catch {
    // If we can't read, just return empty
  }

  return contents;
}
