/**
 * Filename safety helpers shared by note creation and filename patterns.
 */

// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|\x00-\x1F]/g;

export interface FilenameTransformation {
  original: string;
  sanitized: string;
  filename: string;
}

export interface FilenameSanitizationResult {
  sanitized: string;
  transformation?: FilenameTransformation;
}

export function sanitizeFilenameBase(name: string): FilenameSanitizationResult {
  const sanitized = name
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();

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
