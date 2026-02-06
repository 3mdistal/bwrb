import { join } from 'path';
import { ExitCodes, jsonError } from '../../lib/output.js';
import type { CreationMode } from './types.js';
import { throwJsonError } from './errors.js';

// eslint-disable-next-line no-control-regex
const INVALID_ITEM_NAME_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;

function sanitizeItemNameForFilename(name: string): string {
  return name.replace(INVALID_ITEM_NAME_CHARS, '').trim();
}

export function buildNotePath(outputDir: string, itemName: string, mode: CreationMode): string {
  const sanitizedItemName = sanitizeItemNameForFilename(itemName);
  if (!sanitizedItemName) {
    if (mode === 'json') {
      throwJsonError(jsonError('Invalid note name (empty after sanitizing)'), ExitCodes.VALIDATION_ERROR);
    }
    throw new Error('Invalid name (empty after sanitizing)');
  }

  return join(outputDir, `${sanitizedItemName}.md`);
}
