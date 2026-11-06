import { dirname, join, posix } from 'path';

export function getOwnedChildFolder(ownerPath: string, ownedFieldName: string): string {
  return join(dirname(ownerPath), ownedFieldName);
}

/**
 * {@link getOwnedChildFolder} for a vault-relative owner path, with forward
 * slashes on every platform so it compares equal to discovery's note paths.
 */
export function getOwnedChildVaultFolder(ownerRelativePath: string, ownedFieldName: string): string {
  return posix.join(posix.dirname(ownerRelativePath), ownedFieldName);
}

export function getOwnedChildFolderFromOwnerDir(ownerDir: string, ownedFieldName: string): string {
  return join(ownerDir, ownedFieldName);
}
