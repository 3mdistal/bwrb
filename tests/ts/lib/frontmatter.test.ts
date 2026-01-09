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
  extractSectionItems,
  mergeBodySectionContent,
  parseBodyInput,
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
      expect(note.frontmatter.type).toBe('task');
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

    it('should normalize YAML-parsed Date values to strings', () => {
      const content = `---
type: idea
creation-date: 2026-01-08
---
Body content`;
      const fm = parseFrontmatter(content);
      expect(typeof fm['creation-date']).toBe('string');
      expect(String(fm['creation-date'])).toBe('2026-01-08');
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

  describe('extractSectionItems', () => {
    it('should extract checkboxes from a section', () => {
      const templateBody = `## Steps

- [ ] First step
- [ ] Second step

## Notes

Some notes here
`;
      const items = extractSectionItems(templateBody, 'Steps', 'checkboxes');
      expect(items).toEqual(['First step', 'Second step']);
    });

    it('should extract bullets from a section', () => {
      const templateBody = `## Items

- Item one
- Item two
- Item three

## Other
`;
      const items = extractSectionItems(templateBody, 'Items', 'bullets');
      expect(items).toEqual(['Item one', 'Item two', 'Item three']);
    });

    it('should extract paragraphs from a section', () => {
      const templateBody = `## Description

This is the first paragraph.
This is the second paragraph.

## Notes
`;
      const items = extractSectionItems(templateBody, 'Description', 'paragraphs');
      expect(items).toEqual(['This is the first paragraph.', 'This is the second paragraph.']);
    });

    it('should return empty array if section not found', () => {
      const templateBody = `## Steps

- [ ] Step
`;
      const items = extractSectionItems(templateBody, 'Notes', 'paragraphs');
      expect(items).toEqual([]);
    });

    it('should handle different heading levels', () => {
      const templateBody = `### Steps

- [ ] Deep step

#### Notes
`;
      const items = extractSectionItems(templateBody, 'Steps', 'checkboxes');
      expect(items).toEqual(['Deep step']);
    });

    it('should handle checked checkboxes', () => {
      const templateBody = `## Steps

- [x] Done step
- [ ] Pending step
`;
      const items = extractSectionItems(templateBody, 'Steps', 'checkboxes');
      expect(items).toEqual(['Done step', 'Pending step']);
    });
  });

  describe('mergeBodySectionContent', () => {
    it('should append items to existing section', () => {
      const templateBody = `## Steps

- [ ] Existing step

## Notes

`;
      const sections = [
        { title: 'Steps', level: 2, content_type: 'checkboxes' as const },
      ];
      const content = new Map([['Steps', ['New step one', 'New step two']]]);
      
      const result = mergeBodySectionContent(templateBody, sections, content);
      
      expect(result).toContain('- [ ] Existing step');
      expect(result).toContain('- [ ] New step one');
      expect(result).toContain('- [ ] New step two');
      // New items should come after existing
      expect(result.indexOf('Existing step')).toBeLessThan(result.indexOf('New step one'));
    });

    it('should add section at end if not in template', () => {
      const templateBody = `## Notes

Some notes
`;
      const sections = [
        { title: 'Steps', level: 2, content_type: 'checkboxes' as const },
      ];
      const content = new Map([['Steps', ['New step']]]);
      
      const result = mergeBodySectionContent(templateBody, sections, content);
      
      expect(result).toContain('## Notes');
      expect(result).toContain('Some notes');
      expect(result).toContain('## Steps');
      expect(result).toContain('- [ ] New step');
      // New section should come after existing content
      expect(result.indexOf('Some notes')).toBeLessThan(result.indexOf('## Steps'));
    });

    it('should handle multiple sections with content', () => {
      const templateBody = `## Steps

- [ ] Template step

## Items

- Template item
`;
      const sections = [
        { title: 'Steps', level: 2, content_type: 'checkboxes' as const },
        { title: 'Items', level: 2, content_type: 'bullets' as const },
      ];
      const content = new Map([
        ['Steps', ['Added step']],
        ['Items', ['Added item']],
      ]);
      
      const result = mergeBodySectionContent(templateBody, sections, content);
      
      expect(result).toContain('- [ ] Template step');
      expect(result).toContain('- [ ] Added step');
      expect(result).toContain('- Template item');
      expect(result).toContain('- Added item');
    });

    it('should preserve template body when no content to add', () => {
      const templateBody = `## Steps

- [ ] Existing step

## Notes

`;
      const sections = [
        { title: 'Steps', level: 2, content_type: 'checkboxes' as const },
      ];
      const content = new Map<string, string[]>();
      
      const result = mergeBodySectionContent(templateBody, sections, content);
      
      expect(result).toBe(templateBody);
    });

    it('should handle paragraphs content type', () => {
      const templateBody = `## Description

Existing description

## Notes
`;
      const sections = [
        { title: 'Description', level: 2, content_type: 'paragraphs' as const },
      ];
      const content = new Map([['Description', ['Added paragraph']]]);
      
      const result = mergeBodySectionContent(templateBody, sections, content);
      
      expect(result).toContain('Existing description');
      expect(result).toContain('Added paragraph');
    });
  });

  describe('parseBodyInput', () => {
    const testSections = [
      { title: 'Steps', level: 2, content_type: 'checkboxes' as const },
      { title: 'Notes', level: 2, content_type: 'paragraphs' as const },
      { title: 'Items', level: 2, content_type: 'bullets' as const },
    ];

    it('should parse string array content', () => {
      const input = { Steps: ['Step 1', 'Step 2'] };
      const result = parseBodyInput(input, testSections);
      
      expect(result.get('Steps')).toEqual(['Step 1', 'Step 2']);
    });

    it('should parse string content as single-item array', () => {
      const input = { Notes: 'A single note' };
      const result = parseBodyInput(input, testSections);
      
      expect(result.get('Notes')).toEqual(['A single note']);
    });

    it('should handle multiple sections', () => {
      const input = {
        Steps: ['Step 1', 'Step 2'],
        Notes: 'Some notes',
        Items: ['Item A', 'Item B'],
      };
      const result = parseBodyInput(input, testSections);
      
      expect(result.get('Steps')).toEqual(['Step 1', 'Step 2']);
      expect(result.get('Notes')).toEqual(['Some notes']);
      expect(result.get('Items')).toEqual(['Item A', 'Item B']);
    });

    it('should skip null values', () => {
      const input = { Steps: null, Notes: 'Valid note' };
      const result = parseBodyInput(input as Record<string, unknown>, testSections);
      
      expect(result.has('Steps')).toBe(false);
      expect(result.get('Notes')).toEqual(['Valid note']);
    });

    it('should skip undefined values', () => {
      const input = { Steps: undefined, Notes: 'Valid note' };
      const result = parseBodyInput(input as Record<string, unknown>, testSections);
      
      expect(result.has('Steps')).toBe(false);
      expect(result.get('Notes')).toEqual(['Valid note']);
    });

    it('should skip empty strings', () => {
      const input = { Steps: '', Notes: 'Valid note' };
      const result = parseBodyInput(input, testSections);
      
      expect(result.has('Steps')).toBe(false);
      expect(result.get('Notes')).toEqual(['Valid note']);
    });

    it('should skip empty arrays', () => {
      const input = { Steps: [], Notes: 'Valid note' };
      const result = parseBodyInput(input, testSections);
      
      expect(result.has('Steps')).toBe(false);
      expect(result.get('Notes')).toEqual(['Valid note']);
    });

    it('should convert non-string array items to strings', () => {
      const input = { Steps: [1, 2, 3] };
      const result = parseBodyInput(input as Record<string, unknown>, testSections);
      
      expect(result.get('Steps')).toEqual(['1', '2', '3']);
    });

    it('should filter null/undefined from arrays', () => {
      const input = { Steps: ['Step 1', null, 'Step 2', undefined] };
      const result = parseBodyInput(input as Record<string, unknown>, testSections);
      
      expect(result.get('Steps')).toEqual(['Step 1', 'Step 2']);
    });

    it('should throw error for unknown section', () => {
      const input = { Unknown: ['Item'] };
      
      expect(() => parseBodyInput(input, testSections)).toThrow('Unknown body section: "Unknown"');
    });

    it('should include available sections in error message', () => {
      const input = { Unknown: ['Item'] };
      
      expect(() => parseBodyInput(input, testSections)).toThrow('Available sections: Steps, Notes, Items');
    });

    it('should throw error for invalid content type (object)', () => {
      const input = { Steps: { nested: 'object' } };
      
      expect(() => parseBodyInput(input as Record<string, unknown>, testSections)).toThrow(
        'Invalid content for section "Steps": expected string or string[], got object'
      );
    });

    it('should throw error for invalid content type (number)', () => {
      const input = { Steps: 42 };
      
      expect(() => parseBodyInput(input as Record<string, unknown>, testSections)).toThrow(
        'Invalid content for section "Steps": expected string or string[], got number'
      );
    });

    it('should handle nested child sections', () => {
      const nestedSections = [
        {
          title: 'Parent',
          level: 2,
          content_type: 'paragraphs' as const,
          children: [
            { title: 'Child', level: 3, content_type: 'bullets' as const },
          ],
        },
      ];
      
      const input = { Parent: 'Parent content', Child: ['Child item'] };
      const result = parseBodyInput(input, nestedSections);
      
      expect(result.get('Parent')).toEqual(['Parent content']);
      expect(result.get('Child')).toEqual(['Child item']);
    });

    it('should return empty map for empty input', () => {
      const result = parseBodyInput({}, testSections);
      
      expect(result.size).toBe(0);
    });
  });
});
