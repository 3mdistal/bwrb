/**
 * Backup functionality for bulk operations.
 */

import { mkdir, writeFile, cp } from 'fs/promises';
import { join, dirname } from 'path';
import type { BackupManifest } from './types.js';
import { vaultRelativePath } from '../vault-relative-path.js';

/**
 * Get the backups directory path.
 */
function getBackupsDir(vaultDir: string): string {
  return join(vaultDir, '.bwrb', 'backups');
}

/**
 * Generate a backup ID from the current timestamp.
 */
function generateBackupId(): string {
  const now = new Date();
  return now.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', 'T')
    .slice(0, 19); // 2025-12-27T10-30-00
}

/**
 * Create a backup of the specified files before bulk modification.
 * 
 * @param vaultDir - The vault directory path
 * @param files - Array of absolute file paths to back up
 * @param operation - Description of the operation for the manifest
 * @returns The backup directory path
 */
export async function createBackup(
  vaultDir: string,
  files: string[],
  operation: string
): Promise<string> {
  const backupId = generateBackupId();
  const backupDir = join(getBackupsDir(vaultDir), backupId);
  const filesDir = join(backupDir, 'files');

  // Create backup directories
  await mkdir(filesDir, { recursive: true });

  // Copy each file, preserving relative paths
  const relativeFiles: string[] = [];
  for (const file of files) {
    const relativePath = vaultRelativePath(vaultDir, file);
    relativeFiles.push(relativePath);

    const destPath = join(filesDir, relativePath);
    await mkdir(dirname(destPath), { recursive: true });
    await cp(file, destPath);
  }

  // Write manifest
  const manifest: BackupManifest = {
    timestamp: new Date().toISOString(),
    operation,
    files: relativeFiles,
  };
  await writeFile(
    join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  return backupDir;
}


