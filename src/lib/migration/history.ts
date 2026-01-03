/**
 * Migration history tracking.
 * Manages .pika/migrations.json for recording applied migrations.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  MigrationHistory,
  MigrationHistorySchema,
  AppliedMigration,
  MigrationPlan,
  MigrationResult,
} from '../../types/migration.js';

const MIGRATIONS_FILE = '.pika/migrations.json';

/**
 * Load migration history from .pika/migrations.json
 * Returns empty history if file doesn't exist.
 */
export async function loadMigrationHistory(vaultPath: string): Promise<MigrationHistory> {
  const filePath = path.join(vaultPath, MIGRATIONS_FILE);
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return MigrationHistorySchema.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { applied: [] };
    }
    throw error;
  }
}

/**
 * Save migration history to .pika/migrations.json
 * Uses atomic write (temp file + rename).
 */
export async function saveMigrationHistory(
  vaultPath: string,
  history: MigrationHistory
): Promise<void> {
  const filePath = path.join(vaultPath, MIGRATIONS_FILE);
  const tempPath = `${filePath}.tmp`;
  
  const content = JSON.stringify(history, null, 2) + '\n';
  
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Record a completed migration in the history.
 */
export async function recordMigration(
  vaultPath: string,
  plan: MigrationPlan,
  result: MigrationResult
): Promise<void> {
  const history = await loadMigrationHistory(vaultPath);
  
  const record: AppliedMigration = {
    version: plan.toVersion,
    appliedAt: new Date().toISOString(),
    operations: [...plan.deterministic, ...plan.nonDeterministic],
    notesAffected: result.affectedFiles,
    backupPath: result.backupPath,
  };
  
  history.applied.push(record);
  await saveMigrationHistory(vaultPath, history);
}

/**
 * Get the latest applied migration, if any.
 */
export async function getLatestMigration(
  vaultPath: string
): Promise<AppliedMigration | undefined> {
  const history = await loadMigrationHistory(vaultPath);
  return history.applied.at(-1);
}

/**
 * Get the version from the last applied migration.
 * Returns undefined if no migrations have been applied.
 */
export async function getLastAppliedVersion(
  vaultPath: string
): Promise<string | undefined> {
  const latest = await getLatestMigration(vaultPath);
  return latest?.version;
}
