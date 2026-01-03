/**
 * Shell completion support for pika CLI.
 * 
 * This module provides:
 * - Type name completion (--type/-t)
 * - Path completion (--path/-p)
 * - Command and option completion
 * 
 * The completion system works via a runtime callback model:
 * 1. `pika completion <shell>` outputs a shell script
 * 2. The script calls `pika --completions ...` at tab-completion time
 * 3. This module returns candidates based on current context
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { LoadedSchema } from '../types/schema.js';
import { loadSchema, getConcreteTypeNames } from './schema.js';
import { resolveVaultDir } from './vault.js';

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
  /** The subcommand being used (if any) */
  command: string | undefined;
}

/**
 * Parse completion request from argv.
 * 
 * The shell scripts pass the command line words after --completions.
 * Format: pika --completions pika <subcommand> [options...] <current>
 * 
 * The first word is 'pika' (the command name), which we skip.
 * The last word is always the one being completed (may be empty string).
 */
export function parseCompletionRequest(argv: string[]): CompletionContext {
  // argv is everything after --completions
  // First word is 'pika', skip it
  // Last element is the word being completed
  let words = argv.length > 0 ? argv : [''];
  
  // Skip 'pika' if it's the first word
  if (words[0] === 'pika') {
    words = words.slice(1);
  }
  
  // Ensure we have at least an empty string to complete
  if (words.length === 0) {
    words = [''];
  }
  
  const currentIndex = words.length - 1;
  const current = words[currentIndex] ?? '';
  const previous = currentIndex > 0 ? (words[currentIndex - 1] ?? '') : '';
  
  // Find the subcommand (first word that doesn't start with -)
  // Only look at words before the current one
  let command: string | undefined;
  for (let i = 0; i < words.length - 1; i++) {
    const word = words[i];
    if (word && !word.startsWith('-')) {
      command = word;
      break;
    }
  }
  
  return { words, currentIndex, current, previous, command };
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
      // Skip hidden directories and .pika
      if (entry.name.startsWith('.')) continue;
      if (entry.name === '.pika') continue;
      
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
 * Commands that support targeting options (--type, --path, --where, --text).
 */
const TARGETING_COMMANDS = new Set([
  'list', 'bulk', 'audit', 'search', 'open', 'delete'
]);

/**
 * All available pika commands.
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
  'delete',
  'completion',
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
  delete: ['--type', '-t', '--path', '-p', '--where', '-w', '--text', '--all', '-a', '--vault', '--yes', '-y', '--help'],
  completion: ['--help'],
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
export function isTypeOption(option: string): boolean {
  return option === '--type' || option === '-t';
}

/**
 * Check if an option expects a path value.
 */
export function isPathOption(option: string): boolean {
  return option === '--path' || option === '-p';
}

/**
 * Check if a command supports targeting options.
 */
export function supportsTargeting(command: string): boolean {
  return TARGETING_COMMANDS.has(command);
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
  
  // If completing the first word (after 'pika'), return commands
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
    const options = ctx.command 
      ? getOptionCompletions(ctx.command)
      : ['--vault', '--help', '--version'];
    return filterByPrefix(options, ctx.current);
  }
  
  // If we have a command and it's schema or template, complete subcommands
  if (ctx.command === 'schema') {
    return filterByPrefix(['show', 'types', 'enums'], ctx.current);
  }
  if (ctx.command === 'template') {
    return filterByPrefix(['list', 'show', 'new', 'edit', 'validate'], ctx.current);
  }
  if (ctx.command === 'completion') {
    return filterByPrefix(['bash', 'zsh', 'fish'], ctx.current);
  }
  
  // Default: no completions
  return [];
}

// ============================================================================
// Shell Script Generation
// ============================================================================

/**
 * Generate bash completion script.
 */
export function generateBashScript(): string {
  return `# pika bash completion
# Add to ~/.bashrc: eval "$(pika completion bash)"

_pika_completions() {
  local cur prev words cword
  _init_completion || return

  # Build the completion request
  # Pass all words to pika --completions
  local completions
  completions=$(pika --completions "\${COMP_WORDS[@]:1}" 2>/dev/null)
  
  # Handle path completion specially (preserve trailing slashes)
  if [[ "\${prev}" == "--path" ]] || [[ "\${prev}" == "-p" ]]; then
    compopt -o nospace
  fi
  
  COMPREPLY=($(compgen -W "\${completions}" -- "\${cur}"))
}

complete -F _pika_completions pika
`;
}

/**
 * Generate zsh completion script.
 */
export function generateZshScript(): string {
  return `#compdef pika
# pika zsh completion
# Add to ~/.zshrc: eval "$(pika completion zsh)"

_pika() {
  local completions
  
  # Build completion request from words array
  # \${words[@]:1} skips the command name 'pika'
  completions=("\${(@f)$(pika --completions "\${words[@]:1}" 2>/dev/null)}")
  
  if [[ \${#completions[@]} -gt 0 ]]; then
    # Check if completing paths (preserve trailing slashes)
    if [[ "\${words[-2]}" == "--path" ]] || [[ "\${words[-2]}" == "-p" ]]; then
      compadd -S '' -- "\${completions[@]}"
    else
      compadd -- "\${completions[@]}"
    fi
  fi
}

compdef _pika pika
`;
}

/**
 * Generate fish completion script.
 */
export function generateFishScript(): string {
  return `# pika fish completion
# Save to ~/.config/fish/completions/pika.fish

function __pika_completions
  set -l tokens (commandline -opc)
  # Remove 'pika' from the start
  set -e tokens[1]
  # Add the current token being completed
  set -l current (commandline -ct)
  set tokens $tokens $current
  
  pika --completions $tokens 2>/dev/null
end

# Disable file completion, use our custom completions
complete -c pika -f -a "(__pika_completions)"
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
