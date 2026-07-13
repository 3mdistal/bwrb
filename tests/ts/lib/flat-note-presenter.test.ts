import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { renderFlatNotePaths } from '../../../src/lib/flat-note-presenter.js';

describe('renderFlatNotePaths', () => {
  const vaultDir = join('tmp', 'vault');

  it('renders ordered relative paths with a final newline', () => {
    expect(renderFlatNotePaths([
      join(vaultDir, 'Ideas', 'Another Idea.md'),
      join(vaultDir, 'Ideas', 'Sample Idea.md'),
    ], vaultDir, 'paths')).toBe('Ideas/Another Idea.md\nIdeas/Sample Idea.md\n');
  });

  it('renders simple basename links without collapsing duplicate names', () => {
    expect(renderFlatNotePaths([
      join(vaultDir, 'One', 'Duplicate.md'),
      join(vaultDir, 'Two', 'Duplicate.md'),
    ], vaultDir, 'link')).toBe('[[Duplicate]]\n[[Duplicate]]\n');
  });

  it('renders an empty collection as zero bytes', () => {
    expect(renderFlatNotePaths([], vaultDir, 'paths')).toBe('');
    expect(renderFlatNotePaths([], vaultDir, 'link')).toBe('');
  });
});
