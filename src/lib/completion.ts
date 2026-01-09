/**
 * Shell completion support for bwrb CLI.
 * 
 * This module provides:
 * - Type name completion (--type/-t)
 * - Path completion (--path/-p)
 * - Command and option completion
 * - Subcommand completion (schema, template, dashboard, completion)
 * - Entity name completion (dashboard names, template names)
 * 
 * The completion system works via a runtime callback model:
 * 1. `bwrb completion <shell>` outputs a shell script
 * 2. The script calls `bwrb --completions ...` at tab-completion time
 * 3. This module returns candidates based on current context
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { LoadedSchema } from '../types/schema.js';
import { loadSchema, getConcreteTypeNames } from './schema.js';
import { resolveVaultDir } from './vault.js';
import { listDashboards } from './dashboard.js';
import { findTemplates } from './template.js';

// ============================================================================
// Completion Context
// ============================================================================

/**
 * Context for a completion request, parsed from shell arguments.
 */
export interface CompletionContext {
  /** All words in the command line */
  words: string[];
  /** Index of the word being completed (0-based) */
  currentIndex: number;
  /** The word being completed (may be partial) */
  current: string;
  /** The previous word (for option value completion) */
  previous: string;
  /** The main command being used (e.g., 'dashboard', 'template') */
  command: string | undefined;
  /** Index of the command in words array (-1 if not found) */
  commandIndex: number;
  /** The subcommand if any (e.g., 'edit', 'delete' for 'dashboard edit') */
  subcommand: string | undefined;
  /** Index of the subcommand in words array (-1 if not found) */
  subcommandIndex: number;
  /** Index of positional argument being completed (0 = first positional after command/subcommand) */
  positionalIndex: number;
}

/**
 * Commands that have subcommands.
 */
const COMMANDS_WITH_SUBCOMMANDS = ['schema', 'template', 'dashboard', 'completion'];

/**
 * Subcommands for each parent command.
 */
const SUBCOMMANDS: Record<string, string[]> = {
  schema: ['list', 'new', 'edit', 'delete', 'validate', 'diff', 'migrate', 'history'],
  template: ['list', 'show', 'new', 'edit', 'delete', 'validate'],
  dashboard: ['list', 'new', 'edit', 'delete'],
  completion: ['bash', 'zsh', 'fish'],
};

/**
 * Parse completion request from argv.
 * 
 * The shell scripts pass the command line words after --completions.
 * Format: bwrb --completions bwrb <command> [subcommand] [options...] <current>
 * 
 * The first word is 'bwrb' (the command name), which we skip.
 * The last word is always the one being completed (may be empty string).
 */
export function parseCompletionRequest(argv: string[]): CompletionContext {
  // argv is everything after --completions
  // First word is 'bwrb', skip it
  // Last element is the word being completed
  let words = argv.length > 0 ? argv : [''];
  
  // Skip 'bwrb' if it's the first word
  if (words[0] === 'bwrb') {
    words = words.slice(1);
  }
  
  // Ensure we have at least an empty string to complete
  if (words.length === 0) {
    words = [''];
  }
  
  const currentIndex = words.length - 1;
  const current = words[currentIndex] ?? '';
  const previous = currentIndex > 0 ? (words[currentIndex - 1] ?? '') : '';
  
  // Find the command (first non-option word before current)
  let command: string | undefined;
  let commandIndex = -1;
  for (let i = 0; i < words.length - 1; i++) {
    const word = words[i];
    if (word && !word.startsWith('-')) {
      command = word;
      commandIndex = i;
      break;
    }
  }
  
  // Find subcommand if the command has subcommands
  let subcommand: string | undefined;
  let subcommandIndex = -1;
  if (command && COMMANDS_WITH_SUBCOMMANDS.includes(command)) {
    const possibleSubcommands = SUBCOMMANDS[command] ?? [];
    // Look for subcommand after the command
    for (let i = commandIndex + 1; i < words.length - 1; i++) {
      const word = words[i];
      if (word && !word.startsWith('-') && possibleSubcommands.includes(word)) {
        subcommand = word;
        subcommandIndex = i;
        break;
      }
    }
  }
  
  // Calculate positional index (how many positional args after command/subcommand)
  // A positional arg is a non-option word that isn't the command or subcommand
  let positionalIndex = -1;
  const startIndex = subcommandIndex >= 0 ? subcommandIndex + 1 : (commandIndex >= 0 ? commandIndex + 1 : 0);
  
  // Count positional arguments before the current word
  let positionalCount = 0;
  for (let i = startIndex; i < currentIndex; i++) {
    const word = words[i];
    // Skip options and their values
    if (word?.startsWith('-')) {
      // If this is an option that takes a value, skip the next word too
      if (isTypeOption(word) || isPathOption(word) || isValueOption(word)) {
        i++; // Skip the value
      }
      continue;
    }
    positionalCount++;
  }
  
  // If current word doesn't start with -, it's a positional
  if (!current.startsWith('-')) {
    positionalIndex = positionalCount;
  }
  
  return { words, currentIndex, current, previous, command, commandIndex, subcommand, subcommandIndex, positionalIndex };
}

