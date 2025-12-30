import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { existsSync } from 'fs';
import {
  getTemplateDir,
  parseTemplate,
  findTemplates,
  findDefaultTemplate,
  findTemplateByName,
  processTemplateBody,
  resolveTemplate,
  validateConstraints,
  validateConstraintSyntax,
  createScaffoldedInstances,
} from '../../../src/lib/template.js';
import type { Schema } from '../../../src/types/schema.js';

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

  describe('parseTemplate with constraints', () => {
    it('parses template with constraints', async () => {
      await mkdir(join(tempDir, '.ovault/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/idea', 'urgent.md'),
        `---
type: template
template-for: idea
constraints:
  deadline:
    required: true
    validate: "this < today() + '7d'"
    error: "Deadline must be within 7 days"
  priority:
    validate: "this == 'high' || this == 'critical'"
---

# {title}
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates/idea', 'urgent.md'));

      expect(template).not.toBeNull();
      expect(template?.constraints).toBeDefined();
      expect(template?.constraints?.deadline?.required).toBe(true);
      expect(template?.constraints?.deadline?.validate).toBe("this < today() + '7d'");
      expect(template?.constraints?.deadline?.error).toBe('Deadline must be within 7 days');
      expect(template?.constraints?.priority?.validate).toBe("this == 'high' || this == 'critical'");
    });

    it('parses template with instances', async () => {
      await mkdir(join(tempDir, '.ovault/templates/draft'), { recursive: true });
      await writeFile(
        join(tempDir, '.ovault/templates/draft', 'blog.md'),
        `---
type: template
template-for: draft
instances:
  - subtype: version
    filename: "Draft v1.md"
  - subtype: research
    filename: "SEO Research.md"
    template: seo
    defaults:
      status: inbox
---

# {title}
`
      );

      const template = await parseTemplate(join(tempDir, '.ovault/templates/draft', 'blog.md'));

      expect(template).not.toBeNull();
      expect(template?.instances).toBeDefined();
      expect(template?.instances).toHaveLength(2);
      expect(template?.instances?.[0]).toEqual({ subtype: 'version', filename: 'Draft v1.md' });
      expect(template?.instances?.[1]).toEqual({
        subtype: 'research',
        filename: 'SEO Research.md',
        template: 'seo',
        defaults: { status: 'inbox' },
      });
    });
  });
});

describe('validateConstraints', () => {
  it('passes when all constraints are satisfied', () => {
    const frontmatter = {
      deadline: '2025-01-15',
      status: 'in-progress',
    };
    const constraints = {
      deadline: { required: true },
      status: { validate: "this == 'in-progress'" },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required field is missing', () => {
    const frontmatter = { status: 'draft' };
    const constraints = {
      deadline: { required: true },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe('deadline');
    expect(result.errors[0]?.constraint).toBe('required');
  });

  it('fails when required field is empty string', () => {
    const frontmatter = { deadline: '' };
    const constraints = {
      deadline: { required: true },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe('deadline');
  });

  it('fails when required field is null', () => {
    const frontmatter = { deadline: null };
    const constraints = {
      deadline: { required: true },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.constraint).toBe('required');
  });

  it('fails when validate expression returns false', () => {
    const frontmatter = { priority: 'low' };
    const constraints = {
      priority: {
        validate: "this == 'high' || this == 'critical'",
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe('priority');
    expect(result.errors[0]?.constraint).toBe('validate');
  });

  it('uses custom error message when provided', () => {
    const frontmatter = { deadline: '' };
    const constraints = {
      deadline: {
        required: true,
        error: 'Deadline is mandatory for this template',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.errors[0]?.message).toBe('Deadline is mandatory for this template');
  });

  it('uses custom error message for validate constraint', () => {
    const frontmatter = { priority: 'low' };
    const constraints = {
      priority: {
        validate: "this == 'high'",
        error: 'Priority must be high',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.errors[0]?.message).toBe('Priority must be high');
  });

  it('handles invalid expression gracefully', () => {
    const frontmatter = { value: 'test' };
    const constraints = {
      value: {
        validate: 'this <> invalid syntax',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain('Invalid constraint expression');
  });

  it('skips validate check if required check fails', () => {
    const frontmatter = { deadline: undefined };
    const constraints = {
      deadline: {
        required: true,
        validate: "this != ''", // Would also fail, but should not be checked
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    // Should only have one error (required), not two
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.constraint).toBe('required');
  });

  it('skips validate check if value is empty', () => {
    const frontmatter = { deadline: '' };
    const constraints = {
      deadline: {
        // No required: true, just validate
        validate: "this >= today()",
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    // Should pass - empty value means no validation needed
    expect(result.valid).toBe(true);
  });

  it('supports this keyword referring to field value', () => {
    const frontmatter = { count: 5 };
    const constraints = {
      count: {
        validate: 'this > 3',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(true);
  });

  it('can access other fields in expression', () => {
    const frontmatter = { min: 5, max: 10 };
    const constraints = {
      max: {
        validate: 'this > min',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(true);
  });

  it('validates multiple constraints', () => {
    const frontmatter = { a: '', b: 'wrong' };
    const constraints = {
      a: { required: true },
      b: { validate: "this == 'correct'" },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('validates contains() function with arrays', () => {
    const frontmatter = { tags: ['bug', 'urgent'] };
    const constraints = {
      tags: {
        validate: "contains(this, 'bug')",
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    expect(result.valid).toBe(true);
  });

  it('validates isEmpty() function', () => {
    const frontmatter = { notes: '' };
    const constraints = {
      notes: {
        validate: '!isEmpty(this)',
        error: 'Notes cannot be empty',
      },
    };

    const result = validateConstraints(frontmatter, constraints);

    // isEmpty check happens on empty string, but we skip validation for empty values
    // unless required is true. So this should pass.
    expect(result.valid).toBe(true);
  });
});

describe('validateConstraintSyntax', () => {
  it('returns empty array for valid expressions', () => {
    const constraints = {
      a: { validate: "this == 'test'" },
      b: { validate: 'this > 5' },
      c: { required: true }, // No validate, should be skipped
    };

    const errors = validateConstraintSyntax(constraints);

    expect(errors).toHaveLength(0);
  });

  it('returns errors for invalid expressions', () => {
    const constraints = {
      a: { validate: '(((unclosed' },
      b: { validate: 'foo(bar' },
    };

    const errors = validateConstraintSyntax(constraints);

    expect(errors).toHaveLength(2);
    expect(errors[0]?.field).toBe('a');
    expect(errors[1]?.field).toBe('b');
  });

  it('includes field name in error', () => {
    const constraints = {
      myField: { validate: '((((' },
    };

    const errors = validateConstraintSyntax(constraints);

    expect(errors[0]?.field).toBe('myField');
    expect(errors[0]?.message).toContain('Invalid expression');
  });
});

describe('createScaffoldedInstances', () => {
  let tempDir: string;

  // Minimal schema with instance-grouped type and subtypes
  const testSchema: Schema = {
    version: 1,
    types: {
      draft: {
        output_dir: 'Drafts',
        dir_mode: 'instance-grouped',
        frontmatter: {
          Name: { prompt: 'input', required: true },
          status: { prompt: 'select', enum: 'status', default: 'draft' },
        },
        subtypes: {
          version: {
            frontmatter: {
              version: { prompt: 'input', default: '1' },
            },
          },
          research: {
            frontmatter: {
              topic: { prompt: 'input' },
            },
          },
          notes: {
            frontmatter: {
              source: { prompt: 'input' },
            },
          },
        },
      },
    },
    enums: {
      status: ['draft', 'in-progress', 'done'],
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scaffold-test-'));
    // Create instance folder
    await mkdir(join(tempDir, 'Drafts', 'My Project'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates all specified instance files', async () => {
    const instances = [
      { subtype: 'version', filename: 'Draft v1.md' },
      { subtype: 'research', filename: 'Research.md' },
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(existsSync(join(tempDir, 'Drafts', 'My Project', 'Draft v1.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'Drafts', 'My Project', 'Research.md'))).toBe(true);
  });

  it('skips existing files and reports them', async () => {
    // Create an existing file
    await writeFile(
      join(tempDir, 'Drafts', 'My Project', 'Existing.md'),
      '---\ntype: notes\n---\n'
    );

    const instances = [
      { subtype: 'notes', filename: 'Existing.md' },
      { subtype: 'version', filename: 'New.md' },
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain('Existing.md');
    expect(result.errors).toHaveLength(0);
  });

  it('applies instance-specific defaults', async () => {
    const instances = [
      { subtype: 'research', filename: 'SEO.md', defaults: { topic: 'SEO Analysis' } },
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    
    // Read the file and check frontmatter
    const content = await import('fs/promises').then(fs => 
      fs.readFile(join(tempDir, 'Drafts', 'My Project', 'SEO.md'), 'utf-8')
    );
    expect(content).toContain('topic: SEO Analysis');
  });

  it('reports errors for unknown subtypes', async () => {
    const instances = [
      { subtype: 'nonexistent', filename: 'Bad.md' },
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.subtype).toBe('nonexistent');
    expect(result.errors[0]?.message).toContain('Unknown subtype');
  });

  it('uses default filename when not specified', async () => {
    const instances = [
      { subtype: 'version' }, // No filename specified
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    // Default filename should be "{subtype}.md"
    expect(existsSync(join(tempDir, 'Drafts', 'My Project', 'version.md'))).toBe(true);
  });

  it('loads and applies template if specified', async () => {
    // Create a template for the research subtype
    await mkdir(join(tempDir, '.ovault', 'templates', 'draft', 'research'), { recursive: true });
    await writeFile(
      join(tempDir, '.ovault', 'templates', 'draft', 'research', 'seo.md'),
      `---
type: template
template-for: draft/research
defaults:
  topic: SEO Template Default
---

## SEO Research

Template body here.
`
    );

    const instances = [
      { subtype: 'research', filename: 'SEO Research.md', template: 'seo' },
    ];

    const result = await createScaffoldedInstances(
      testSchema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    
    // Read the file and check it has template defaults and body
    const content = await import('fs/promises').then(fs => 
      fs.readFile(join(tempDir, 'Drafts', 'My Project', 'SEO Research.md'), 'utf-8')
    );
    expect(content).toContain('topic: SEO Template Default');
    expect(content).toContain('## SEO Research');
    expect(content).toContain('Template body here.');
  });
});
