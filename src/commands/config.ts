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

import { loadCurrentSchema, detectObsidianVault, resolveSchema } from '../lib/schema.js';
import { SCHEMA_RELATIVE_PATH } from '../lib/bwrb-paths.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { configurePromptMode, promptInput, promptSelection } from '../lib/prompt.js';
import { getGlobalOpts } from '../lib/command.js';
import { ExitCodes } from '../lib/output.js';
import { BwrbSchema, type Config } from '../types/schema.js';
import { UserCancelledError } from '../lib/errors.js';

// Config option metadata
interface ConfigOptionMeta {
  key: keyof Config;
  label: string;
  description: string;
  options?: string[];
  default: unknown;
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
  {
    key: 'excluded_directories',
    label: 'Excluded Directories',
    description: 'Directory prefixes to exclude from discovery/targeting (applies to all commands)',
    default: [],
  },
  {
    key: 'date_format',
    label: 'Date Format',
    description: 'Format for date fields using YYYY, MM, and DD tokens',
    default: 'YYYY-MM-DD',
  },
  {
    key: 'date_granularity',
    label: 'Date Granularity',
    description: 'Default coarsest precision allowed for date fields',
    options: ['day', 'month', 'year'],
    default: 'day',
  },
  {
    key: 'mention_exclude_types',
    label: 'Mention Exclude Types',
    description: 'Type names to exclude as targets from unlinked-mention and frequent-term audit suggestions',
    default: [],
  },
  {
    key: 'mention_exclude_paths',
    label: 'Mention Exclude Paths',
    description: 'Vault-relative path globs to exclude as targets from unlinked-mention and frequent-term audit suggestions',
    default: [],
  },
  {
    key: 'mention_link_once',
    label: 'Mention Link Once',
    description: 'Limit audit --fix --auto unlinked-mention writes to one wikilink per note/target pair',
    default: false,
  },
];

/**
 * Config keys intentionally exposed by the command. This remains an explicit
 * allowlist: nested calendars and advanced mention tuning require dedicated
 * UX or direct schema editing rather than becoming writable by accident.
 */
export const CONFIG_OPTION_KEYS = CONFIG_OPTIONS.map((option) => option.key);

export const configCommand = new Command('config')
  .description('Manage vault-wide configuration');

