import type { LoadedSchema } from '../types/schema.js';
import { applyFrontmatterFilters, type FileWithFrontmatter } from './query.js';
import { getAllFieldsForType } from './schema.js';
import {
  formatWhereValidationErrors,
  validateWhereExpressions,
} from './expression-validation.js';

export interface WhereFilterOptions {
  whereExpressions: string[];
  vaultDir: string;
  schema: LoadedSchema;
  typePath?: string;
}

export type WhereFilterResult<T extends FileWithFrontmatter> =
  | { ok: true; files: T[] }
  | { ok: false; kind: 'where-validation'; error: string };

export async function applyWhereExpressions<T extends FileWithFrontmatter>(
  files: T[],
  options: WhereFilterOptions
): Promise<WhereFilterResult<T>> {
  const { whereExpressions, vaultDir, schema, typePath } = options;

  if (whereExpressions.length === 0) {
    return { ok: true, files };
  }

  if (typePath) {
    const validation = validateWhereExpressions(whereExpressions, schema, typePath);
    if (!validation.valid) {
      return {
        ok: false,
        kind: 'where-validation',
        error: formatWhereValidationErrors(validation.errors),
      };
    }
  }

  const knownKeys = typePath ? getAllFieldsForType(schema, typePath) : null;
  const filtered = await applyFrontmatterFilters(files, {
    whereExpressions,
    vaultDir,
    silent: true,
    ...(knownKeys ? { knownKeys } : {}),
  });

  return { ok: true, files: filtered };
}
