import { Command } from 'commander';
import { exec } from 'child_process';
import { join, isAbsolute, relative, basename } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolveVaultDir, isFile } from '../lib/vault.js';
import { printError, printSuccess, printInfo } from '../lib/prompt.js';

export const openCommand = new Command('open')
  .description('Open a note in Obsidian')
  .argument('<file>', 'Path to the file to open')
  .action(async (filePath: string, _options: unknown, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});

      // Resolve file path
      const resolvedPath = isAbsolute(filePath) ? filePath : join(vaultDir, filePath);

      if (!(await isFile(resolvedPath))) {
        printError(`File not found: ${resolvedPath}`);
        process.exit(1);
      }

      await openInObsidian(vaultDir, resolvedPath);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * Open a file in Obsidian using the obsidian:// URI scheme.
 */
export async function openInObsidian(vaultDir: string, filePath: string): Promise<void> {
  const vaultName = await resolveVaultName(vaultDir);
  const relativePath = relative(vaultDir, filePath);

  // Build Obsidian URI
  // Format: obsidian://open?vault=VAULT_NAME&file=PATH
  const uri = buildObsidianUri(vaultName, relativePath);

  printInfo(`Opening in Obsidian: ${basename(filePath)}`);

  // Open URI based on platform
  await openUri(uri);
}

/**
 * Resolve the vault name from .obsidian/app.json or use directory name.
 */
async function resolveVaultName(vaultDir: string): Promise<string> {
  const appJsonPath = join(vaultDir, '.obsidian', 'app.json');

  // Try to get vault name from app.json (if it contains a custom name)
  // Obsidian stores vault name in the config
  if (existsSync(appJsonPath)) {
    try {
      const content = await readFile(appJsonPath, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;
      // Note: Obsidian doesn't actually store vault name in app.json
      // The vault name is determined by the folder name or the name in Obsidian's vault list
      // For now, we'll just use the directory name
      if (typeof config.vaultName === 'string') {
        return config.vaultName;
      }
    } catch {
      // Ignore errors, fall back to directory name
    }
  }

  // Fall back to directory name
  return basename(vaultDir);
}

/**
 * Build an Obsidian URI for opening a file.
 */
function buildObsidianUri(vaultName: string, filePath: string): string {
  // Remove .md extension if present (Obsidian doesn't need it)
  const pathWithoutExt = filePath.replace(/\.md$/, '');

  // URI encode the components
  const encodedVault = encodeURIComponent(vaultName);
  const encodedFile = encodeURIComponent(pathWithoutExt);

  return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Open a URI using the system's default handler.
 */
async function openUri(uri: string): Promise<void> {
  const platform = process.platform;

  let command: string;
  if (platform === 'darwin') {
    // macOS
    command = `open "${uri}"`;
  } else if (platform === 'win32') {
    // Windows
    command = `start "" "${uri}"`;
  } else {
    // Linux and others
    command = `xdg-open "${uri}"`;
  }

  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        reject(new Error(`Failed to open Obsidian: ${error.message}`));
      } else {
        printSuccess('✓ Opened in Obsidian');
        resolve();
      }
    });
  });
}
