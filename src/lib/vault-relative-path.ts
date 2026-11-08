import { relative, sep } from 'path';

/**
 * A path spelled with forward slashes, as discovery reports note paths and as
 * wikilinks spell folders. Only the platform's own separator changes: on Linux
 * and macOS a backslash is a filename character or a glob escape, not a separator.
 */
export function withForwardSlashes(path: string): string {
  return path.split(sep).join('/');
}

/**
 * A path glob spelled with forward slashes. On Windows a backslash stays an escape
 * only before a glob character a filename can hold, as in `\[draft\].md`. `*` and
 * `?` can't appear in a Windows filename, so `Ideas\*` means the folder's contents.
 */
export function globWithForwardSlashes(pattern: string): string {
  return sep === '\\' ? pattern.replace(/\\(?![[\](){}!+@])/g, '/') : pattern;
}

/** A file's path relative to the vault, with forward slashes on every platform. */
export function vaultRelativePath(vaultDir: string, filePath: string): string {
  return withForwardSlashes(relative(vaultDir, filePath));
}
