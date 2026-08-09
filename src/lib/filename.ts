/**
 * Filename safety helpers shared by note creation and filename patterns.
 */

import { createHash } from 'crypto';

// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;

/**
 * Maximum UTF-8 byte length of a Bowerbird markdown filename component.
 *
 * This deliberately leaves 63 bytes below the common 255-byte component limit:
 * `.md` is included here, and the remaining space accommodates the longest
 * same-directory temporary name produced by `writeFileAtomic`.
 */
export const FILENAME_COMPONENT_MAX_BYTES = 192;

/** Maximum UTF-8 byte length available to a filename base before `.md`. */
export const FILENAME_BASE_MAX_BYTES = FILENAME_COMPONENT_MAX_BYTES - '.md'.length;

const LONG_FILENAME_DIGEST_LENGTH = 16;
const LONG_FILENAME_DIGEST_SEPARATOR = '--';
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export interface FilenameTransformation {
  original: string;
  sanitized: string;
  filename: string;
}

export interface FilenameSanitizationResult {
  sanitized: string;
  transformation?: FilenameTransformation;
}

/** Whether a basename is illegal on Windows, including device-name extensions. */
export function isWindowsReservedBasename(name: string): boolean {
  return WINDOWS_RESERVED_BASENAME.test(name.replace(/[. ]+$/, ''));
}

/**
 * Whether a filename base can be used unchanged as a Bowerbird markdown name.
 * This is intentionally based on the shared normalizer so audit classification
 * and creation cannot disagree about what needs repair.
 */
export function isFilenameBaseSafe(name: string): boolean {
  return sanitizeFilenameBase(name).transformation === undefined;
}

function truncateUtf8AtCodePointBoundary(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;

  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }

  return result;
}

function shortenFilenameBase(value: string, original: string): string {
  if (Buffer.byteLength(value, 'utf8') <= FILENAME_BASE_MAX_BYTES) return value;

  const digest = createHash('sha256')
    .update(original, 'utf8')
    .digest('hex')
    .slice(0, LONG_FILENAME_DIGEST_LENGTH);
  const suffix = `${LONG_FILENAME_DIGEST_SEPARATOR}${digest}`;
  const prefix = truncateUtf8AtCodePointBoundary(
    value,
    FILENAME_BASE_MAX_BYTES - Buffer.byteLength(suffix, 'utf8')
  );
  return `${prefix}${suffix}`;
}

export function sanitizeFilenameBase(name: string): FilenameSanitizationResult {
  let sanitized = name
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');

  if (isWindowsReservedBasename(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  sanitized = shortenFilenameBase(sanitized, name);

  if (sanitized === name) {
    return { sanitized };
  }

  return {
    sanitized,
    transformation: {
      original: name,
      sanitized,
      filename: `${sanitized}.md`,
    },
  };
}
