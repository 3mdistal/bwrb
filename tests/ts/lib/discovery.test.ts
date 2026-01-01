import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestVault, cleanupTestVault, TEST_SCHEMA } from '../fixtures/setup.js';
import {
  loadGitignore,
  getExcludedDirectories,
  collectAllMarkdownFiles,
  collectAllMarkdownFilenames,
  discoverManagedFiles,
  collectFilesForType,
  collectPooledFiles,
  collectInstanceGroupedFiles,
  findSimilarFiles,
  levenshteinDistance,
  type ManagedFile,
} from '../../../src/lib/discovery.js';
import type { Schema } from '../../../src/types/schema.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';

describe('Discovery', () => {
  let vaultDir: string;
  const schema: Schema = TEST_SCHEMA as unknown as Schema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
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

  describe('getExcludedDirectories', () => {
    it('should always exclude .pika', () => {
      const excluded = getExcludedDirectories(schema);
      expect(excluded.has('.pika')).toBe(true);
    });

    it('should include schema-configured exclusions', () => {
      const excluded = getExcludedDirectories(schema);
      expect(excluded.has('Templates')).toBe(true);
    });

    it('should respect PIKA_AUDIT_EXCLUDE env var', () => {
      const originalEnv = process.env.PIKA_AUDIT_EXCLUDE;
      try {
        process.env.PIKA_AUDIT_EXCLUDE = 'Archive,Drafts/';
        const excluded = getExcludedDirectories(schema);
        expect(excluded.has('Archive')).toBe(true);
        expect(excluded.has('Drafts')).toBe(true); // Trailing slash normalized
      } finally {
        if (originalEnv === undefined) {
          delete process.env.PIKA_AUDIT_EXCLUDE;
        } else {
          process.env.PIKA_AUDIT_EXCLUDE = originalEnv;
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
      const filenames = await collectAllMarkdownFilenames(vaultDir);
      
      expect(filenames.has('Sample Idea')).toBe(true);
      expect(filenames.has('Sample Task')).toBe(true);
    });

    it('should return relative paths without extension', async () => {
      const filenames = await collectAllMarkdownFilenames(vaultDir);
      
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
      const files = await collectFilesForType(schema, vaultDir, 'objective/task');
      
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]!.expectedType).toBe('objective/task');
    });

    it('should return empty for invalid type', async () => {
      const files = await collectFilesForType(schema, vaultDir, 'nonexistent');
      expect(files).toEqual([]);
    });
  });

  describe('collectPooledFiles', () => {
    it('should collect files from a flat directory', async () => {
      const files = await collectPooledFiles(vaultDir, 'Ideas', 'idea');
      
      const paths = files.map(f => f.relativePath);
      expect(paths).toContain('Ideas/Sample Idea.md');
      expect(paths).toContain('Ideas/Another Idea.md');
    });

    it('should set expectedType on all files', async () => {
      const files = await collectPooledFiles(vaultDir, 'Ideas', 'idea');
      expect(files.every(f => f.expectedType === 'idea')).toBe(true);
    });

    it('should return empty for non-existent directory', async () => {
      const files = await collectPooledFiles(vaultDir, 'Nonexistent', 'test');
      expect(files).toEqual([]);
    });
  });

  describe('collectInstanceGroupedFiles', () => {
    it('should collect files from instance-grouped directories', async () => {
      // Create an instance-grouped structure
      await mkdir(join(vaultDir, 'Projects/ProjectA'), { recursive: true });
      await mkdir(join(vaultDir, 'Projects/ProjectB'), { recursive: true });
      await writeFile(join(vaultDir, 'Projects/ProjectA', 'Note1.md'), '---\ntype: note\n---\n');
      await writeFile(join(vaultDir, 'Projects/ProjectB', 'Note2.md'), '---\ntype: note\n---\n');
      
      const files = await collectInstanceGroupedFiles(vaultDir, 'Projects', 'project');
      
      expect(files.length).toBe(2);
      expect(files.some(f => f.instance === 'ProjectA')).toBe(true);
      expect(files.some(f => f.instance === 'ProjectB')).toBe(true);
    });

    it('should set instance field correctly', async () => {
      await mkdir(join(vaultDir, 'Projects/MyProject'), { recursive: true });
      await writeFile(join(vaultDir, 'Projects/MyProject', 'Test.md'), '---\ntype: note\n---\n');
      
      const files = await collectInstanceGroupedFiles(vaultDir, 'Projects', 'project');
      
      const file = files.find(f => f.relativePath.includes('MyProject'));
      expect(file).toBeDefined();
      expect(file!.instance).toBe('MyProject');
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
});
