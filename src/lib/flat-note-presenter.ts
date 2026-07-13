import { basename, relative } from 'path';

export type FlatNoteOutputFormat = 'paths' | 'link';

/**
 * Render an already-ordered collection of note paths for the two flat,
 * line-oriented output formats shared by `list` and `recent`.
 *
 * Selection, ordering, filtering, and de-duplication deliberately happen
 * before this boundary. In particular, duplicate basenames remain duplicate
 * wikilink lines. An empty collection produces zero bytes; otherwise every
 * entry, including the final one, is newline-terminated.
 */
export function renderFlatNotePaths(
  paths: readonly string[],
  vaultDir: string,
  format: FlatNoteOutputFormat
): string {
  if (paths.length === 0) return '';

  const lines = format === 'paths'
    ? paths.map(path => relative(vaultDir, path))
    : paths.map(path => `[[${basename(path, '.md')}]]`);
  return `${lines.join('\n')}\n`;
}
