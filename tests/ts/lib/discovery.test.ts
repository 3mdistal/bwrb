import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';
import {
  loadGitignore,
  loadIgnoreMatcher,
  getExcludedDirectories,
  collectAllMarkdownFiles,
  collectAllMarkdownFilenames,
  discoverManagedFiles,
  collectFilesForType,
  collectPooledFiles,
  findSimilarFiles,
  levenshteinDistance,
  getTypeOutputDirs,
  isInTypeOutputDir,
  discoverAllTypeFiles,
  discoverUnmanagedFiles,
  discoverFilesForNavigation,
  type ManagedFile,
} from '../../../src/lib/discovery.js';
import { loadSchema } from '../../../src/lib/schema.js';
import type { LoadedSchema } from '../../../src/types/schema.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';

describe('Discovery', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('loadGitignore', () => {
    it('should return null when no .gitignore exists', async () => {
      const result = await loadGitignore(vaultDir);
      expect(result).toBeNull();
    });

    it('should load and parse .gitignore file', async () => {
      await writeFile(join(vaultDir, '.gitignore'), 'node_modules/\n*.log');
      const result = await loadGitignore(vaultDir);
      
      expect(result).not.toBeNull();
      expect(result!.ignores('node_modules/foo')).toBe(true);
      expect(result!.ignores('error.log')).toBe(true);
      expect(result!.ignores('Ideas/Test.md')).toBe(false);
    });
  });

  describe('loadIgnoreMatcher', () => {
    it('should include .bwrbignore patterns', async () => {
      await writeFile(join(vaultDir, '.bwrbignore'), 'Ideas/');

      const excluded = new Set<string>();
      const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);

      expect(ignoreMatcher.ignores('Ideas/Sample Idea.md')).toBe(true);
    });

    it('should not allow unignoring hidden directories', async () => {
      await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
      await writeFile(join(vaultDir, '.bwrb', 'Secret.md'), '---\ntype: idea\n---\n');
      await writeFile(join(vaultDir, '.bwrbignore'), '!/.bwrb/**\n!.bwrb/**');

      const excluded = new Set<string>();
      const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);

      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, ignoreMatcher);
      const paths = files.map(f => f.relativePath);
      expect(paths.some(p => p.startsWith('.bwrb/'))).toBe(false);
    });

    it('should allow .bwrbignore to negate .gitignore', async () => {
      await writeFile(join(vaultDir, '.gitignore'), 'Ideas/');
      // Gitignore semantics: to re-include files under an ignored directory,
      // you must also unignore the directory itself.
      await writeFile(join(vaultDir, '.bwrbignore'), '!Ideas/\n!Ideas/**');

      const excluded = new Set<string>();
      const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);

      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, ignoreMatcher);
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
    });

    it('should apply nested .bwrbignore relative to its directory', async () => {
      await mkdir(join(vaultDir, 'Ideas', 'Sub'), { recursive: true });
      await writeFile(join(vaultDir, 'Ideas', '.bwrbignore'), 'secret.md');
      await writeFile(join(vaultDir, 'Ideas', 'secret.md'), '---\ntype: idea\n---\n');
      await writeFile(join(vaultDir, 'Ideas', 'Sub', 'secret.md'), '---\ntype: idea\n---\n');

      const excluded = new Set<string>();
      const ignoreMatcher = await loadIgnoreMatcher(vaultDir, excluded);

      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, ignoreMatcher);
      const paths = files.map(f => f.relativePath);

      expect(paths).not.toContain('Ideas/secret.md');
      expect(paths).not.toContain('Ideas/Sub/secret.md');
    });
  });

  describe('getExcludedDirectories', () => {
    it('should always exclude .bwrb', () => {
      const excluded = getExcludedDirectories(schema);
      expect(excluded.has('.bwrb')).toBe(true);
    });

    it('should include schema-configured exclusions', () => {
      const excluded = getExcludedDirectories(schema);
      expect(excluded.has('Templates')).toBe(true);
    });

    it('should respect BWRB_EXCLUDE env var (and legacy alias)', () => {
      const originalExclude = process.env.BWRB_EXCLUDE;
      const originalAuditExclude = process.env.BWRB_AUDIT_EXCLUDE;

      try {
        process.env.BWRB_EXCLUDE = 'Archive';
        process.env.BWRB_AUDIT_EXCLUDE = 'Drafts/';

        const excluded = getExcludedDirectories(schema);
        expect(excluded.has('Archive')).toBe(true);
        expect(excluded.has('Drafts')).toBe(true); // Trailing slash normalized
      } finally {
        if (originalExclude === undefined) {
          delete process.env.BWRB_EXCLUDE;
        } else {
          process.env.BWRB_EXCLUDE = originalExclude;
        }

        if (originalAuditExclude === undefined) {
          delete process.env.BWRB_AUDIT_EXCLUDE;
        } else {
          process.env.BWRB_AUDIT_EXCLUDE = originalAuditExclude;
        }
      }
    });
  });

  describe('collectAllMarkdownFiles', () => {
    it('should collect all markdown files recursively', async () => {
      const excluded = new Set<string>();
      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, null);
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Ideas/Another Idea.md');
      expect(paths).toContain('Objectives/Tasks/Sample Task.md');
    });

    it('should respect excluded directories', async () => {
      const excluded = new Set(['Templates']);
      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, null);
      
      const paths = files.map(f => f.relativePath);
      expect(paths.some(p => p.startsWith('Templates/'))).toBe(false);
    });

    it('should skip hidden directories', async () => {
      await mkdir(join(vaultDir, '.hidden'), { recursive: true });
      await writeFile(join(vaultDir, '.hidden', 'secret.md'), '---\ntype: idea\n---\n');
      
      const excluded = new Set<string>();
      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, null);
      
      const paths = files.map(f => f.relativePath);
      expect(paths.some(p => p.includes('.hidden'))).toBe(false);
    });

    it('should respect gitignore patterns', async () => {
      await writeFile(join(vaultDir, '.gitignore'), 'Ideas/');
      const gitignore = await loadGitignore(vaultDir);
      
      const excluded = new Set<string>();
      const files = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
      
      const paths = files.map(f => f.relativePath);
      expect(paths.some(p => p.startsWith('Ideas/'))).toBe(false);
    });
  });

  describe('collectAllMarkdownFilenames', () => {
    it('should return basenames without extension', async () => {
      const filenames = await collectAllMarkdownFilenames(schema, vaultDir);
      
      expect(filenames.has('Sample Idea')).toBe(true);
      expect(filenames.has('Sample Task')).toBe(true);
    });

    it('should return relative paths without extension', async () => {
      const filenames = await collectAllMarkdownFilenames(schema, vaultDir);
      
      expect(filenames.has('Ideas/Sample Idea')).toBe(true);
      expect(filenames.has('Objectives/Tasks/Sample Task')).toBe(true);
    });
  });

  describe('discoverManagedFiles', () => {
    it('should scan entire vault when no type specified', async () => {
      const files = await discoverManagedFiles(schema, vaultDir);
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Objectives/Tasks/Sample Task.md');
    });

    it('should only scan specific type when type specified', async () => {
      const files = await discoverManagedFiles(schema, vaultDir, 'idea');
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths.some(p => p.startsWith('Objectives/'))).toBe(false);
    });

    it('should scan parent type with subtypes recursively', async () => {
      const files = await discoverManagedFiles(schema, vaultDir, 'objective');
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Objectives/Tasks/Sample Task.md');
      expect(paths).toContain('Objectives/Milestones/Active Milestone.md');
    });

    it('should include expected type in results', async () => {
      const files = await discoverManagedFiles(schema, vaultDir, 'idea');
      
      expect(files.every(f => f.expectedType === 'idea')).toBe(true);
    });
  });

  describe('collectFilesForType', () => {
    it('should collect files for a specific leaf type', async () => {
      const files = await collectFilesForType(schema, vaultDir, 'task');
      
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]!.expectedType).toBe('task');
    });

    it('should return empty for invalid type', async () => {
      const files = await collectFilesForType(schema, vaultDir, 'nonexistent');
      expect(files).toEqual([]);
    });
  });

  describe('collectPooledFiles', () => {
    it('should collect files from a flat directory', async () => {
      const excluded = getExcludedDirectories(schema);
      const gitignore = await loadGitignore(vaultDir);
      const files = await collectPooledFiles(vaultDir, 'Ideas', 'idea', excluded, gitignore);
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Ideas/Another Idea.md');
    });

    it('should set expectedType on all files', async () => {
      const excluded = getExcludedDirectories(schema);
      const gitignore = await loadGitignore(vaultDir);
      const files = await collectPooledFiles(vaultDir, 'Ideas', 'idea', excluded, gitignore);
      expect(files.every(f => f.expectedType === 'idea')).toBe(true);
    });

    it('should return empty for non-existent directory', async () => {
      const excluded = getExcludedDirectories(schema);
      const gitignore = await loadGitignore(vaultDir);
      const files = await collectPooledFiles(vaultDir, 'Nonexistent', 'test', excluded, gitignore);
      expect(files).toEqual([]);
    });
  });

  describe('findSimilarFiles', () => {
    it('should find exact prefix matches', () => {
      const allFiles = new Set(['Sample Idea', 'Sample Task', 'Another Idea', 'Project Notes']);
      const similar = findSimilarFiles('Sample', allFiles);
      
      expect(similar).toContain('Sample Idea');
      expect(similar).toContain('Sample Task');
    });

    it('should find files containing the target', () => {
      const allFiles = new Set(['My Idea', 'Your Idea', 'Task List', 'Notes']);
      const similar = findSimilarFiles('Idea', allFiles);
      
      expect(similar).toContain('My Idea');
      expect(similar).toContain('Your Idea');
    });

    it('should find Levenshtein-close matches', () => {
      const allFiles = new Set(['Project', 'Projet', 'Product', 'Progress']);
      const similar = findSimilarFiles('Projct', allFiles);
      
      // "Project" has distance 1 from "Projct"
      expect(similar).toContain('Project');
    });

    it('should limit results to maxResults', () => {
      const allFiles = new Set(['Test1', 'Test2', 'Test3', 'Test4', 'Test5', 'Test6', 'Test7']);
      const similar = findSimilarFiles('Test', allFiles, 3);
      
      expect(similar.length).toBeLessThanOrEqual(3);
    });

    it('should not include exact case-insensitive matches', () => {
      const allFiles = new Set(['sample', 'Sample Idea', 'sample task']);
      const similar = findSimilarFiles('sample', allFiles);
      
      // 'sample' should not be in results since it's an exact match
      expect(similar).not.toContain('sample');
    });

    it('should not match files with leading underscores due to empty string bug', () => {
      // Regression test: files like "_daily-note" split into ["", "daily", "note"]
      // Empty strings match everything via "".includes(w) being false but w.includes("") being true
      const allFiles = new Set(['_daily-note', 'improving Vampire _________', '___test___']);
      const similar = findSimilarFiles('abstract-bloom', allFiles);
      
      // None of these should match "abstract-bloom" - no meaningful word overlap
      expect(similar).not.toContain('_daily-note');
      expect(similar).not.toContain('improving Vampire _________');
      expect(similar).not.toContain('___test___');
    });

    it('should not match short substrings embedded in longer words', () => {
      // Regression test: "Jailbirds" contains "ai" but should not match file "AI"
      const allFiles = new Set(['AI', 'Resume', 'dreams']);
      
      const jailbirdsMatches = findSimilarFiles('Jailbirds', allFiles);
      expect(jailbirdsMatches).not.toContain('AI'); // "ai" is in "jailbirds" but too short
      
      const readmeMatches = findSimilarFiles('README', allFiles);
      expect(readmeMatches).not.toContain('Resume'); // Levenshtein 3 but too different proportionally
    });

    it('should match legitimately similar files', () => {
      const allFiles = new Set(['Bloob', 'house (de)constructs', 'birds whose bones are empty']);
      
      // "bloom" vs "Bloob" - 1 char difference, should match
      const bloomMatches = findSimilarFiles('bloom', allFiles);
      expect(bloomMatches).toContain('Bloob');
      
      // "Glass House" shares word "house" - should match
      const houseMatches = findSimilarFiles('Glass House', allFiles);
      expect(houseMatches).toContain('house (de)constructs');
      
      // "Jailbirds" shares word "birds" - should match
      const birdsMatches = findSimilarFiles('Jailbirds', allFiles);
      expect(birdsMatches).toContain('birds whose bones are empty');
    });
  });

  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('test', 'test')).toBe(0);
    });

    it('should return string length for empty comparison', () => {
      expect(levenshteinDistance('test', '')).toBe(4);
      expect(levenshteinDistance('', 'test')).toBe(4);
    });

    it('should calculate single character changes', () => {
      expect(levenshteinDistance('test', 'tast')).toBe(1); // substitution
      expect(levenshteinDistance('test', 'tests')).toBe(1); // insertion
      expect(levenshteinDistance('tests', 'test')).toBe(1); // deletion
    });

    it('should calculate multiple character changes', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    });
  });

  // ============================================================================
  // Type-Aware Discovery Tests (for navigation/search consistency fix)
  // ============================================================================

  describe('getTypeOutputDirs', () => {
    it('should return output directories for all concrete types', () => {
      const dirs = getTypeOutputDirs(schema);
      
      expect(dirs.has('Ideas')).toBe(true);
      expect(dirs.has('Objectives/Tasks')).toBe(true);
      expect(dirs.has('Objectives/Milestones')).toBe(true);
    });

    it('should not include meta type', () => {
      const dirs = getTypeOutputDirs(schema);
      // meta has no output_dir, so it shouldn't appear
      expect(dirs.size).toBeGreaterThan(0);
    });
  });

  describe('isInTypeOutputDir', () => {
    it('should return true for files directly in type directory', () => {
      const dirs = new Set(['Ideas', 'Objectives/Tasks']);
      
      expect(isInTypeOutputDir('Ideas/My Note.md', dirs)).toBe(true);
      expect(isInTypeOutputDir('Objectives/Tasks/My Task.md', dirs)).toBe(true);
    });

    it('should return false for files not in type directories', () => {
      const dirs = new Set(['Ideas', 'Objectives/Tasks']);
      
      expect(isInTypeOutputDir('Archive/Old Note.md', dirs)).toBe(false);
      expect(isInTypeOutputDir('Random/File.md', dirs)).toBe(false);
    });

    it('should return false for files in parent directories', () => {
      const dirs = new Set(['Objectives/Tasks']);
      
      // Objectives is parent of Objectives/Tasks, not a type dir itself
      expect(isInTypeOutputDir('Objectives/Some Note.md', dirs)).toBe(false);
    });

    it('should handle nested paths correctly', () => {
      const dirs = new Set(['Objectives/Tasks']);
      
      // Subdirectories of type dirs should still match
      expect(isInTypeOutputDir('Objectives/Tasks/Subtask/Note.md', dirs)).toBe(true);
    });

    it('should not match directories with similar prefixes (false positive guard)', () => {
      const dirs = new Set(['Ideas']);
      
      // Ideas2 should NOT match Ideas (must match Ideas/ exactly)
      expect(isInTypeOutputDir('Ideas2/Some Note.md', dirs)).toBe(false);
      expect(isInTypeOutputDir('IdeasArchive/Old.md', dirs)).toBe(false);
      
      // But Ideas/ should still match
      expect(isInTypeOutputDir('Ideas/Sample.md', dirs)).toBe(true);
    });
  });

  describe('discoverAllTypeFiles', () => {
    it('should collect files from all type directories', async () => {
      const files = await discoverAllTypeFiles(schema, vaultDir);
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Ideas/Another Idea.md');
      expect(paths).toContain('Objectives/Tasks/Sample Task.md');
      expect(paths).toContain('Objectives/Milestones/Active Milestone.md');
    });

    it('should respect .gitignore for type files', async () => {
      await writeFile(join(vaultDir, '.gitignore'), 'Ideas/');

      const files = await discoverAllTypeFiles(schema, vaultDir);
      const paths = files.map(f => f.relativePath);

      expect(paths).not.toContain('Ideas/Sample Idea.md');
      expect(paths).not.toContain('Ideas/Another Idea.md');
    });

    it('should deduplicate files across type hierarchies', async () => {
      const files = await discoverAllTypeFiles(schema, vaultDir);
      
      // Check for duplicates
      const paths = files.map(f => f.relativePath);
      const uniquePaths = new Set(paths);
      expect(paths.length).toBe(uniquePaths.size);
    });
  });

  describe('discoverUnmanagedFiles', () => {
    it('should find files not in any type directory', async () => {
      // Create an unmanaged file
      await mkdir(join(vaultDir, 'Random'), { recursive: true });
      await writeFile(join(vaultDir, 'Random', 'Unmanaged.md'), '---\ntitle: Test\n---\n');
      
      const files = await discoverUnmanagedFiles(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      expect(paths).toContain('Random/Unmanaged.md');
    });

    it('should NOT include files in type directories', async () => {
      const files = await discoverUnmanagedFiles(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      // Type files should not appear in unmanaged results
      expect(paths).not.toContain('Ideas/Sample Idea.md');
      expect(paths).not.toContain('Objectives/Tasks/Sample Task.md');
    });

    it('should respect ignored_directories for unmanaged files', async () => {
      // Create unmanaged file in an ignored directory
      await mkdir(join(vaultDir, 'Templates/Notes'), { recursive: true });
      await writeFile(join(vaultDir, 'Templates/Notes/Template.md'), '---\ntitle: Template\n---\n');
      
      const files = await discoverUnmanagedFiles(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      // File in Templates (ignored) should not appear
      expect(paths.some(p => p.startsWith('Templates/'))).toBe(false);
    });

    it('should respect .gitignore for unmanaged files', async () => {
      // Create unmanaged file
      await mkdir(join(vaultDir, 'Archive'), { recursive: true });
      await writeFile(join(vaultDir, 'Archive', 'Old.md'), '---\ntitle: Old\n---\n');
      
      // Add to gitignore
      await writeFile(join(vaultDir, '.gitignore'), 'Archive/');
      
      const files = await discoverUnmanagedFiles(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      expect(paths.some(p => p.startsWith('Archive/'))).toBe(false);
    });
  });

  describe('discoverFilesForNavigation', () => {
    it('should combine type files and unmanaged files', async () => {
      // Create an unmanaged file
      await mkdir(join(vaultDir, 'Notes'), { recursive: true });
      await writeFile(join(vaultDir, 'Notes', 'Random.md'), '---\ntitle: Random\n---\n');
      
      const files = await discoverFilesForNavigation(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      // Should have type files
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Objectives/Tasks/Sample Task.md');
      
      // Should also have unmanaged files
      expect(paths).toContain('Notes/Random.md');
    });

    it('should respect .gitignore for type files', async () => {
      await writeFile(join(vaultDir, '.gitignore'), 'Ideas/');

      const files = await discoverFilesForNavigation(schema, vaultDir);
      const paths = files.map(f => f.relativePath);

      expect(paths).not.toContain('Ideas/Sample Idea.md');
      expect(paths).not.toContain('Ideas/Another Idea.md');
    });

    it('should exclude unmanaged files in gitignored directories', async () => {
      // Create unmanaged file in a directory we'll gitignore
      await mkdir(join(vaultDir, 'Drafts'), { recursive: true });
      await writeFile(join(vaultDir, 'Drafts', 'WIP.md'), '---\ntitle: WIP\n---\n');
      await writeFile(join(vaultDir, '.gitignore'), 'Drafts/');
      
      const files = await discoverFilesForNavigation(schema, vaultDir);
      const paths = files.map(f => f.relativePath);
      
      // Unmanaged file in gitignored dir should NOT be found
      expect(paths).not.toContain('Drafts/WIP.md');
    });

    it('should not have duplicates', async () => {
      const files = await discoverFilesForNavigation(schema, vaultDir);
      
      const paths = files.map(f => f.relativePath);
      const uniquePaths = new Set(paths);
      expect(paths.length).toBe(uniquePaths.size);
    });
  });
});
