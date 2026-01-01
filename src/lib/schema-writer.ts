/**
 * Schema Writer Module
 * 
 * Handles reading and writing schema.json files safely.
 * Unlike loadSchema() which resolves inheritance, this module works with
 * raw JSON to preserve structure during mutations.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { PikaSchema, type Schema } from '../types/schema.js';

const SCHEMA_PATH = '.pika/schema.json';

/**
 * Load the raw schema JSON from a vault directory.
 * Returns the parsed JSON without resolving inheritance.
 */
export async function loadRawSchemaJson(vaultDir: string): Promise<Schema> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const content = await readFile(schemaPath, 'utf-8');
  const json = JSON.parse(content) as unknown;
  return PikaSchema.parse(json);
}

/**
 * Write a schema to the vault, preserving formatting.
 * Uses atomic write (temp file + rename) for safety.
 */
export async function writeSchema(vaultDir: string, schema: Schema): Promise<void> {
  const schemaPath = join(vaultDir, SCHEMA_PATH);
  const tempPath = join(vaultDir, SCHEMA_PATH + '.tmp');
  
  // Validate before writing
  PikaSchema.parse(schema);
  
  // Write to temp file
  const content = JSON.stringify(schema, null, 2) + '\n';
  await writeFile(tempPath, content, 'utf-8');
  
  // Atomic rename
  await rename(tempPath, schemaPath);
}

/**
 * Validate that a schema is valid without writing it.
 * Throws if invalid.
 */
export function validateSchema(schema: unknown): Schema {
  return PikaSchema.parse(schema);
}
