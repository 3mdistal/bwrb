/**
 * Completion command - outputs shell completion scripts.
 * 
 * Usage:
 *   bwrb completion bash   # Output bash completion script
 *   bwrb completion zsh    # Output zsh completion script
 *   bwrb completion fish   # Output fish completion script
 * 
 * Installation:
 *   # Bash (add to ~/.bashrc)
 *   eval "$(bwrb completion bash)"
 *   
 *   # Zsh (add to ~/.zshrc)
 *   eval "$(bwrb completion zsh)"
 *   
 *   # Fish (run once)
 *   bwrb completion fish > ~/.config/fish/completions/bwrb.fish
 */

import { Command } from 'commander';
import { getCompletionScript } from '../lib/completion.js';

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'];

export const completionCommand = new Command('completion')
  .description('Generate shell completion scripts')
  .argument('<shell>', `Shell type (${SUPPORTED_SHELLS.join(', ')})`)
  .addHelpText('after', `
Examples:
  # Bash (add to ~/.bashrc)
  eval "$(bwrb completion bash)"

  # Zsh (add to ~/.zshrc)  
  eval "$(bwrb completion zsh)"

  # Fish (run once)
  bwrb completion fish > ~/.config/fish/completions/bwrb.fish
`)
  .action((shell: string) => {
    const normalizedShell = shell.toLowerCase();
    
    if (!SUPPORTED_SHELLS.includes(normalizedShell)) {
      console.error(`Error: Unsupported shell "${shell}".`);
      console.error(`Supported shells: ${SUPPORTED_SHELLS.join(', ')}`);
      process.exit(1);
    }
    
    const script = getCompletionScript(normalizedShell);
    if (script) {
      console.log(script);
    } else {
      console.error(`Error: Failed to generate completion script for ${shell}.`);
      process.exit(1);
    }
  });
