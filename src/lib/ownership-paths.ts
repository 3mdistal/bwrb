import { dirname, join } from 'path';

export function getOwnedChildFolder(ownerPath: string, ownedFieldName: string): string {
  return join(dirname(ownerPath), ownedFieldName);
}

export function getOwnedChildFolderFromOwnerDir(ownerDir: string, ownedFieldName: string): string {
  return join(ownerDir, ownedFieldName);
}
