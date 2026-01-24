import { relative } from 'path';
import { promptSelection } from './prompt.js';
import { exitWithVaultResolutionError, exitWithCancel } from './output.js';
import { resolveVaultDir, VaultResolutionError, type ResolveVaultOptions } from './vault.js';

interface VaultSelectionOptions extends ResolveVaultOptions {
  jsonMode: boolean;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function resolveVaultDirWithSelection(
  options: VaultSelectionOptions
): Promise<string> {
  const { jsonMode, ...resolveOptions } = options;

  try {
    return await resolveVaultDir(resolveOptions);
  } catch (err) {
    if (!(err instanceof VaultResolutionError)) {
      throw err;
    }

    const candidatesRelative = err.candidates.map(candidate => relative(err.cwd, candidate));
    const canPrompt = isInteractive() && !jsonMode;

    if (!canPrompt) {
      return exitWithVaultResolutionError(
        { cwd: err.cwd, candidates: candidatesRelative, truncated: err.truncated },
        jsonMode
      );
    }

    const selection = await promptSelection('Select a vault:', candidatesRelative);
    if (selection === null) {
      return exitWithCancel(jsonMode);
    }

    const selectionIndex = candidatesRelative.indexOf(selection);
    const selected = err.candidates[selectionIndex];
    if (!selected) {
      return exitWithVaultResolutionError(
        { cwd: err.cwd, candidates: candidatesRelative, truncated: err.truncated },
        jsonMode
      );
    }

    return selected;
  }
}
