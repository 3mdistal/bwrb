import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import { buildNoteIndex, resolveNoteQuery, getShortestWikilinkTarget, generateWikilink } from '../../../src/lib/navigation.js';
import { loadSchema } from '../../../src/lib/schema.js';
import type { LoadedSchema } from '../../../src/types/schema.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('Navigation', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  it('should build a note index correctly', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    
    // Check byPath
    expect(index.byPath.has('Ideas/Sample Idea.md')).toBe(true);
    expect(index.byPath.has('Objectives/Tasks/Sample Task.md')).toBe(true);
    
    // Check byBasename
    expect(index.byBasename.has('Sample Idea')).toBe(true);
    expect(index.byBasename.get('Sample Idea')?.length).toBe(1);
    
    // Check allFiles
    expect(index.allFiles.length).toBeGreaterThan(0);
  });

  it('should resolve exact path query', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    const result = resolveNoteQuery(index, 'Ideas/Sample Idea.md');
    
    expect(result.exact).not.toBeNull();
    expect(result.exact?.relativePath).toBe('Ideas/Sample Idea.md');
    expect(result.isAmbiguous).toBe(false);
  });

  it('should resolve exact path query without extension', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    const result = resolveNoteQuery(index, 'Ideas/Sample Idea');
    
    expect(result.exact).not.toBeNull();
    expect(result.exact?.relativePath).toBe('Ideas/Sample Idea.md');
  });

  it('should resolve exact basename query', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    const result = resolveNoteQuery(index, 'Sample Idea');
    
    expect(result.exact).not.toBeNull();
    expect(result.exact?.relativePath).toBe('Ideas/Sample Idea.md');
  });

  it('should resolve case-insensitive basename query', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    const result = resolveNoteQuery(index, 'sample idea');
    
    expect(result.exact).not.toBeNull();
    expect(result.exact?.relativePath).toBe('Ideas/Sample Idea.md');
  });

  it('should handle fuzzy matches', async () => {
    const index = await buildNoteIndex(schema, vaultDir);
    // "Samp Ide" should fuzzy match "Sample Idea"
    const result = resolveNoteQuery(index, 'Samp Ide');
    
    expect(result.exact).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.some(c => c.relativePath === 'Ideas/Sample Idea.md')).toBe(true);
    // It might be ambiguous if it matches multiple things, or if it's the only fuzzy match
    // result.isAmbiguous depends on count > 0 (wait, logic says candidates.length > 0 => isAmbiguous=true for fuzzy)
    expect(result.isAmbiguous).toBe(true);
  });

  it('should handle ambiguous basenames', async () => {
    // Create a conflict
    // Ideas/Duplicate.md
    await writeFile(join(vaultDir, 'Ideas', 'Duplicate.md'), `---
type: idea
status: raw
---
`);
    // Objectives/Duplicate.md (Assuming we can put it there, or make another dir)
    // Use Objectives/Tasks/Duplicate.md
    await writeFile(join(vaultDir, 'Objectives/Tasks', 'Duplicate.md'), `---
type: objective
objective-type: task
status: backlog
---
`);

    const index = await buildNoteIndex(schema, vaultDir);
    const result = resolveNoteQuery(index, 'Duplicate');
    
    expect(result.exact).toBeNull();
    expect(result.isAmbiguous).toBe(true);
    expect(result.candidates.length).toBe(2);
  });

  describe('wikilink generation', () => {
    it('should use basename for unique files', async () => {
      const index = await buildNoteIndex(schema, vaultDir);
      const file = index.byPath.get('Ideas/Sample Idea.md')!;
      
      const target = getShortestWikilinkTarget(index, file);
      expect(target).toBe('Sample Idea');
    });

    it('should generate proper wikilink format', async () => {
      const index = await buildNoteIndex(schema, vaultDir);
      const file = index.byPath.get('Ideas/Sample Idea.md')!;
      
      const link = generateWikilink(index, file);
      expect(link).toBe('[[Sample Idea]]');
    });

    it('should use full path for non-unique basenames', async () => {
      // Create duplicate basename
      await writeFile(join(vaultDir, 'Ideas', 'Dup.md'), `---
type: idea
status: raw
---
`);
      await writeFile(join(vaultDir, 'Objectives/Tasks', 'Dup.md'), `---
type: objective
objective-type: task
status: backlog
---
`);

      const index = await buildNoteIndex(schema, vaultDir);
      const file = index.byPath.get('Ideas/Dup.md')!;
      
      const target = getShortestWikilinkTarget(index, file);
      expect(target).toBe('Ideas/Dup');
    });

    it('should generate path-based wikilink for non-unique basename', async () => {
      // Create duplicate basename
      await writeFile(join(vaultDir, 'Ideas', 'Shared.md'), `---
type: idea
status: raw
---
`);
      await writeFile(join(vaultDir, 'Objectives/Tasks', 'Shared.md'), `---
type: objective
objective-type: task
status: backlog
---
`);

      const index = await buildNoteIndex(schema, vaultDir);
      const file = index.byPath.get('Ideas/Shared.md')!;
      
      const link = generateWikilink(index, file);
      expect(link).toBe('[[Ideas/Shared]]');
    });
  });
});
