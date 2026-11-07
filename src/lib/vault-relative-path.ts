import { relative, sep } from 'path';

/**
 * A file's path relative to the vault, with forward slashes on every platform,
 * as discovery reports note paths and as wikilinks spell folders.
 */
export function vaultRelativePath(vaultDir: string, filePath: string): string {
  return relative(vaultDir, filePath).split(sep).join('/');
}
