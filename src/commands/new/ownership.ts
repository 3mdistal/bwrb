import {
  typeCanBeOwned,
  getPossibleOwnerTypes,
  findOwnerNotes,
  type OwnerNoteRef,
} from '../../lib/vault.js';
import { promptSelection, printWarning } from '../../lib/prompt.js';
import { UserCancelledError } from '../../lib/errors.js';
import { ExitCodes, jsonError } from '../../lib/output.js';
import type { LoadedSchema, ResolvedType } from '../../types/schema.js';
import type { OwnershipMode } from './types.js';
import { throwJsonError } from './errors.js';

interface OwnershipDecision {
  isOwned: boolean;
  owner?: OwnerNoteRef;
  fieldName?: string;
}

export async function resolveInteractiveOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  ownerArg?: string,
  standaloneArg?: boolean
): Promise<OwnershipMode> {
  const canBeOwned = typeCanBeOwned(schema, typeName);
  if (canBeOwned && !standaloneArg) {
    const ownershipDecision = await resolveOwnership(schema, vaultDir, typeName, ownerArg);
    if (ownershipDecision.isOwned && ownershipDecision.owner && ownershipDecision.fieldName) {
      return { kind: 'owned', owner: ownershipDecision.owner, fieldName: ownershipDecision.fieldName };
    }
  }

  return { kind: 'pooled' };
}

export async function resolveJsonOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  ownershipOptions?: { owner?: string | undefined; standalone?: boolean | undefined }
): Promise<OwnershipMode> {
  const ownerArg = ownershipOptions?.owner;
  const standaloneArg = ownershipOptions?.standalone;

  if (ownerArg && standaloneArg) {
    throwJsonError(jsonError('Cannot use both --owner and --standalone flags together'), ExitCodes.VALIDATION_ERROR);
  }

  const typeName = typeDef.name;
  const canBeOwned = typeCanBeOwned(schema, typeName);

  if (standaloneArg && !canBeOwned) {
    throwJsonError(
      jsonError(`Type '${typePath}' cannot be owned, so --standalone is not applicable.`),
      ExitCodes.VALIDATION_ERROR
    );
  }

  if (ownerArg) {
    if (!canBeOwned) {
      throwJsonError(
        jsonError(`Type '${typePath}' cannot be owned. Remove the --owner flag.`),
        ExitCodes.VALIDATION_ERROR
      );
    }

    const owner = await findOwnerFromArg(schema, vaultDir, typeName, ownerArg);
    if (!owner) {
      throwJsonError(jsonError(`Owner not found: ${ownerArg}`), ExitCodes.VALIDATION_ERROR);
    }
    const fieldName = getOwnedFieldNameForOwner(schema, typeName, owner.ownerType);
    if (!fieldName) {
      throwJsonError(jsonError(`Owner type '${owner.ownerType}' does not own type '${typeName}'`), ExitCodes.SCHEMA_ERROR);
    }
    return { kind: 'owned', owner, fieldName };
  }

  return { kind: 'pooled' };
}

async function resolveOwnership(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  ownerArg?: string
): Promise<OwnershipDecision> {
  if (ownerArg) {
    const owner = await findOwnerFromArg(schema, vaultDir, typeName, ownerArg);
    if (!owner) {
      throw new Error(`Owner not found: ${ownerArg}`);
    }
    const fieldName = getOwnedFieldNameForOwner(schema, typeName, owner.ownerType);
    if (!fieldName) {
      throw new Error(`Owner type '${owner.ownerType}' does not own type '${typeName}'`);
    }
    return { isOwned: true, owner, fieldName };
  }

  const ownerTypes = getPossibleOwnerTypes(schema, typeName);
  if (ownerTypes.length === 0) {
    return { isOwned: false };
  }

  let hasAnyOwners = false;
  for (const ownerInfo of ownerTypes) {
    const owners = await findOwnerNotes(schema, vaultDir, ownerInfo.ownerType);
    if (owners.length > 0) {
      hasAnyOwners = true;
      break;
    }
  }

  if (!hasAnyOwners) {
    return { isOwned: false };
  }

  const options: string[] = ['Standalone (shared)'];
  for (const ownerInfo of ownerTypes) {
    options.push(`Owned by a ${ownerInfo.ownerType}`);
  }

  const selected = await promptSelection('This type can be owned. Create as:', options);
  if (selected === null) {
    throw new UserCancelledError();
  }

  if (selected === 'Standalone (shared)') {
    return { isOwned: false };
  }

  const match = selected.match(/^Owned by a (.+)$/);
  if (!match) {
    return { isOwned: false };
  }

  const selectedOwnerType = match[1]!;
  const ownerInfo = ownerTypes.find(info => info.ownerType === selectedOwnerType);
  if (!ownerInfo) {
    return { isOwned: false };
  }

  const owners = await findOwnerNotes(schema, vaultDir, selectedOwnerType);
  if (owners.length === 0) {
    printWarning(`No ${selectedOwnerType} notes found. Creating as standalone.`);
    return { isOwned: false };
  }

  const ownerOptions = owners.map(o => o.ownerName);
  const selectedOwner = await promptSelection(`Select ${selectedOwnerType}:`, ownerOptions);
  if (selectedOwner === null) {
    throw new UserCancelledError();
  }

  const owner = owners.find(o => o.ownerName === selectedOwner);
  if (!owner) {
    throw new Error(`Owner not found: ${selectedOwner}`);
  }

  return { isOwned: true, owner, fieldName: ownerInfo.fieldName };
}

function getOwnedFieldNameForOwner(
  schema: LoadedSchema,
  childTypeName: string,
  ownerTypeName: string
): string | undefined {
  const ownerTypes = getPossibleOwnerTypes(schema, childTypeName);
  const ownerInfo = ownerTypes.find(info => info.ownerType === ownerTypeName);
  return ownerInfo?.fieldName;
}

async function findOwnerFromArg(
  schema: LoadedSchema,
  vaultDir: string,
  childTypeName: string,
  ownerArg: string
): Promise<OwnerNoteRef | undefined> {
  const ownerName = ownerArg
    .replace(/^"/, '').replace(/"$/, '')
    .replace(/^\[\[/, '').replace(/\]\]$/, '');

  const ownerTypes = getPossibleOwnerTypes(schema, childTypeName);

  for (const ownerInfo of ownerTypes) {
    const owners = await findOwnerNotes(schema, vaultDir, ownerInfo.ownerType);
    const match = owners.find(o => o.ownerName === ownerName);
    if (match) {
      return match;
    }
  }

  return undefined;
}
