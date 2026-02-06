import type { LoadedSchema } from '../types/schema.js';
import {
  validateWhereExpressions,
  type WhereValidationError,
} from './expression-validation.js';

export interface ValidateCliWhereOptions {
  whereExpressions?: string[];
  typePath?: string;
  schema: LoadedSchema;
}

export interface ValidateCliWhereResult {
  ok: boolean;
  errors: WhereValidationError[];
}

/**
 * Validate CLI --where expressions using unified targeting rules.
 *
 * Strict validation applies only when type is known.
 * Without type, expressions are permissive by design.
 */
export function validateCliWhere(
  options: ValidateCliWhereOptions
): ValidateCliWhereResult {
  const whereExpressions = options.whereExpressions ?? [];

  if (!options.typePath || whereExpressions.length === 0) {
    return { ok: true, errors: [] };
  }

  const validation = validateWhereExpressions(
    whereExpressions,
    options.schema,
    options.typePath
  );

  return {
    ok: validation.valid,
    errors: validation.errors,
  };
}