// config list [option]
configCommand
  .command('list [option]')
  .description('Show configuration values')
  .option('--output <format>', 'Output format: text (default) or json')
  .action(async (option: string | undefined, opts: { output?: string }, cmd: Command) => {
    const jsonMode = opts.output === 'json';
    
    try {
      const globalOpts = getGlobalOpts(cmd);
      configurePromptMode({
        forcedNonInteractive: globalOpts.nonInteractive === true,
        bypassHint: 'Use config edit <option> --json <value> to update config without prompts.',
      });
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schema = await loadCurrentSchema(vaultDir);
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
      if (error instanceof UserCancelledError) {
        if (jsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Cancelled' }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
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
  .option('--output <format>', 'Output format: text (default) or json')
  .option('--json <value>', 'Set value directly (JSON mode)')
  .action(async (option: string | undefined, opts: { output?: string; json?: string }, cmd: Command) => {
    const jsonMode = opts.output === 'json';
    
    try {
      const globalOpts = getGlobalOpts(cmd);
      configurePromptMode({
        forcedNonInteractive: globalOpts.nonInteractive === true,
        bypassHint: 'Use config edit <option> --json <value> to update config without prompts.',
      });
      const vaultOptions: { vault?: string; jsonMode: boolean } = { jsonMode };
      if (globalOpts.vault) vaultOptions.vault = globalOpts.vault;
      const vaultDir = await resolveVaultDirWithSelection(vaultOptions);
      const schemaPath = join(vaultDir, SCHEMA_RELATIVE_PATH);

      if (globalOpts.nonInteractive && opts.json === undefined) {
        throw new Error('bwrb config edit requires an option name and --json <value> when --non-interactive is set.');
      }
      
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
        
        validateConfigValue(meta, value);
        
        const storedValue = normalizeConfigValue(meta.key, value);

        config[option] = storedValue;
        await writeValidatedSchema(schemaPath, schema);

        if (jsonMode) {
          console.log(JSON.stringify({ success: true, data: { key: option, value: storedValue } }));
        } else {
          console.log(chalk.green(`Set ${option} = ${JSON.stringify(storedValue)}`));
        }
      } else {
        // Interactive mode
        if (option) {
          // Edit specific option
          const meta = CONFIG_OPTIONS.find(o => o.key === option);
          if (!meta) {
            throw new Error(`Unknown config option: ${option}`);
          }
          
          const result = await promptConfigOption(meta, config[option]);
          if (result.action !== 'keep') {
            if (result.action === 'clear') {
              delete config[option];
            } else {
              config[option] = result.value;
            }
            await writeValidatedSchema(schemaPath, schema);

            const outputValue = result.action === 'clear' ? null : result.value;

            if (jsonMode) {
              console.log(JSON.stringify({ success: true, data: { key: option, value: outputValue } }));
            } else {
              if (result.action === 'clear') {
                console.log(chalk.green(`Cleared ${option}`));
              } else {
                console.log(chalk.green(`Set ${option} = ${JSON.stringify(outputValue)}`));
              }
            }
          }
        } else {
          // Show menu of options to edit
          const optionKeys = CONFIG_OPTIONS.map(o => o.key);
          const selected = await promptSelection('Select option to edit:', optionKeys);
          
          if (selected) {
            const meta = CONFIG_OPTIONS.find(o => o.key === selected)!;
            const result = await promptConfigOption(meta, config[selected]);
            if (result.action !== 'keep') {
              if (result.action === 'clear') {
                delete config[selected];
              } else {
                config[selected] = result.value;
              }
              await writeValidatedSchema(schemaPath, schema);

              const outputValue = result.action === 'clear' ? null : result.value;

              if (jsonMode) {
                console.log(JSON.stringify({ success: true, data: { key: selected, value: outputValue } }));
              } else {
                if (result.action === 'clear') {
                  console.log(chalk.green(`Cleared ${selected}`));
                } else {
                  console.log(chalk.green(`Set ${selected} = ${JSON.stringify(outputValue)}`));
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof UserCancelledError) {
        if (jsonMode) {
          console.log(JSON.stringify({ success: false, error: 'Cancelled' }));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        console.log('Cancelled.');
        process.exit(1);
      }
      if (jsonMode) {
        console.log(JSON.stringify({ success: false, error: String(error) }));
      } else {
        console.error(chalk.red(String(error)));
      }
      process.exit(1);
    }
  });

type ConfigEditResult =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'set'; value: unknown };

/**
 * Get the effective config value, considering defaults.
 */
function getConfigValue(config: Partial<Config>, key: keyof Config, vaultDir: string): unknown {
  const value = config[key];
  if (value !== undefined) {
    return value;
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
    case 'excluded_directories':
    case 'mention_exclude_types':
    case 'mention_exclude_paths':
      return [];
    case 'date_format':
      return 'YYYY-MM-DD';
    case 'date_granularity':
      return 'day';
    case 'mention_link_once':
      return false;
    default:
      return undefined;
  }
}

/**
 * Format a value for display.
 */
function formatDisplayValue(value: unknown): string {
  if (value === undefined) {
    return chalk.gray('(not set)');
  }
  return chalk.green(typeof value === 'string' ? value : JSON.stringify(value));
}

function normalizeExcludedDirectoryEntry(entry: string): string {
  return entry.trim().replace(/\/$/, '');
}

function normalizeExcludedDirectoriesValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .filter((v): v is string => typeof v === 'string')
    .map(normalizeExcludedDirectoryEntry)
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

function normalizeStringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .filter((v): v is string => typeof v === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

function normalizeConfigValue(key: keyof Config, value: unknown): unknown {
  if (key === 'excluded_directories') {
    return normalizeExcludedDirectoriesValue(value);
  }

  if (key === 'mention_exclude_types' || key === 'mention_exclude_paths') {
    return normalizeStringArrayValue(value);
  }

  return value;
}

function validateConfigValue(meta: ConfigOptionMeta, value: unknown): void {
  if (meta.options) {
    if (!meta.options.includes(String(value))) {
      throw new Error(`Invalid value for ${String(meta.key)}. Valid options: ${meta.options.join(', ')}`);
    }
    return;
  }

  if (meta.key === 'date_format') {
    const requiredTokens = ['YYYY', 'MM', 'DD'];
    const hasEachTokenExactlyOnce =
      typeof value === 'string' &&
      requiredTokens.every(token => value.split(token).length === 2);

    if (!hasEachTokenExactlyOnce) {
      throw new Error('date_format must contain YYYY, MM, and DD exactly once each');
    }
  }

  if (
    meta.key === 'excluded_directories' ||
    meta.key === 'mention_exclude_types' ||
    meta.key === 'mention_exclude_paths'
  ) {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
      throw new Error(`${String(meta.key)} must be a JSON array of strings`);
    }
  }

  if (meta.key === 'mention_link_once' && typeof value !== 'boolean') {
    throw new Error(`${String(meta.key)} must be a boolean`);
  }
}

async function writeValidatedSchema(
  schemaPath: string,
  schema: Record<string, unknown>
): Promise<void> {
  const parsed = BwrbSchema.parse(schema);
  resolveSchema(parsed);
  await writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n');
}

/**
 * Prompt for a config option value.
 */
async function promptConfigOption(meta: ConfigOptionMeta, currentValue: unknown): Promise<ConfigEditResult> {
  if (meta.key === 'excluded_directories') {
    return promptExcludedDirectories(currentValue);
  }

  if (meta.key === 'mention_exclude_types' || meta.key === 'mention_exclude_paths') {
    return promptStringArray(meta, currentValue);
  }

  if (meta.key === 'mention_link_once') {
    return promptBoolean(meta, currentValue);
  }

  if (meta.options) {
    // Select from options
    const choice = await promptSelection(
      `${meta.label} (current: ${currentValue ?? meta.default}):`,
      meta.options
    );

    if (choice === null) return { action: 'keep' };
    return { action: 'set', value: choice };
  }

  // Text input
  const choices = ['(keep current)', '(clear)', '(enter new value)'];
  const choice = await promptSelection(`${meta.label}:`, choices);

  if (choice === '(keep current)' || choice === null) {
    return { action: 'keep' };
  }
  if (choice === '(clear)') {
    return { action: 'clear' };
  }

  const current = typeof currentValue === 'string' ? currentValue : undefined;
  const entered = await promptInput(`Enter ${meta.key}:`, current);
  if (entered === null) return { action: 'keep' };

  return { action: 'set', value: entered };
}

async function promptBoolean(
  meta: ConfigOptionMeta,
  currentValue: unknown
): Promise<ConfigEditResult> {
  const current = typeof currentValue === 'boolean' ? currentValue : meta.default;
  const choice = await promptSelection(
    `${meta.label} (current: ${String(current)}):`,
    ['(keep current)', 'true', 'false', '(clear)']
  );

  if (choice === null || choice === '(keep current)') {
    return { action: 'keep' };
  }
  if (choice === '(clear)') {
    return { action: 'clear' };
  }
  return { action: 'set', value: choice === 'true' };
}

async function promptStringArray(
  meta: ConfigOptionMeta,
  currentValue: unknown
): Promise<ConfigEditResult> {
  const current = normalizeStringArrayValue(currentValue);
  let entries = [...current];

  while (true) {
    const display = entries.length > 0 ? entries.join(', ') : '(none)';

    const choice = await promptSelection(
      `${meta.label} (current: ${display}):`,
      ['(keep current)', '(clear)', '(add)', '(remove)', '(done)']
    );

    if (choice === null || choice === '(keep current)') {
      return { action: 'keep' };
    }

    if (choice === '(clear)') {
      return { action: 'clear' };
    }

    if (choice === '(done)') {
      return { action: 'set', value: entries };
    }

    if (choice === '(add)') {
      const entered = await promptInput(`Add ${meta.key} entries (comma-separated):`);
      if (entered === null) continue;

      const toAdd = entered
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      entries = Array.from(new Set([...entries, ...toAdd]));
      continue;
    }

    if (choice === '(remove)') {
      if (entries.length === 0) continue;

      const toRemove = await promptSelection(`Remove which ${meta.key} entry?`, [...entries, '(back)']);
      if (toRemove === null || toRemove === '(back)') continue;

      entries = entries.filter(e => e !== toRemove);
      continue;
    }
  }
}

async function promptExcludedDirectories(currentValue: unknown): Promise<ConfigEditResult> {
  const current = normalizeExcludedDirectoriesValue(currentValue);
  let entries = [...current];

  while (true) {
    const display = entries.length > 0 ? entries.join(', ') : '(none)';

    const choice = await promptSelection(
      `Excluded directories (current: ${display}):`,
      ['(keep current)', '(clear)', '(add)', '(remove)', '(done)']
    );

    if (choice === null || choice === '(keep current)') {
      return { action: 'keep' };
    }

    if (choice === '(clear)') {
      return { action: 'clear' };
    }

    if (choice === '(done)') {
      return { action: 'set', value: entries };
    }

    if (choice === '(add)') {
      const entered = await promptInput('Add directories (comma-separated):');
      if (entered === null) continue;

      const toAdd = entered
        .split(',')
        .map(normalizeExcludedDirectoryEntry)
        .filter(Boolean);

      entries = Array.from(new Set([...entries, ...toAdd]));
      continue;
    }

    if (choice === '(remove)') {
      if (entries.length === 0) continue;

      const toRemove = await promptSelection('Remove which directory?', [...entries, '(back)']);
      if (toRemove === null || toRemove === '(back)') continue;

      entries = entries.filter(e => e !== toRemove);
      continue;
    }
  }
}
