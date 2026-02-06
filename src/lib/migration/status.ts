import type { Schema } from '../../types/schema.js';
import type { SchemaSnapshot } from '../../types/migration.js';

export interface MigrationStatus {
  hasSnapshot: boolean;
  pending: boolean;
  fromVersion?: string;
  toVersion?: string;
}

function schemaToComparableJson(schema: Schema): string {
  return JSON.stringify(schema);
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

  const pending = schemaToComparableJson(currentSchema) !== schemaToComparableJson(snapshot.schema);

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
