import { isAbsolute, posix, win32 } from 'path';
import { realpath } from 'fs/promises';

/**
 * Normalize one literal vault-relative path for `audit --exact-path`.
 *
 * Exact paths deliberately use POSIX separators because audit reports
 * vault-relative paths that way on every platform. Rejecting aliases instead
 * of normalizing them keeps callers' requested set machine-verifiable.
 */
export function normalizeExactAuditPath(value: string): string {
  if (value.length === 0) {
    throw new Error('--exact-path must not be empty');
  }
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`--exact-path must be vault-relative: ${JSON.stringify(value)}`);
  }
  if (value.includes('\\')) {
    throw new Error(`--exact-path must use vault-relative POSIX separators: ${JSON.stringify(value)}`);
  }

  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`--exact-path must be normalized and must not traverse: ${JSON.stringify(value)}`);
  }

  return normalized;
}

/** Validate, deduplicate, and deterministically order exact audit paths. */
export function normalizeExactAuditPaths(values: string[]): string[] {
  const paths = values.map(normalizeExactAuditPath);
  const unique = new Set<string>();
  for (const path of paths) {
    if (unique.has(path)) {
      throw new Error(`--exact-path was provided more than once: ${JSON.stringify(path)}`);
    }
    unique.add(path);
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b, 'en'));
}

/** Reject two requested spellings that resolve to the same physical note. */
export async function assertCanonicalExactAuditPaths(
  files: Array<{ path: string; relativePath: string }>,
  resolveCanonicalPath: (path: string) => Promise<string> = realpath
): Promise<void> {
  const selectedByCanonicalPath = new Map<string, string>();
  for (const file of files) {
    const canonicalPath = await resolveCanonicalPath(file.path);
    const existing = selectedByCanonicalPath.get(canonicalPath);
    if (existing !== undefined) {
      throw new Error(
        `--exact-path is ambiguous because ${JSON.stringify(existing)} and ${JSON.stringify(file.relativePath)} resolve to the same file`
      );
    }
    selectedByCanonicalPath.set(canonicalPath, file.relativePath);
  }
}
