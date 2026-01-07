/**
 * Config Command
 * ==============
 * 
 * Manage vault-wide configuration options.
 * 
 * Commands:
 *   config list [option]   - Show all or specific config
 *   config edit [option]   - Edit all or specific config
 */

import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';

import { loadSchema, detectObsidianVault } from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { promptSelection } from '../lib/prompt.js';
import { getGlobalOpts } from '../lib/command.js';
import type { Config } from '../types/schema.js';

const SCHEMA_PATH = '.bwrb/schema.json';

// Config option metadata
interface ConfigOptionMeta {
  key: keyof Config;
  label: string;
  description: string;
  options?: string[];
  default: string;
}

const CONFIG_OPTIONS: ConfigOptionMeta[] = [
  {
    key: 'link_format',
    label: 'Link Format',
    description: 'Format for relation links in frontmatter',
    options: ['wikilink', 'markdown'],
    default: 'wikilink',
  },
  {
    key: 'editor',
    label: 'Editor',
    description: 'Terminal editor command (defaults to $EDITOR)',
    default: '$EDITOR',
  },
  {
    key: 'visual',
    label: 'Visual',
    description: 'GUI editor command (defaults to $VISUAL)',
    default: '$VISUAL',
  },
  {
    key: 'open_with',
    label: 'Open With',
    description: 'Default behavior for --open flag',
    options: ['system', 'editor', 'visual', 'obsidian'],
    default: 'system',
  },
  {
    key: 'obsidian_vault',
    label: 'Obsidian Vault',
    description: 'Obsidian vault name for URI scheme (auto-detected if not set)',
    default: '(auto-detect)',
  },
  {
    key: 'default_dashboard',
    label: 'Default Dashboard',
    description: 'Dashboard to run when `bwrb dashboard` is called without arguments',
    default: '(none)',
  },
];

export const configCommand = new Command('config')
  .description('Manage vault-wide configuration');

// config list [option]
configCommand
  .command('list [option]')
  .description('Show configuration values')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (option: string | undefined, opts: { output?: string }, cmd: Command) => {
    const jsonMode = opts.output === 'json';
    
    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);
      const rawConfig = schema.raw.config ?? {};
      
      if (option) {
        // Show specific option
        const meta = CONFIG_OPTIONS.find(o => o.key === option);
        if (!meta) {
          if (jsonMode) {
            console.log(JSON.stringify({ success: false, error: `Unknown config option: ${option}` }));
          } else {
            console.error(chalk.red(`Unknown config option: ${option}`));
            console.log(`Available options: ${CONFIG_OPTIONS.map(o => o.key).join(', ')}`);
          }
          process.exit(1);
        }
        
        const value = getConfigValue(rawConfig, meta.key, vaultDir);
        
        if (jsonMode) {
          console.log(JSON.stringify({
            success: true,
            data: {
              key: meta.key,
              value,
              default: meta.default,
              description: meta.description,
            },
          }));
        } else {
          console.log(`${chalk.bold(meta.label)} (${meta.key})`);
          console.log(`  ${chalk.gray(meta.description)}`);
          console.log(`  Value: ${formatDisplayValue(value)}`);
          if (meta.options) {
            console.log(`  Options: ${meta.options.join(', ')}`);
          }
        }
      } else {
        // Show all options
        if (jsonMode) {
          const data: Record<string, unknown> = {};
          for (const meta of CONFIG_OPTIONS) {
            data[meta.key] = getConfigValue(rawConfig, meta.key, vaultDir);
          }
          console.log(JSON.stringify({ success: true, data }));
        } else {
          console.log(chalk.bold('Configuration:\n'));
          for (const meta of CONFIG_OPTIONS) {
            const value = getConfigValue(rawConfig, meta.key, vaultDir);
            console.log(`  ${chalk.cyan(meta.key)}: ${formatDisplayValue(value)}`);
            console.log(`    ${chalk.gray(meta.description)}`);
          }
        }
      }
    } catch (error) {
      if (jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(String(error)));
      }
      process.exit(1);
    }
  });

