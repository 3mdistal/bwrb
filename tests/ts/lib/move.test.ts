import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findAllMarkdownFiles,
  wikilinkMatchesFile,
  findWikilinksToFile,
  generateUpdatedWikilink,
  updateWikilinksInContent,
  executeBulkMove,
} from '../../../src/lib/bulk/move.js';

describe('move utilities', () => {
  describe('findAllMarkdownFiles', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-move-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should find all markdown files recursively', async () => {
      await mkdir(join(tempDir, 'subdir'));
      await writeFile(join(tempDir, 'file1.md'), '# File 1');
      await writeFile(join(tempDir, 'file2.txt'), 'Not markdown');
      await writeFile(join(tempDir, 'subdir', 'file3.md'), '# File 3');

      const files = await findAllMarkdownFiles(tempDir);

      expect(files).toHaveLength(2);
      expect(files.some(f => f.endsWith('file1.md'))).toBe(true);
      expect(files.some(f => f.endsWith('file3.md'))).toBe(true);
      expect(files.some(f => f.endsWith('file2.txt'))).toBe(false);
    });

    it('should skip hidden directories', async () => {
      await mkdir(join(tempDir, '.hidden'));
      await writeFile(join(tempDir, 'visible.md'), '# Visible');
      await writeFile(join(tempDir, '.hidden', 'hidden.md'), '# Hidden');

      const files = await findAllMarkdownFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('visible.md');
    });
  });

  describe('wikilinkMatchesFile', () => {
    const vaultDir = '/vault';

    it('should match by basename', () => {
      expect(wikilinkMatchesFile('MyFile', '/vault/Notes/MyFile.md', vaultDir)).toBe(true);
      expect(wikilinkMatchesFile('OtherFile', '/vault/Notes/MyFile.md', vaultDir)).toBe(false);
    });

    it('should match by full relative path', () => {
      expect(wikilinkMatchesFile('Notes/MyFile', '/vault/Notes/MyFile.md', vaultDir)).toBe(true);
      expect(wikilinkMatchesFile('Other/MyFile', '/vault/Notes/MyFile.md', vaultDir)).toBe(false);
    });

    it('should handle .md extension in link', () => {
      expect(wikilinkMatchesFile('MyFile.md', '/vault/Notes/MyFile.md', vaultDir)).toBe(true);
    });

    it('should match partial paths ending with filename', () => {
      expect(wikilinkMatchesFile('Notes/MyFile', '/vault/Notes/MyFile.md', vaultDir)).toBe(true);
    });
  });

  describe('generateUpdatedWikilink', () => {
    const vaultDir = '/vault';

    it('should use basename when filename is unique', () => {
      const allFiles = ['/vault/Archive/Ideas/MyIdea.md'];
      const result = generateUpdatedWikilink(
        '[[MyIdea]]',
        'MyIdea',
        '/vault/Archive/Ideas/MyIdea.md',
        vaultDir,
        allFiles
      );
      expect(result).toBe('[[MyIdea]]');
    });

    it('should use path when filename is not unique', () => {
      const allFiles = [
        '/vault/Archive/Ideas/MyIdea.md',
        '/vault/Notes/MyIdea.md',
      ];
      const result = generateUpdatedWikilink(
        '[[MyIdea]]',
        'MyIdea',
        '/vault/Archive/Ideas/MyIdea.md',
        vaultDir,
        allFiles
      );
      expect(result).toBe('[[Archive/Ideas/MyIdea]]');
    });

    it('should preserve heading in link', () => {
      const allFiles = ['/vault/Archive/MyFile.md'];
      const result = generateUpdatedWikilink(
        '[[MyFile#Section]]',
        'MyFile',
        '/vault/Archive/MyFile.md',
        vaultDir,
        allFiles
      );
      expect(result).toBe('[[MyFile#Section]]');
    });

    it('should preserve alias in link', () => {
      const allFiles = ['/vault/Archive/MyFile.md'];
      const result = generateUpdatedWikilink(
        '[[MyFile|Custom Name]]',
        'MyFile',
        '/vault/Archive/MyFile.md',
        vaultDir,
        allFiles
      );
      expect(result).toBe('[[MyFile|Custom Name]]');
    });

    it('should preserve both heading and alias', () => {
      const allFiles = ['/vault/Archive/MyFile.md'];
      const result = generateUpdatedWikilink(
        '[[MyFile#Section|Custom Name]]',
        'MyFile',
        '/vault/Archive/MyFile.md',
        vaultDir,
        allFiles
      );
      expect(result).toBe('[[MyFile#Section|Custom Name]]');
    });
  });

  describe('findWikilinksToFile', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-wikilink-test-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should find wikilinks to a file', async () => {
      const targetFile = join(tempDir, 'Target.md');
      const sourceFile = join(tempDir, 'Source.md');

      await writeFile(targetFile, '# Target');
      await writeFile(sourceFile, `---
title: Source
---
This links to [[Target]] for reference.
`);

      const allFiles = [targetFile, sourceFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(1);
      expect(refs[0]!.sourceFile).toBe(sourceFile);
      expect(refs[0]!.match).toBe('[[Target]]');
      expect(refs[0]!.linkTarget).toBe('Target');
      expect(refs[0]!.inFrontmatter).toBe(false);
    });

    it('should find wikilinks with alias', async () => {
      const targetFile = join(tempDir, 'Target.md');
      const sourceFile = join(tempDir, 'Source.md');

      await writeFile(targetFile, '# Target');
      await writeFile(sourceFile, 'See [[Target|my link]] here.');

      const allFiles = [targetFile, sourceFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(1);
      expect(refs[0]!.match).toBe('[[Target|my link]]');
    });

    it('should find wikilinks with heading', async () => {
      const targetFile = join(tempDir, 'Target.md');
      const sourceFile = join(tempDir, 'Source.md');

      await writeFile(targetFile, '# Target');
      await writeFile(sourceFile, 'See [[Target#section]] here.');

      const allFiles = [targetFile, sourceFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(1);
      expect(refs[0]!.match).toBe('[[Target#section]]');
    });

    it('should find multiple wikilinks in same file', async () => {
      const targetFile = join(tempDir, 'Target.md');
      const sourceFile = join(tempDir, 'Source.md');

      await writeFile(targetFile, '# Target');
      await writeFile(sourceFile, `First [[Target]] and second [[Target|alias]].`);

      const allFiles = [targetFile, sourceFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(2);
    });

    it('should detect wikilinks in frontmatter', async () => {
      const targetFile = join(tempDir, 'Target.md');
      const sourceFile = join(tempDir, 'Source.md');

      await writeFile(targetFile, '# Target');
      await writeFile(sourceFile, `---
related: "[[Target]]"
---
Body content.
`);

      const allFiles = [targetFile, sourceFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(1);
      expect(refs[0]!.inFrontmatter).toBe(true);
    });

    it('should not include self-references', async () => {
      const targetFile = join(tempDir, 'Target.md');

      await writeFile(targetFile, `# Target
Links to [[Target]] itself.
`);

      const allFiles = [targetFile];
      const refs = await findWikilinksToFile(tempDir, targetFile, allFiles);

      expect(refs).toHaveLength(0);
    });
  });

  describe('updateWikilinksInContent', () => {
    it('should update wikilinks in content', () => {
      const content = 'Link to [[OldName]] here.';
      const refs = [{
        sourceFile: '/vault/Source.md',
        sourceRelativePath: 'Source.md',
        match: '[[OldName]]',
        linkTarget: 'OldName',
        position: 8,
        lineNumber: 1,
        inFrontmatter: false,
      }];
      const newFilePath = '/vault/Archive/OldName.md';
      const allFiles = ['/vault/Archive/OldName.md'];

      const { newContent, linksUpdated } = updateWikilinksInContent(
        content,
        refs,
        newFilePath,
        '/vault',
        allFiles
      );

      expect(newContent).toBe('Link to [[OldName]] here.'); // Name unchanged, file is unique
      expect(linksUpdated).toBe(0);
    });

    it('should add path when filename becomes ambiguous', () => {
      const content = 'Link to [[Note]] here.';
      const refs = [{
        sourceFile: '/vault/Source.md',
        sourceRelativePath: 'Source.md',
        match: '[[Note]]',
        linkTarget: 'Note',
        position: 8,
        lineNumber: 1,
        inFrontmatter: false,
      }];
      const newFilePath = '/vault/Archive/Note.md';
      const allFiles = ['/vault/Archive/Note.md', '/vault/Notes/Note.md'];

      const { newContent, linksUpdated } = updateWikilinksInContent(
        content,
        refs,
        newFilePath,
        '/vault',
        allFiles
      );

      expect(newContent).toBe('Link to [[Archive/Note]] here.');
      expect(linksUpdated).toBe(1);
    });

    it('should handle multiple updates in same content', () => {
      const content = 'First [[Note]], then [[Note|alias]].';
      // Position 6: 'First ' = 6 chars, so [[Note]] starts at 6
      // Position 21: 'First [[Note]], then ' = 21 chars, so [[Note|alias]] starts at 21
      const refs = [
        {
          sourceFile: '/vault/Source.md',
          sourceRelativePath: 'Source.md',
          match: '[[Note]]',
          linkTarget: 'Note',
          position: 6,
          lineNumber: 1,
          inFrontmatter: false,
        },
        {
          sourceFile: '/vault/Source.md',
          sourceRelativePath: 'Source.md',
          match: '[[Note|alias]]',
          linkTarget: 'Note',
          position: 21,
          lineNumber: 1,
          inFrontmatter: false,
        },
      ];
      const newFilePath = '/vault/Archive/Note.md';
      const allFiles = ['/vault/Archive/Note.md', '/vault/Other/Note.md'];

      const { newContent, linksUpdated } = updateWikilinksInContent(
        content,
        refs,
        newFilePath,
        '/vault',
        allFiles
      );

      expect(newContent).toBe('First [[Archive/Note]], then [[Archive/Note|alias]].');
      expect(linksUpdated).toBe(2);
    });
  });

  describe('executeBulkMove', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bwrb-bulk-move-test-'));
      await mkdir(join(tempDir, 'Ideas'));
      await mkdir(join(tempDir, 'Archive'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('should move files in dry-run mode without changes', async () => {
      const ideaFile = join(tempDir, 'Ideas', 'MyIdea.md');
      await writeFile(ideaFile, '# My Idea');

      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: join(tempDir, 'Archive'),
        filesToMove: [ideaFile],
        execute: false,
      });

      expect(result.dryRun).toBe(true);
      expect(result.moveResults).toHaveLength(1);
      expect(result.moveResults[0]!.applied).toBe(false);

      // File should still be in original location
      await expect(access(ideaFile)).resolves.toBeUndefined();
    });

    it('should move files when execute is true', async () => {
      const ideaFile = join(tempDir, 'Ideas', 'MyIdea.md');
      await writeFile(ideaFile, '# My Idea');

      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: join(tempDir, 'Archive'),
        filesToMove: [ideaFile],
        execute: true,
      });

      expect(result.dryRun).toBe(false);
      expect(result.moveResults).toHaveLength(1);
      expect(result.moveResults[0]!.applied).toBe(true);

      // File should be in new location
      const newFile = join(tempDir, 'Archive', 'MyIdea.md');
      await expect(access(newFile)).resolves.toBeUndefined();
      await expect(access(ideaFile)).rejects.toThrow();
    });

    it('should update wikilinks when moving files', async () => {
      const ideaFile = join(tempDir, 'Ideas', 'MyIdea.md');
      const taskFile = join(tempDir, 'Task.md');

      await writeFile(ideaFile, '# My Idea');
      await writeFile(taskFile, `---
type: task
---
Related to [[MyIdea]].
`);

      // Create another file with same name for disambiguation test
      await mkdir(join(tempDir, 'Other'));
      await writeFile(join(tempDir, 'Other', 'MyIdea.md'), '# Other Idea');

      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: join(tempDir, 'Archive'),
        filesToMove: [ideaFile],
        execute: true,
      });

      expect(result.moveResults).toHaveLength(1);
      expect(result.moveResults[0]!.applied).toBe(true);
      expect(result.totalLinksUpdated).toBe(1);

      // Check that task file was updated
      const taskContent = await readFile(taskFile, 'utf-8');
      expect(taskContent).toContain('[[Archive/MyIdea]]');
    });

    it('should create target directory if it does not exist', async () => {
      const ideaFile = join(tempDir, 'Ideas', 'MyIdea.md');
      await writeFile(ideaFile, '# My Idea');

      const newDir = join(tempDir, 'Archive', 'OldIdeas');

      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: newDir,
        filesToMove: [ideaFile],
        execute: true,
      });

      expect(result.moveResults[0]!.applied).toBe(true);
      await expect(access(join(newDir, 'MyIdea.md'))).resolves.toBeUndefined();
    });

    it('should handle multiple files', async () => {
      const idea1 = join(tempDir, 'Ideas', 'Idea1.md');
      const idea2 = join(tempDir, 'Ideas', 'Idea2.md');
      await writeFile(idea1, '# Idea 1');
      await writeFile(idea2, '# Idea 2');

      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: join(tempDir, 'Archive'),
        filesToMove: [idea1, idea2],
        execute: true,
      });

      expect(result.moveResults).toHaveLength(2);
      expect(result.moveResults.every(r => r.applied)).toBe(true);
    });

    it('should return empty results for empty file list', async () => {
      const result = await executeBulkMove({
        vaultDir: tempDir,
        targetDir: join(tempDir, 'Archive'),
        filesToMove: [],
        execute: true,
      });

      expect(result.moveResults).toHaveLength(0);
      expect(result.wikilinkUpdates).toHaveLength(0);
    });
  });
});