// ============================================================================
// Type Completion
// ============================================================================

/**
 * Get type name completions from the schema.
 * Returns all concrete type names (excludes 'meta').
 */
export function getTypeCompletions(schema: LoadedSchema): string[] {
  return getConcreteTypeNames(schema).sort();
}

/**
 * Filter completions by a prefix.
 */
export function filterByPrefix(items: string[], prefix: string): string[] {
  if (!prefix) return items;
  const lower = prefix.toLowerCase();
  return items.filter(item => item.toLowerCase().startsWith(lower));
}

// ============================================================================
// Path Completion
// ============================================================================

/**
 * Get path completions for vault directories.
 * 
 * @param vaultDir - The vault root directory
 * @param partial - The partial path typed so far
 * @returns Array of directory paths (relative to vault root)
 */
export async function getPathCompletions(
  vaultDir: string,
  partial: string
): Promise<string[]> {
  // Determine the directory to list and the prefix to filter by
  const lastSlash = partial.lastIndexOf('/');
  const baseDir = lastSlash >= 0 ? partial.slice(0, lastSlash) : '';
  const prefix = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;
  
  const targetDir = baseDir ? join(vaultDir, baseDir) : vaultDir;
  
  if (!existsSync(targetDir)) {
    return [];
  }
  
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const dirs: string[] = [];
    
    for (const entry of entries) {
      // Skip hidden directories and .bwrb
      if (entry.name.startsWith('.')) continue;
      if (entry.name === '.bwrb') continue;
      
      if (entry.isDirectory()) {
        // Build the full path relative to vault
        const relativePath = baseDir 
          ? `${baseDir}/${entry.name}`
          : entry.name;
        
        // Add trailing slash to indicate it's a directory
        dirs.push(`${relativePath}/`);
      }
    }
    
    // Filter by prefix and sort
    const filtered = prefix 
      ? dirs.filter(d => {
          const name = d.slice(baseDir ? baseDir.length + 1 : 0);
          return name.toLowerCase().startsWith(prefix.toLowerCase());
        })
      : dirs;
    
    return filtered.sort();
  } catch {
    return [];
  }
}

// ============================================================================
// Command and Option Completion
// ============================================================================

/**
 * All available bwrb commands.
 */
const COMMANDS = [
  'new',
  'edit', 
  'list',
  'open',
  'search',
  'audit',
  'bulk',
  'schema',
  'template',
  'dashboard',
  'delete',
  'completion',
  'config',
];

/**
 * Options available for each command.
 * Only includes options that make sense to complete.
 */
const COMMAND_OPTIONS: Record<string, string[]> = {
  new: ['--type', '-t', '--vault', '--template', '--json', '--help'],
  edit: ['--vault', '--json', '--help'],
  list: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--output', '-o', '--vault', '--json', '--help'],
  open: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--app', '--vault', '--help'],
  search: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--wikilink', '--vault', '--help'],
  audit: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--fix', '--vault', '--help'],
  bulk: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--set', '--vault', '--dry-run', '--yes', '-y', '--help'],
  schema: ['--vault', '--help'],
  template: ['--vault', '--help'],
  dashboard: ['--output', '-o', '--vault', '--json', '--help'],
  delete: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--vault', '--yes', '-y', '--help'],
  completion: ['--help'],
  config: ['--output', '-o', '--vault', '--json', '--help'],
};

/**
 * Get command completions.
 */
export function getCommandCompletions(): string[] {
  return COMMANDS;
}

/**
 * Get option completions for a command.
 */
export function getOptionCompletions(command: string): string[] {
  return COMMAND_OPTIONS[command] ?? [];
}

/**
 * Check if an option expects a type value.
 */
function isTypeOption(option: string): boolean {
  return option === '--type' || option === '-t';
}

/**
 * Check if an option expects a path value.
 */
function isPathOption(option: string): boolean {
  return option === '--path' || option === '-p';
}

/**
 * Check if an option expects any value (used for positional counting).
 */
function isValueOption(option: string): boolean {
  const valueOptions = [
    '--type', '-t',
    '--path', '-p', 
    '--where', '-w',
    '--output', '-o',
    '--template',
    '--app',
    '--set',
    '--vault',
    '--text',
    '--default-output',
    '--fields',
    '--body',
  ];
  return valueOptions.includes(option);
}

// ============================================================================
// Entity Name Completion
// ============================================================================

/**
 * Get dashboard name completions.
 */
