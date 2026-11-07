import { relative, sep } from 'path';

/**
 * A path spelled with forward slashes, as discovery reports note paths and as
 * wikilinks spell folders. Only the platform's own separator changes: on Linux
 * and macOS a backslash is a filename character or a glob escape, not a separator.
 */
export function withForwardSlashes(path: string): string {
  return path.split(sep).join('/');
}

/** A file's path relative to the vault, with forward slashes on every platform. */
export function vaultRelativePath(vaultDir: string, filePath: string): string {
  return withForwardSlashes(relative(vaultDir, filePath));
}
