import { join } from 'path';
import { ExitCodes, jsonError } from '../../lib/output.js';
import { sanitizeFilenameBase, type FilenameTransformation } from '../../lib/filename.js';
import type { CreationMode } from './types.js';
import { throwJsonError } from './errors.js';

export interface NotePathResult {
  path: string;
  nameTransformed?: FilenameTransformation;
}

export function buildNotePath(
  outputDir: string,
  itemName: string,
  mode: CreationMode,
  existingTransformation?: FilenameTransformation
): NotePathResult {
  const sanitization = sanitizeFilenameBase(itemName);
  const sanitizedItemName = sanitization.sanitized;
  if (!sanitizedItemName) {
    if (mode === 'json') {
      throwJsonError(jsonError('Invalid note name (empty after sanitizing)'), ExitCodes.VALIDATION_ERROR);
    }
    throw new Error('Invalid name (empty after sanitizing)');
  }

  const filename = `${sanitizedItemName}.md`;
  const nameTransformed = existingTransformation ?? sanitization.transformation;
  return {
    path: join(outputDir, filename),
    ...(nameTransformed ? { nameTransformed } : {}),
  };
}