async function getDashboardCompletions(vaultDir: string): Promise<string[]> {
  try {
    return await listDashboards(vaultDir);
  } catch {
    return [];
  }
}

/**
 * Get template name completions for a given type.
 */
async function getTemplateNameCompletions(vaultDir: string, typePath: string): Promise<string[]> {
  try {
    const templates = await findTemplates(vaultDir, typePath);
    return templates.map(t => t.name);
  } catch {
    return [];
  }
}

// ============================================================================
// Main Completion Handler
// ============================================================================

/**
 * Handle a completion request and return candidates.
 * 
 * @param argv - Arguments after --completions
 * @param options - Optional vault override
 * @returns Array of completion candidates (one per line when joined)
 */
export async function handleCompletionRequest(
  argv: string[],
  options: { vault?: string } = {}
): Promise<string[]> {
  const ctx = parseCompletionRequest(argv);
  
  // If completing the first word (after 'bwrb'), return commands
  if (ctx.currentIndex === 0 || (!ctx.command && !ctx.current.startsWith('-'))) {
    return filterByPrefix(getCommandCompletions(), ctx.current);
  }
  
  // If previous word is --type or -t, complete with type names
  if (isTypeOption(ctx.previous)) {
    try {
      const vaultDir = resolveVaultDir(options);
      const schema = await loadSchema(vaultDir);
      return filterByPrefix(getTypeCompletions(schema), ctx.current);
    } catch {
      // Can't load schema, return empty
      return [];
    }
  }
  
  // If previous word is --path or -p, complete with paths
  if (isPathOption(ctx.previous)) {
    try {
      const vaultDir = resolveVaultDir(options);
      return await getPathCompletions(vaultDir, ctx.current);
    } catch {
      return [];
    }
  }
  
  // If current word starts with -, complete options
  if (ctx.current.startsWith('-')) {
    const opts = ctx.command 
      ? getOptionCompletions(ctx.command)
      : ['--vault', '--help', '--version'];
    return filterByPrefix(opts, ctx.current);
  }
  
  // === Dashboard command ===
  if (ctx.command === 'dashboard') {
    // If no subcommand yet, complete with subcommands OR dashboard names
    if (!ctx.subcommand) {
      // First positional could be a subcommand or a dashboard name
      if (ctx.positionalIndex === 0) {
        try {
          const vaultDir = resolveVaultDir(options);
          const subcommands = SUBCOMMANDS['dashboard'] ?? [];
          const dashboardNames = await getDashboardCompletions(vaultDir);
          // Combine subcommands and dashboard names (subcommands first)
          const all = [...subcommands, ...dashboardNames];
          return filterByPrefix(all, ctx.current);
        } catch {
          return filterByPrefix(SUBCOMMANDS['dashboard'] ?? [], ctx.current);
        }
      }
    }
    
    // If subcommand is edit or delete, complete with dashboard names
    if (ctx.subcommand === 'edit' || ctx.subcommand === 'delete') {
      if (ctx.positionalIndex === 0) {
        try {
          const vaultDir = resolveVaultDir(options);
          return filterByPrefix(await getDashboardCompletions(vaultDir), ctx.current);
        } catch {
          return [];
        }
      }
    }
    
    return [];
  }
  
  // === Template command ===
  if (ctx.command === 'template') {
    // If no subcommand yet, complete with subcommands
    if (!ctx.subcommand) {
      return filterByPrefix(SUBCOMMANDS['template'] ?? [], ctx.current);
    }
    
    // For subcommands that take [type] [name]: show, edit, delete
    if (['show', 'edit', 'delete'].includes(ctx.subcommand)) {
      try {
        const vaultDir = resolveVaultDir(options);
        const schema = await loadSchema(vaultDir);
        
        // First positional: type name
        if (ctx.positionalIndex === 0) {
          return filterByPrefix(getTypeCompletions(schema), ctx.current);
        }
        
        // Second positional: template name for the given type
        if (ctx.positionalIndex === 1) {
          // Find the type from previous words
          const typeArg = findPreviousPositionalArg(ctx, 0);
          if (typeArg) {
            return filterByPrefix(await getTemplateNameCompletions(vaultDir, typeArg), ctx.current);
          }
        }
      } catch {
        return [];
      }
    }
    
    // For subcommands that take [type]: list, validate, new
    if (['list', 'validate', 'new'].includes(ctx.subcommand)) {
      if (ctx.positionalIndex === 0) {
        try {
          const vaultDir = resolveVaultDir(options);
          const schema = await loadSchema(vaultDir);
          return filterByPrefix(getTypeCompletions(schema), ctx.current);
        } catch {
          return [];
        }
      }
    }
    
    return [];
  }
  
  // === Schema command ===
  if (ctx.command === 'schema') {
    // If no subcommand yet, complete with subcommands
    if (!ctx.subcommand) {
      return filterByPrefix(SUBCOMMANDS['schema'] ?? [], ctx.current);
    }
    
    // For edit and delete: first arg is 'type' or 'field'
    if (['edit', 'delete'].includes(ctx.subcommand)) {
      if (ctx.positionalIndex === 0) {
        return filterByPrefix(['type', 'field'], ctx.current);
      }
      // Second positional could be the type/field name
      if (ctx.positionalIndex === 1) {
        const whatArg = findPreviousPositionalArg(ctx, 0);
        if (whatArg === 'type') {
          try {
            const vaultDir = resolveVaultDir(options);
            const schema = await loadSchema(vaultDir);
            return filterByPrefix(getTypeCompletions(schema), ctx.current);
          } catch {
            return [];
          }
        }
        // For 'field', we'd need to know which type - leave empty for now
      }
    }
    
    // For new: first arg is 'type' or 'field'
    if (ctx.subcommand === 'new') {
      if (ctx.positionalIndex === 0) {
        return filterByPrefix(['type', 'field'], ctx.current);
      }
    }
    
    return [];
  }
  
  // === Completion command ===
  if (ctx.command === 'completion') {
    if (!ctx.subcommand && ctx.positionalIndex === 0) {
      return filterByPrefix(SUBCOMMANDS['completion'] ?? [], ctx.current);
    }
    return [];
  }
  
  // Default: no completions
  return [];
}

