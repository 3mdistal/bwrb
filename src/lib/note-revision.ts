import { createHash } from 'crypto';

/** Opaque observation token for the exact note content Bowerbird read. */
export function noteRevision(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class RevisionMismatchError extends Error {
  constructor(
    public readonly expectedRevision: string,
    public readonly currentRevision: string
  ) {
    super('Note changed since it was read. Reread it and retry with the current revision.');
    this.name = 'RevisionMismatchError';
  }
}

/** Throw a stable structured error when an observation token is stale. */
export function assertExpectedRevision(expectedRevision: string, raw: string): void {
  const currentRevision = noteRevision(raw);
  if (expectedRevision !== currentRevision) {
    throw new RevisionMismatchError(expectedRevision, currentRevision);
  }
}
