/**
 * Completion command - outputs shell completion scripts.
 * 
 * Usage:
 *   pika completion bash   # Output bash completion script
 *   pika completion zsh    # Output zsh completion script
 *   pika completion fish   # Output fish completion script
 * 
 * Installation:
 *   # Bash (add to ~/.bashrc)
 *   eval "$(pika completion bash)"
 *   
 *   # Zsh (add to ~/.zshrc)
 *   eval "$(pika completion zsh)"
 *   
 *   # Fish (run once)
 *   pika completion fish > ~/.config/fish/completions/pika.fish
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
  eval "$(pika completion bash)"

  # Zsh (add to ~/.zshrc)  
  eval "$(pika completion zsh)"

  # Fish (run once)
  pika completion fish > ~/.config/fish/completions/pika.fish
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
