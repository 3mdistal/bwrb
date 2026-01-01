/**
 * Backup functionality for bulk operations.
 */

import { mkdir, readFile, writeFile, readdir, cp, stat } from 'fs/promises';
import { join, dirname, relative } from 'path';
import type { BackupManifest, BackupInfo } from './types.js';

/**
 * Get the backups directory path.
 */
function getBackupsDir(vaultDir: string): string {
  return join(vaultDir, '.pika', 'backups');
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
    const relativePath = relative(vaultDir, file);
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

/**
 * List available backups.
 */
export async function listBackups(vaultDir: string): Promise<BackupInfo[]> {
  const backupsDir = getBackupsDir(vaultDir);

  let entries: string[];
  try {
    entries = await readdir(backupsDir);
  } catch {
    // No backups directory
    return [];
  }

  const backups: BackupInfo[] = [];
  for (const entry of entries) {
    const backupDir = join(backupsDir, entry);
    const manifestPath = join(backupDir, 'manifest.json');

    try {
      const stats = await stat(backupDir);
      if (!stats.isDirectory()) continue;

      const manifestContent = await readFile(manifestPath, 'utf-8');
      const manifest: BackupManifest = JSON.parse(manifestContent);

      backups.push({
        id: entry,
        timestamp: new Date(manifest.timestamp),
        operation: manifest.operation,
        fileCount: manifest.files.length,
        path: backupDir,
      });
    } catch {
      // Skip invalid backup directories
      continue;
    }
  }

  // Sort by timestamp, newest first
  backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return backups;
}

/**
 * Restore files from a backup.
 */
export async function restoreBackup(
  vaultDir: string,
  backupId: string
): Promise<{ restored: string[] }> {
  const backupDir = join(getBackupsDir(vaultDir), backupId);
  const manifestPath = join(backupDir, 'manifest.json');
  const filesDir = join(backupDir, 'files');

  // Read manifest
  let manifest: BackupManifest;
  try {
    const content = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(content);
  } catch {
    throw new Error(`Backup not found: ${backupId}`);
  }

  // Restore each file
  const restored: string[] = [];
  for (const relativePath of manifest.files) {
    const srcPath = join(filesDir, relativePath);
    const destPath = join(vaultDir, relativePath);

    try {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(srcPath, destPath);
      restored.push(relativePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to restore ${relativePath}: ${message}`);
    }
  }

  return { restored };
}

/**
 * Get backup info by ID.
 */
export async function getBackup(
  vaultDir: string,
  backupId: string
): Promise<BackupInfo | null> {
  const backupDir = join(getBackupsDir(vaultDir), backupId);
  const manifestPath = join(backupDir, 'manifest.json');

  try {
    const stats = await stat(backupDir);
    if (!stats.isDirectory()) return null;

    const content = await readFile(manifestPath, 'utf-8');
    const manifest: BackupManifest = JSON.parse(content);

    return {
      id: backupId,
      timestamp: new Date(manifest.timestamp),
      operation: manifest.operation,
      fileCount: manifest.files.length,
      path: backupDir,
    };
  } catch {
    return null;
  }
}