/**
 * Find a previous positional argument by its index.
 * Used to get context for multi-positional completions (e.g., type before template name).
 */
function findPreviousPositionalArg(ctx: CompletionContext, targetIndex: number): string | undefined {
  // Use stored indices instead of indexOf to avoid fragility with duplicate words
  const startIndex = ctx.subcommandIndex >= 0 
    ? ctx.subcommandIndex + 1
    : (ctx.commandIndex >= 0 ? ctx.commandIndex + 1 : 0);
  
  let positionalCount = 0;
  for (let i = startIndex; i < ctx.currentIndex; i++) {
    const word = ctx.words[i];
    if (word?.startsWith('-')) {
      // Skip option and its value
      if (isValueOption(word)) {
        i++;
      }
      continue;
    }
    if (positionalCount === targetIndex) {
      return word;
    }
    positionalCount++;
  }
  return undefined;
}

// ============================================================================
// Shell Script Generation
// ============================================================================

/**
 * Generate bash completion script.
 */
function generateBashScript(): string {
  return `# bwrb bash completion
# Add to ~/.bashrc: eval "$(bwrb completion bash)"

_bwrb_completions() {
  local cur prev words cword
  _init_completion || return

  # Build the completion request
  # Pass all words to bwrb --completions
  local completions
  completions=$(bwrb --completions "\${COMP_WORDS[@]:1}" 2>/dev/null)
  
  # Handle path completion specially (preserve trailing slashes)
  if [[ "\${prev}" == "--path" ]] || [[ "\${prev}" == "-p" ]]; then
    compopt -o nospace
  fi
  
  COMPREPLY=($(compgen -W "\${completions}" -- "\${cur}"))
}

complete -F _bwrb_completions bwrb
`;
}

/**
 * Generate zsh completion script.
 */
function generateZshScript(): string {
  return `#compdef bwrb
# bwrb zsh completion
# Add to ~/.zshrc: eval "$(bwrb completion zsh)"

_bwrb() {
  local completions
  
  # Build completion request from words array
  # \${words[@]:1} skips the command name 'bwrb'
  completions=("\${(@f)$(bwrb --completions "\${words[@]:1}" 2>/dev/null)}")
  
  if [[ \${#completions[@]} -gt 0 ]]; then
    # Check if completing paths (preserve trailing slashes)
    if [[ "\${words[-2]}" == "--path" ]] || [[ "\${words[-2]}" == "-p" ]]; then
      compadd -S '' -- "\${completions[@]}"
    else
      compadd -- "\${completions[@]}"
    fi
  fi
}

compdef _bwrb bwrb
`;
}

/**
 * Generate fish completion script.
 */
function generateFishScript(): string {
  return `# bwrb fish completion
# Save to ~/.config/fish/completions/bwrb.fish

function __bwrb_completions
  set -l tokens (commandline -opc)
  # Remove 'bwrb' from the start
  set -e tokens[1]
  # Add the current token being completed
  set -l current (commandline -ct)
  set tokens $tokens $current
  
  bwrb --completions $tokens 2>/dev/null
end

# Disable file completion, use our custom completions
complete -c bwrb -f -a "(__bwrb_completions)"
`;
}

/**
 * Get completion script for a shell.
 */
export function getCompletionScript(shell: string): string | null {
  switch (shell) {
    case 'bash':
      return generateBashScript();
    case 'zsh':
      return generateZshScript();
    case 'fish':
      return generateFishScript();
    default:
      return null;
  }
}
