/**
 * Schema Writer Module
 * 
 * Handles reading and writing schema.json files safely.
 * Unlike loadSchema() which resolves inheritance, this module works with
 * raw JSON to preserve structure during mutations.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { BwrbSchema, type Schema } from '../types/schema.js';

const SCHEMA_PATH = '.bwrb/schema.json';

/**
 * Load the raw schema JSON from a vault directory.
 * Returns the parsed JSON without resolving inheritance.
 */
export async function loadRawSchemaJson(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return BwrbSchema.parse(json);
}

/**
 * Write a schema to the vault, preserving formatting.
 * Uses atomic write (temp file + rename) for safety.
 */
export async function writeSchema(vaultDir: string, schema: Schema): Promise<void> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const tempPath = join(vaultDir, SCHEMA_PATH + '.tmp');
  
  // Validate before writing
  BwrbSchema.parse(schema);
  
  // Write to temp file
  const content = JSON.stringify(schema, null, 2) + '\n';
  await writeFile(tempPath, content, 'utf-8');
  
  // Atomic rename
  await rename(tempPath, schemaPath);
}

/**
 * Set the default dashboard in vault config.
 * Updates schema.json with config.default_dashboard.
 * 
 * @param vaultDir - Path to the vault directory
 * @param dashboardName - Name of the dashboard to set as default, or null to clear
 */
export async function setDefaultDashboard(
  vaultDir: string,
  dashboardName: string | null
): Promise<void> {
  const schema = await loadRawSchemaJson(vaultDir);
  
  // Ensure config object exists
  if (!schema.config) {
    schema.config = {};
  }
  
  if (dashboardName === null) {
    // Clear the default
    delete schema.config.default_dashboard;
  } else {
    schema.config.default_dashboard = dashboardName;
  }
  
  await writeSchema(vaultDir, schema);
}
