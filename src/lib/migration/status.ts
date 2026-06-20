import type { Schema } from '../../types/schema.js';
import type { SchemaSnapshot } from '../../types/migration.js';
import { diffSchemas } from './diff.js';

export interface MigrationStatus {
  hasSnapshot: boolean;
  pending: boolean;
  fromVersion?: string;
  toVersion?: string;
}

export function getMigrationStatus(
  currentSchema: Schema,
  snapshot?: SchemaSnapshot
): MigrationStatus {
  const toVersion = currentSchema.schemaVersion;

  if (!snapshot) {
    const status: MigrationStatus = {
      hasSnapshot: false,
      pending: false,
    };

    if (toVersion) {
      status.toVersion = toVersion;
    }

    return status;
  }

  // `pending` means there are *migration-relevant* differences — not merely any
  // textual difference. Cosmetic edits (type/field/option descriptions, field
  // labels, key reordering) produce no migration ops, so they must not nag the
  // user to run a migration that `schema migrate` would itself report as empty.
  const plan = diffSchemas(
    snapshot.schema,
    currentSchema,
    snapshot.schemaVersion ?? '0.0.0',
    toVersion ?? '0.0.0'
  );
  const pending = plan.hasChanges;

  const status: MigrationStatus = {
    hasSnapshot: true,
    pending,
  };

  if (snapshot.schemaVersion) {
    status.fromVersion = snapshot.schemaVersion;
  }
  if (toVersion) {
    status.toVersion = toVersion;
  }

  return status;
}