// config edit [option]
configCommand
  .command('edit [option]')
  .description('Edit configuration values')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--json <value>', 'Set value directly (JSON mode)')
  .action(async (option: string | undefined, opts: { output?: string; json?: string }, cmd: Command) => {
    const jsonMode = opts.output === 'json';
    
    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schemaPath = join(vaultDir, SCHEMA_PATH);
      
      // Load existing schema
      const content = await readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(content) as Record<string, unknown>;
      
      if (!schema.config) {
        schema.config = {};
      }
      const config = schema.config as Record<string, unknown>;
      
      if (opts.json !== undefined) {
        // Direct JSON value setting
        if (!option) {
          throw new Error('Option name required when using --json');
        }
        
        const meta = CONFIG_OPTIONS.find(o => o.key === option);
        if (!meta) {
          throw new Error(`Unknown config option: ${option}`);
        }
        
        const value = JSON.parse(opts.json);
        
        // Validate value
        if (meta.options && !meta.options.includes(String(value))) {
          throw new Error(`Invalid value for ${option}. Valid options: ${meta.options.join(', ')}`);
        }
        
        config[option] = value;
        await writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n');
        
        if (jsonMode) {
          console.log(JSON.stringify({ success: true, data: { key: option, value } }));
        } else {
          console.log(chalk.green(`Set ${option} = ${JSON.stringify(value)}`));
        }
      } else {
        // Interactive mode
        if (option) {
          // Edit specific option
          const meta = CONFIG_OPTIONS.find(o => o.key === option);
          if (!meta) {
            throw new Error(`Unknown config option: ${option}`);
          }
          
          const newValue = await promptConfigOption(meta, config[option]);
          if (newValue !== null) {
            if (newValue === '') {
              // Empty string means "clear" - delete the key
              delete config[option];
            } else {
              config[option] = newValue;
            }
            await writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n');
            
            if (jsonMode) {
              console.log(JSON.stringify({ success: true, data: { key: option, value: newValue || null } }));
            } else {
              if (newValue === '') {
                console.log(chalk.green(`Cleared ${option}`));
              } else {
                console.log(chalk.green(`Set ${option} = ${JSON.stringify(newValue)}`));
              }
            }
          }
        } else {
          // Show menu of options to edit
          const optionKeys = CONFIG_OPTIONS.map(o => o.key);
          const selected = await promptSelection('Select option to edit:', optionKeys);
          
          if (selected) {
            const meta = CONFIG_OPTIONS.find(o => o.key === selected)!;
            const newValue = await promptConfigOption(meta, config[selected]);
            if (newValue !== null) {
              if (newValue === '') {
                // Empty string means "clear" - delete the key
                delete config[selected];
              } else {
                config[selected] = newValue;
              }
              await writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n');
              
              if (jsonMode) {
                console.log(JSON.stringify({ success: true, data: { key: selected, value: newValue || null } }));
              } else {
                if (newValue === '') {
                  console.log(chalk.green(`Cleared ${selected}`));
                } else {
                  console.log(chalk.green(`Set ${selected} = ${JSON.stringify(newValue)}`));
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(String(error)));
      }
      process.exit(1);
    }
  });

/**
 * Get the effective config value, considering defaults.
 */
function getConfigValue(config: Partial<Config>, key: keyof Config, vaultDir: string): string | undefined {
  const value = config[key];
  if (value !== undefined) {
    return String(value);
  }
  
  // Return effective defaults
  switch (key) {
    case 'link_format':
      return 'wikilink';
    case 'editor':
      return process.env.EDITOR ?? undefined;
    case 'visual':
      return process.env.VISUAL ?? undefined;
    case 'open_with':
      return 'system';
    case 'obsidian_vault':
      return detectObsidianVault(vaultDir);
    case 'default_dashboard':
      return undefined; // No auto-detection for default_dashboard
    default:
      return undefined;
  }
}

/**
 * Format a value for display.
 */
function formatDisplayValue(value: string | undefined): string {
  if (value === undefined) {
    return chalk.gray('(not set)');
  }
  return chalk.green(value);
}

/**
 * Prompt for a config option value.
 */
async function promptConfigOption(meta: ConfigOptionMeta, currentValue: unknown): Promise<string | null> {
  if (meta.options) {
    // Select from options
    return promptSelection(
      `${meta.label} (current: ${currentValue ?? meta.default}):`,
      meta.options
    );
  } else {
    // Text input - for now just use selection to clear or keep
    const choices = ['(keep current)', '(clear)', '(enter new value)'];
    const choice = await promptSelection(`${meta.label}:`, choices);
    
    if (choice === '(keep current)' || choice === null) {
      return null;
    } else if (choice === '(clear)') {
      return ''; // Will be removed from config
    } else {
      // For text input, we'd need promptInput but let's keep it simple
      console.log(chalk.yellow(`Use --json flag to set custom values: bwrb config edit ${meta.key} --json '"value"'`));
      return null;
    }
  }
}
