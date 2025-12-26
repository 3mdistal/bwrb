import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { readFile } from 'fs/promises';
import {
  parseNote,
  parseFrontmatter,
  serializeFrontmatter,
  buildNoteContent,
  writeNote,
  generateBodySections,
  generateBodyWithContent,
} from '../../../src/lib/frontmatter.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';

describe('frontmatter', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('parseNote', () => {
    it('should parse frontmatter and body from file', async () => {
      const note = await parseNote(join(vaultDir, 'Ideas', 'Sample Idea.md'));
      expect(note.frontmatter).toEqual({
        type: 'idea',
        status: 'raw',
        priority: 'medium',
      });
      expect(note.body).toBe('');
    });

    it('should parse note with body content', async () => {
      const note = await parseNote(join(vaultDir, 'Objectives/Tasks', 'Sample Task.md'));
      expect(note.frontmatter.type).toBe('objective');
      expect(note.body).toContain('## Steps');
      expect(note.body).toContain('## Notes');
    });
  });

  describe('parseFrontmatter', () => {
    it('should parse frontmatter from string', () => {
      const content = `---
type: idea
status: raw
---
Body content`;
      const fm = parseFrontmatter(content);
      expect(fm).toEqual({ type: 'idea', status: 'raw' });
    });
  });

  describe('serializeFrontmatter', () => {
    it('should serialize frontmatter to YAML', () => {
      const yaml = serializeFrontmatter({ type: 'idea', status: 'raw' });
      expect(yaml).toContain('type: idea');
      expect(yaml).toContain('status: raw');
    });

    it('should respect field order', () => {
      const yaml = serializeFrontmatter(
        { status: 'raw', type: 'idea' },
        ['type', 'status']
      );
      const lines = yaml.split('\n');
      expect(lines[0]).toBe('type: idea');
      expect(lines[1]).toBe('status: raw');
    });
  });

  describe('buildNoteContent', () => {
    it('should build complete markdown content', () => {
      const content = buildNoteContent(
        { type: 'idea', status: 'raw' },
        'Body content\n'
      );
      expect(content).toContain('---');
      expect(content).toContain('type: idea');
      expect(content).toContain('Body content');
    });
  });

  describe('writeNote', () => {
    it('should write note to disk', async () => {
      const filePath = join(vaultDir, 'Ideas', 'New Test Idea.md');
      await writeNote(
        filePath,
        { type: 'idea', status: 'raw' },
        'Test body\n'
      );

      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('type: idea');
      expect(content).toContain('Test body');
    });
  });

  describe('generateBodySections', () => {
    it('should generate body with checkboxes', () => {
      const body = generateBodySections([
        { title: 'Steps', level: 2, content_type: 'checkboxes' },
      ]);
      expect(body).toContain('## Steps');
      expect(body).toContain('- [ ]');
    });

    it('should generate body with bullets', () => {
      const body = generateBodySections([
        { title: 'Items', level: 2, content_type: 'bullets' },
      ]);
      expect(body).toContain('## Items');
      expect(body).toContain('-');
    });

    it('should handle nested sections', () => {
      const body = generateBodySections([
        {
          title: 'Parent',
          level: 2,
          content_type: 'paragraphs',
          children: [
            { title: 'Child', level: 3, content_type: 'bullets' },
          ],
        },
      ]);
      expect(body).toContain('## Parent');
      expect(body).toContain('### Child');
    });
  });

  describe('generateBodyWithContent', () => {
    it('should generate body with provided content', () => {
      const sectionContent = new Map([['Steps', ['Step 1', 'Step 2']]]);
      const body = generateBodyWithContent(
        [{ title: 'Steps', level: 2, content_type: 'checkboxes' }],
        sectionContent
      );
      expect(body).toContain('## Steps');
      expect(body).toContain('- [ ] Step 1');
      expect(body).toContain('- [ ] Step 2');
    });
  });
});
