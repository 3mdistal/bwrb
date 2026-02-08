/**
 * Schema snapshot management.
 * Manages .bwrb/schema.applied.json for tracking last-applied schema state.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Schema } from '../../types/schema.js';
import { SchemaSnapshot, SchemaSnapshotSchema } from '../../types/migration.js';
import { SCHEMA_SNAPSHOT_RELATIVE_PATH } from '../bwrb-paths.js';

/**
 * Load the last-applied schema snapshot.
 * Returns undefined if no snapshot exists (first migration).
 */
export async function loadSchemaSnapshot(vaultPath: string): Promise<SchemaSnapshot | undefined> {
  const filePath = path.join(vaultPath, SCHEMA_SNAPSHOT_RELATIVE_PATH);
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return SchemaSnapshotSchema.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Save the current schema as the applied snapshot.
 * Called after successful migration.
 */
export async function saveSchemaSnapshot(
  vaultPath: string,
  schema: Schema,
  schemaVersion: string
): Promise<void> {
  const filePath = path.join(vaultPath, SCHEMA_SNAPSHOT_RELATIVE_PATH);
  const tempPath = `${filePath}.tmp`;
  
  const snapshot: SchemaSnapshot = {
    schemaVersion,
    snapshotAt: new Date().toISOString(),
    schema,
  };
  
  const content = JSON.stringify(snapshot, null, 2) + '\n';
  
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

/**
 * Check if a schema snapshot exists.
 * Alias: snapshotExists
 */
export async function hasSchemaSnapshot(vaultPath: string): Promise<boolean> {
  const filePath = path.join(vaultPath, SCHEMA_SNAPSHOT_RELATIVE_PATH);
  
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the schema version from the last snapshot.
 * Returns undefined if no snapshot exists.
 */
export async function getSnapshotVersion(vaultPath: string): Promise<string | undefined> {
  const snapshot = await loadSchemaSnapshot(vaultPath);
  return snapshot?.schemaVersion;
}
