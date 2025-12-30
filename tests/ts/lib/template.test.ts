import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import {
  getTemplateDir,
  parseTemplate,
  findTemplates,
  findDefaultTemplate,
  findTemplateByName,
  processTemplateBody,
  resolveTemplate,
} from '../../../src/lib/template.js';

describe('template library', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'template-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getTemplateDir', () => {
    it('returns correct path for simple type', () => {
      const result = getTemplateDir('/vault', 'idea');
      expect(result).toBe('/vault/.ovault/templates/idea');
    });

    it('returns correct path for nested type', () => {
      const result = getTemplateDir('/vault', 'objective/task');
      expect(result).toBe('/vault/.ovault/templates/objective/task');
    });

    it('returns correct path for deeply nested type', () => {
      const result = getTemplateDir('/vault', 'a/b/c');
      expect(result).toBe('/vault/.ovault/templates/a/b/c');
    });
  });

  describe('parseTemplate', () => {
    it('parses valid template file', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
description: Test template
defaults:
  status: raw
---

# {title}

Body content here.
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates/idea', 'default.md'));

      expect(template).not.toBeNull();
      expect(template?.name).toBe('default');
      expect(template?.templateFor).toBe('idea');
      expect(template?.description).toBe('Test template');
      expect(template?.defaults).toEqual({ status: 'raw' });
      expect(template?.body).toContain('# {title}');
      expect(template?.body).toContain('Body content here.');
    });

    it('returns null for non-template file', async () => {
      await mkdir(join(tempDir, 'Ideas'), { recursive: true });
      await writeFile(
        join(tempDir, 'Ideas', 'regular-note.md'),
        `---
type: idea
status: raw
---

Just a regular note.
`
      );

      const template = await parseTemplate(join(tempDir, 'Ideas', 'regular-note.md'));
      expect(template).toBeNull();
    });

    it('returns null for missing template-for field', async () => {
      await mkdir(join(tempDir, '.ovault/templates'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates', 'bad.md'),
        `---
type: template
---

Missing template-for.
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates', 'bad.md'));
      expect(template).toBeNull();
    });

    it('returns null for non-existent file', async () => {
      const template = await parseTemplate(join(tempDir, 'nonexistent.md'));
      expect(template).toBeNull();
    });

    it('parses template with prompt-fields', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'special.md'),
        `---
type: template
template-for: idea
prompt-fields:
  - status
  - priority
---

Body.
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates/idea', 'special.md'));

      expect(template).not.toBeNull();
      expect(template?.promptFields).toEqual(['status', 'priority']);
    });

    it('parses template with filename-pattern', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'dated.md'),
        `---
type: template
template-for: idea
filename-pattern: "{date} - {title}"
---

Body.
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates/idea', 'dated.md'));

      expect(template).not.toBeNull();
      expect(template?.filenamePattern).toBe('{date} - {title}');
    });
  });

  describe('findTemplates', () => {
    it('finds all templates for a type', async () => {
      await mkdir(join(tempDir, '.ovault/templates/objective/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/objective/task', 'default.md'),
        `---
type: template
template-for: objective/task
---
`
      );
      await writeFile(
        join(tempDir, '.ovault/templates/objective/task', 'bug-report.md'),
        `---
type: template
template-for: objective/task
---
`
      );

      const templates = await findTemplates(tempDir, 'objective/task');

      expect(templates).toHaveLength(2);
      expect(templates.map(t => t.name)).toContain('default');
      expect(templates.map(t => t.name)).toContain('bug-report');
    });

    it('sorts templates with default first', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'zebra.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'alpha.md'),
        `---
type: template
template-for: idea
---
`
      );

      const templates = await findTemplates(tempDir, 'idea');

      expect(templates).toHaveLength(3);
      expect(templates[0]?.name).toBe('default');
      expect(templates[1]?.name).toBe('alpha');
      expect(templates[2]?.name).toBe('zebra');
    });

    it('returns empty array for non-existent directory', async () => {
      const templates = await findTemplates(tempDir, 'nonexistent');
      expect(templates).toEqual([]);
    });

    it('excludes templates for wrong type', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'wrong.md'),
        `---
type: template
template-for: objective/task
---
`
      );

      const templates = await findTemplates(tempDir, 'idea');
      expect(templates).toEqual([]);
    });

    it('does not inherit templates from parent type (strict matching)', async () => {
      // Create template in parent directory
      await mkdir(join(tempDir, '.ovault/templates/objective'), { recursive: true });
      await mkdir(join(tempDir, '.ovault/templates/objective/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.ovault/templates/objective', 'parent-template.md'),
        `---
type: template
template-for: objective
---
`
      );

      // Search for task templates - should NOT find parent template
      const templates = await findTemplates(tempDir, 'objective/task');
      expect(templates).toEqual([]);
    });
  });

  describe('findDefaultTemplate', () => {
    it('finds default.md template', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
description: The default
---
`
      );

      const template = await findDefaultTemplate(tempDir, 'idea');

      expect(template).not.toBeNull();
      expect(template?.name).toBe('default');
      expect(template?.description).toBe('The default');
    });

    it('returns null when no default template exists', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'other.md'),
        `---
type: template
template-for: idea
---
`
      );

      const template = await findDefaultTemplate(tempDir, 'idea');
      expect(template).toBeNull();
    });

    it('returns null when default.md has wrong template-for', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: objective/task
---
`
      );

      const template = await findDefaultTemplate(tempDir, 'idea');
      expect(template).toBeNull();
    });
  });

  describe('findTemplateByName', () => {
    it('finds template by name', async () => {
      await mkdir(join(tempDir, '.ovault/templates/objective/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/objective/task', 'bug-report.md'),
        `---
type: template
template-for: objective/task
description: Bug template
---
`
      );

      const template = await findTemplateByName(tempDir, 'objective/task', 'bug-report');

      expect(template).not.toBeNull();
      expect(template?.name).toBe('bug-report');
      expect(template?.description).toBe('Bug template');
    });

    it('finds template by name with .md extension', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'special.md'),
        `---
type: template
template-for: idea
---
`
      );

      const template = await findTemplateByName(tempDir, 'idea', 'special.md');
      expect(template).not.toBeNull();
      expect(template?.name).toBe('special');
    });

    it('returns null for non-existent template', async () => {
      const template = await findTemplateByName(tempDir, 'idea', 'nonexistent');
      expect(template).toBeNull();
    });

    it('returns null when template-for does not match', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'wrong.md'),
        `---
type: template
template-for: objective/task
---
`
      );

      const template = await findTemplateByName(tempDir, 'idea', 'wrong');
      expect(template).toBeNull();
    });
  });

  describe('processTemplateBody', () => {
    it('substitutes field values', () => {
      const body = '# {title}\n\nStatus: {status}';
      const frontmatter = { title: 'My Note', status: 'active' };

      const result = processTemplateBody(body, frontmatter);

      expect(result).toBe('# My Note\n\nStatus: active');
    });

    it('substitutes {date} with today', () => {
      const body = 'Created: {date}';
      const frontmatter = {};

      const result = processTemplateBody(body, frontmatter);

      // Should match YYYY-MM-DD format
      expect(result).toMatch(/Created: \d{4}-\d{2}-\d{2}/);
    });

    it('substitutes {date:FORMAT} with formatted date', () => {
      const body = 'Month: {date:YYYY-MM}';
      const frontmatter = {};

      const result = processTemplateBody(body, frontmatter);

      expect(result).toMatch(/Month: \d{4}-\d{2}/);
    });

    it('handles missing field values gracefully', () => {
      const body = '# {title}\n\nMissing: {nonexistent}';
      const frontmatter = { title: 'Test' };

      const result = processTemplateBody(body, frontmatter);

      expect(result).toBe('# Test\n\nMissing: {nonexistent}');
    });

    it('handles array values', () => {
      const body = 'Tags: {tags}';
      const frontmatter = { tags: ['one', 'two', 'three'] };

      const result = processTemplateBody(body, frontmatter);

      expect(result).toBe('Tags: one, two, three');
    });

    it('handles null and undefined values', () => {
      const body = 'A: {a}, B: {b}';
      const frontmatter = { a: null, b: undefined };

      const result = processTemplateBody(body, frontmatter);

      expect(result).toBe('A: , B: ');
    });
  });

  describe('resolveTemplate', () => {
    it('returns null template when noTemplate is true', async () => {
      const result = await resolveTemplate(tempDir, 'idea', { noTemplate: true });

      expect(result.template).toBeNull();
      expect(result.shouldPrompt).toBe(false);
      expect(result.availableTemplates).toEqual([]);
    });

    it('finds specific template by name', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'special.md'),
        `---
type: template
template-for: idea
---
`
      );

      const result = await resolveTemplate(tempDir, 'idea', { templateName: 'special' });

      expect(result.template).not.toBeNull();
      expect(result.template?.name).toBe('special');
      expect(result.shouldPrompt).toBe(false);
    });

    it('returns null when templateName not found', async () => {
      const result = await resolveTemplate(tempDir, 'idea', { templateName: 'nonexistent' });

      expect(result.template).toBeNull();
      expect(result.shouldPrompt).toBe(false);
    });

    it('finds default template when useDefault is true', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
---
`
      );

      const result = await resolveTemplate(tempDir, 'idea', { useDefault: true });

      expect(result.template).not.toBeNull();
      expect(result.template?.name).toBe('default');
      expect(result.shouldPrompt).toBe(false);
    });

    it('auto-selects default.md when no flags provided', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'other.md'),
        `---
type: template
template-for: idea
---
`
      );

      const result = await resolveTemplate(tempDir, 'idea', {});

      expect(result.template).not.toBeNull();
      expect(result.template?.name).toBe('default');
      expect(result.shouldPrompt).toBe(false);
      expect(result.availableTemplates).toHaveLength(2);
    });

    it('prompts when multiple templates but no default', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'alpha.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'beta.md'),
        `---
type: template
template-for: idea
---
`
      );

      const result = await resolveTemplate(tempDir, 'idea', {});

      expect(result.template).toBeNull();
      expect(result.shouldPrompt).toBe(true);
      expect(result.availableTemplates).toHaveLength(2);
    });

    it('returns no prompt when no templates exist', async () => {
      const result = await resolveTemplate(tempDir, 'idea', {});

      expect(result.template).toBeNull();
      expect(result.shouldPrompt).toBe(false);
      expect(result.availableTemplates).toEqual([]);
    });
  });
});
