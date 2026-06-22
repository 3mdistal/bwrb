import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  validateConstraints,
  validateConstraintSyntax,
  createScaffoldedInstances,
  getFilenamePattern,
  resolveFilenamePattern,
  findDefaultTemplateWithInheritance,
  getDefaultTemplateChain,
  mergeTemplateDefaults,
  resolveTemplateWithInheritance,
  getInheritedTemplates,
  createEmptyTemplateResolution,
} from '../../../src/lib/template.js';
import { resolveSchema, getFieldsForType } from '../../../src/lib/schema.js';
import { normalizeDateFields, validateFrontmatter } from '../../../src/lib/validation.js';
import type { Schema, LoadedSchema } from '../../../src/types/schema.js';

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
      expect(result).toBe('/vault/.bwrb/templates/idea');
    });

    it('returns correct path for nested type', () => {
      const result = getTemplateDir('/vault', 'task');
      expect(result).toBe('/vault/.bwrb/templates/task');
    });

    it('returns correct path for deeply nested type', () => {
      const result = getTemplateDir('/vault', 'a/b/c');
      expect(result).toBe('/vault/.bwrb/templates/a/b/c');
    });
  });

  describe('parseTemplate', () => {
    it('parses valid template file', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'default.md'),
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

      const template = await parseTemplate(join(tempDir, '.bwrb/templates/idea', 'default.md'));

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
      await mkdir(join(tempDir, '.bwrb/templates'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates', 'bad.md'),
        `---
type: template
---

Missing template-for.
`
      );

      const template = await parseTemplate(join(tempDir, '.bwrb/templates', 'bad.md'));
      expect(template).toBeNull();
    });

    it('returns null for non-existent file', async () => {
      const template = await parseTemplate(join(tempDir, 'nonexistent.md'));
      expect(template).toBeNull();
    });

    it('parses template with prompt-fields', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'special.md'),
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

      const template = await parseTemplate(join(tempDir, '.bwrb/templates/idea', 'special.md'));

      expect(template).not.toBeNull();
      expect(template?.promptFields).toEqual(['status', 'priority']);
    });

    it('parses template with filename-pattern', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'dated.md'),
        `---
type: template
template-for: idea
filename-pattern: "{date} - {title}"
---

Body.
`
      );

      const template = await parseTemplate(join(tempDir, '.bwrb/templates/idea', 'dated.md'));

      expect(template).not.toBeNull();
      expect(template?.filenamePattern).toBe('{date} - {title}');
    });
  });

  describe('findTemplates', () => {
    it('finds all templates for a type', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'bug-report.md'),
        `---
type: template
template-for: task
---
`
      );

      const templates = await findTemplates(tempDir, 'task');

      expect(templates).toHaveLength(2);
      expect(templates.map(t => t.name)).toContain('default');
      expect(templates.map(t => t.name)).toContain('bug-report');
    });

    it('sorts templates with default first', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'zebra.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'default.md'),
        `---
type: template
template-for: idea
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'alpha.md'),
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
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'wrong.md'),
        `---
type: template
template-for: task
---
`
      );

      const templates = await findTemplates(tempDir, 'idea');
      expect(templates).toEqual([]);
    });

    it('does not inherit templates from parent type (strict matching)', async () => {
      // Create template in parent directory
      await mkdir(join(tempDir, '.bwrb/templates/objective'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/objective', 'parent-template.md'),
        `---
type: template
template-for: objective
---
`
      );

      // Search for task templates - should NOT find parent template
      const templates = await findTemplates(tempDir, 'task');
      expect(templates).toEqual([]);
    });
  });

  describe('findDefaultTemplate', () => {
    it('finds default.md template', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'default.md'),
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
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'other.md'),
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
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'default.md'),
        `---
type: template
template-for: task
---
`
      );

      const template = await findDefaultTemplate(tempDir, 'idea');
      expect(template).toBeNull();
    });
  });

  describe('findTemplateByName', () => {
    it('finds template by name', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'bug-report.md'),
        `---
type: template
template-for: task
description: Bug template
---
`
      );

      const template = await findTemplateByName(tempDir, 'task', 'bug-report');

      expect(template).not.toBeNull();
      expect(template?.name).toBe('bug-report');
      expect(template?.description).toBe('Bug template');
    });

    it('finds template by name with .md extension', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'special.md'),
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
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'wrong.md'),
        `---
type: template
template-for: task
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

  describe('parseTemplate with constraints', () => {
    it('parses template with constraints', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/idea'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/idea', 'urgent.md'),
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

      const template = await parseTemplate(join(tempDir, '.bwrb/templates/idea', 'urgent.md'));

      expect(template).not.toBeNull();
      expect(template?.constraints).toBeDefined();
      expect(template?.constraints?.deadline?.required).toBe(true);
      expect(template?.constraints?.deadline?.validate).toBe("this < today() + '7d'");
      expect(template?.constraints?.deadline?.error).toBe('Deadline must be within 7 days');
      expect(template?.constraints?.priority?.validate).toBe("this == 'high' || this == 'critical'");
    });

    it('parses template with instances', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/draft'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/draft', 'blog.md'),
        `---
type: template
template-for: draft
instances:
  - type: version
    filename: "Draft v1.md"
  - type: research
    filename: "SEO Research.md"
    template: seo
    defaults:
      status: inbox
---

# {title}
`
      );

      const template = await parseTemplate(join(tempDir, '.bwrb/templates/draft', 'blog.md'));

      expect(template).not.toBeNull();
      expect(template?.instances).toBeDefined();
      expect(template?.instances).toHaveLength(2);
      expect(template?.instances?.[0]).toEqual({ type: 'version', filename: 'Draft v1.md' });
      expect(template?.instances?.[1]).toEqual({
        type: 'research',
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
  let schema: LoadedSchema;

  // V2 schema with inheritance-based types
  const testSchemaRaw: Schema = {
    version: 2,
    types: {
      draft: {
        output_dir: 'Drafts',
        fields: {
          Name: { prompt: 'text', required: true },
          status: { prompt: 'select', options: ['draft', 'in-progress', 'done'], default: 'draft' },
        },
      },
      version: {
        extends: 'draft',
        fields: {
          version: { prompt: 'text', default: '1' },
        },
      },
      research: {
        extends: 'draft',
        fields: {
          topic: { prompt: 'text' },
          due: { prompt: 'date' },
        },
      },
      notes: {
        extends: 'draft',
        fields: {
          source: { prompt: 'text' },
        },
      },
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scaffold-test-'));
    // Create instance folder
    await mkdir(join(tempDir, 'Drafts', 'My Project'), { recursive: true });
    // Resolve schema for use in tests
    schema = resolveSchema(testSchemaRaw);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates all specified instance files', async () => {
    const instances = [
      { type: 'version', filename: 'Draft v1.md' },
      { type: 'research', filename: 'Research.md' },
    ];

    const result = await createScaffoldedInstances(
      schema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    // Instances are filed in each child type's own output_dir (#107/#630).
    // `version` and `research` both extend `draft` (output_dir 'Drafts'), so they
    // land in 'Drafts/', NOT the parent instance folder 'Drafts/My Project/'.
    expect(existsSync(join(tempDir, 'Drafts', 'Draft v1.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'Drafts', 'Research.md'))).toBe(true);
  });

  it('skips existing files and reports them', async () => {
    // Create an existing file in the CHILD type's output_dir (where the instance
    // would be filed), so the on-disk collision is detected.
    await mkdir(join(tempDir, 'Drafts'), { recursive: true });
    await writeFile(
      join(tempDir, 'Drafts', 'Existing.md'),
      '---\ntype: notes\n---\n'
    );

    const instances = [
      { type: 'notes', filename: 'Existing.md' },
      { type: 'version', filename: 'New.md' },
    ];

    const result = await createScaffoldedInstances(
      schema,
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
      { type: 'research', filename: 'SEO.md', defaults: { topic: 'SEO Analysis' } },
    ];

    const result = await createScaffoldedInstances(
      schema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    
    // Read the file (filed in the child `research` type's output_dir) and check.
    const content = await import('fs/promises').then(fs =>
      fs.readFile(join(tempDir, 'Drafts', 'SEO.md'), 'utf-8')
    );
    expect(content).toContain('topic: SEO Analysis');
  });

  it('reports errors for unknown types', async () => {
    const instances = [
      { type: 'nonexistent', filename: 'Bad.md' },
    ];

    const result = await createScaffoldedInstances(
      schema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.subtype).toBe('nonexistent');
    expect(result.errors[0]?.message).toContain('Unknown type');
  });

  it('uses default filename when not specified', async () => {
    const instances = [
      { type: 'version' }, // No filename specified
    ];

    const result = await createScaffoldedInstances(
      schema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    // Default filename should be "{type}.md", filed in the child output_dir.
    expect(existsSync(join(tempDir, 'Drafts', 'version.md'))).toBe(true);
  });

  it('loads and applies template if specified', async () => {
    // Create a template for the research type
    await mkdir(join(tempDir, '.bwrb', 'templates', 'research'), { recursive: true });
    await writeFile(
      join(tempDir, '.bwrb', 'templates', 'research', 'seo.md'),
      `---
type: template
template-for: research
defaults:
  topic: SEO Template Default
---

## SEO Research

Template body here.
`
    );

    const instances = [
      { type: 'research', filename: 'SEO Research.md', template: 'seo' },
    ];

    const result = await createScaffoldedInstances(
      schema,
      tempDir,
      'draft',
      join(tempDir, 'Drafts', 'My Project'),
      instances,
      { Name: 'My Project' }
    );

    expect(result.created).toHaveLength(1);
    
    // Read the file (filed in the child `research` type's output_dir).
    const content = await import('fs/promises').then(fs =>
      fs.readFile(join(tempDir, 'Drafts', 'SEO Research.md'), 'utf-8')
    );
    expect(content).toContain('topic: SEO Template Default');
    expect(content).toContain('## SEO Research');
    expect(content).toContain('Template body here.');
  });

  it('evaluates date expressions in instance defaults', async () => {
    // Use a fixed date for predictable testing
    const originalDate = Date;
    const fixedDate = new Date('2025-06-15T10:30:00.000Z');
    global.Date = class extends originalDate {
      constructor(...args: [] | [string | number | Date]) {
        if (args.length === 0) {
          super(fixedDate.getTime());
        } else {
          super(args[0]);
        }
      }
      static now() { return fixedDate.getTime(); }
    } as DateConstructor;

    try {
      const instances = [
        {
          type: 'research',
          filename: 'Dated Research.md',
          // `due` is a date field → the expression evaluates.
          // `topic` is a text field whose value looks like a date expression →
          // it must pass through verbatim (regression #629).
          defaults: { due: "today() + '7d'", topic: "today() later" },
        },
      ];

      const result = await createScaffoldedInstances(
        schema,
        tempDir,
        'draft',
        join(tempDir, 'Drafts', 'My Project'),
        instances,
        { Name: 'My Project' }
      );

      expect(result.created).toHaveLength(1);
      
      // Read the file (filed in the child `research` type's output_dir).
      const content = await import('fs/promises').then(fs =>
        fs.readFile(join(tempDir, 'Drafts', 'Dated Research.md'), 'utf-8')
      );
      // today() + '7d' from 2025-06-15 = 2025-06-22 (date field evaluates)
      // YAML serializes simple strings without quotes
      expect(content).toContain('due: 2025-06-22');
      // Non-date field passes through verbatim, NOT evaluated.
      expect(content).toContain('topic: today() later');
    } finally {
      global.Date = originalDate;
    }
  });

  describe('getFilenamePattern', () => {
    it('returns template pattern when template has filenamePattern', () => {
      const template = { 
        name: 'test',
        filenamePattern: '{date} - {title}',
        defaults: {},
        body: '',
      };
      const typeDef = { 
        name: 'idea',
        frontmatter: {},
        filename: '{name}',
      };
      
      expect(getFilenamePattern(template as any, typeDef as any)).toBe('{date} - {title}');
    });

    it('returns type-level pattern when template has no pattern', () => {
      const template = { 
        name: 'test',
        defaults: {},
        body: '',
      };
      const typeDef = { 
        name: 'idea',
        frontmatter: {},
        filename: '{name}',
      };
      
      expect(getFilenamePattern(template as any, typeDef as any)).toBe('{name}');
    });

    it('returns null when neither template nor type has pattern', () => {
      const template = { 
        name: 'test',
        defaults: {},
        body: '',
      };
      const typeDef = { 
        name: 'idea',
        frontmatter: {},
      };
      
      expect(getFilenamePattern(template as any, typeDef as any)).toBeNull();
    });

    it('returns null when template is null', () => {
      const typeDef = { 
        name: 'idea',
        frontmatter: {},
      };
      
      expect(getFilenamePattern(null, typeDef as any)).toBeNull();
    });

    it('template pattern takes precedence over type-level pattern', () => {
      const template = { 
        name: 'test',
        filenamePattern: '{date}',
        defaults: {},
        body: '',
      };
      const typeDef = { 
        name: 'idea',
        frontmatter: {},
        filename: '{name}',
      };
      
      expect(getFilenamePattern(template as any, typeDef as any)).toBe('{date}');
    });
  });

  describe('resolveFilenamePattern', () => {
    it('resolves {date} placeholder with default format', () => {
      const result = resolveFilenamePattern('{date}', {}, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.missingFields).toEqual([]);
    });

    it('resolves {date:FORMAT} with custom format', () => {
      const result = resolveFilenamePattern('{date:YYYY-MM}', {}, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toMatch(/^\d{4}-\d{2}$/);
      expect(result.missingFields).toEqual([]);
    });

    it('resolves frontmatter field placeholders', () => {
      const result = resolveFilenamePattern('{title}', { title: 'My Note' }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toBe('My Note');
      expect(result.missingFields).toEqual([]);
    });

    it('resolves combined date and field placeholders', () => {
      const result = resolveFilenamePattern('{date} - {title}', { title: 'Daily Log' }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2} - Daily Log$/);
      expect(result.missingFields).toEqual([]);
    });

    it('returns unresolved when field is missing', () => {
      const result = resolveFilenamePattern('{title}', {}, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(false);
      expect(result.filename).toBeNull();
      expect(result.missingFields).toEqual(['title']);
    });

    it('returns unresolved when field is null', () => {
      const result = resolveFilenamePattern('{title}', { title: null }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(false);
      expect(result.filename).toBeNull();
      expect(result.missingFields).toEqual(['title']);
    });

    it('returns unresolved when field is empty string', () => {
      const result = resolveFilenamePattern('{title}', { title: '' }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(false);
      expect(result.filename).toBeNull();
      expect(result.missingFields).toEqual(['title']);
    });

    it('reports multiple missing fields', () => {
      const result = resolveFilenamePattern('{title} - {status}', {}, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(false);
      expect(result.filename).toBeNull();
      expect(result.missingFields).toEqual(['title', 'status']);
    });

    it('sanitizes invalid filename characters', () => {
      const result = resolveFilenamePattern('{title}', { title: 'Note: A/B Test?' }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toBe('Note AB Test');
      expect(result.missingFields).toEqual([]);
    });

    it('returns unresolved when sanitization results in empty string', () => {
      const result = resolveFilenamePattern('{title}', { title: '::/' }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(false);
      expect(result.filename).toBeNull();
      expect(result.missingFields).toEqual([]);
    });

    it('handles array values by joining with commas', () => {
      const result = resolveFilenamePattern('{tags}', { tags: ['a', 'b', 'c'] }, 'YYYY-MM-DD');
      
      expect(result.resolved).toBe(true);
      expect(result.filename).toBe('a, b, c');
      expect(result.missingFields).toEqual([]);
    });
  });
});

// ============================================================================
// Template Inheritance Tests
// ============================================================================

describe('template inheritance', () => {
  let tempDir: string;
  let schema: LoadedSchema;

  // Schema with type hierarchy for inheritance testing:
  // meta -> objective -> task
  const testSchemaRaw: Schema = {
    version: 2,
    types: {
      meta: {
        fields: {
          creation_date: { prompt: 'date' },
        },
      },
      objective: {
        extends: 'meta',
        output_dir: 'Objectives',
        fields: {
          status: { prompt: 'select', options: ['not-started', 'in-progress', 'done'], default: 'not-started' },
        },
      },
      task: {
        extends: 'objective',
        output_dir: 'Objectives/Tasks',
        fields: {
          priority: { prompt: 'select', options: ['low', 'medium', 'high'], default: 'medium' },
        },
      },
      idea: {
        extends: 'meta',
        output_dir: 'Ideas',
        fields: {
          category: { prompt: 'text' },
        },
      },
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'template-inherit-test-'));
    schema = resolveSchema(testSchemaRaw);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('findDefaultTemplateWithInheritance', () => {
    it('returns own default template when it exists', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
defaults:
  priority: high
---
Task template.
`
      );

      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('default');
      expect(result?.inheritedFrom).toBeUndefined();
      expect(result?.defaults?.priority).toBe('high');
    });

    it('inherits default template from parent when child has none', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/objective'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/objective', 'default.md'),
        `---
type: template
template-for: objective
defaults:
  status: in-progress
---
Objective template.
`
      );

      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('default');
      expect(result?.inheritedFrom).toBe('objective');
      expect(result?.defaults?.status).toBe('in-progress');
    });

    it('inherits default template from grandparent when parent has none', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "@today"
---
Meta template.
`
      );

      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('default');
      expect(result?.inheritedFrom).toBe('meta');
    });

    it('returns null when no default template exists in chain', async () => {
      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);
      expect(result).toBeNull();
    });

    it('prefers own default over inherited', async () => {
      // Create templates at multiple levels
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "@today"
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
defaults:
  priority: high
---
`
      );

      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);

      expect(result?.inheritedFrom).toBeUndefined();
      expect(result?.defaults?.priority).toBe('high');
    });
  });

  describe('getDefaultTemplateChain', () => {
    it('returns empty array when no templates exist', async () => {
      const chain = await getDefaultTemplateChain(tempDir, 'task', schema);
      expect(chain).toEqual([]);
    });

    it('returns templates from all levels in chain (root-first)', async () => {
      // Create templates at multiple levels
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/objective'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "@today"
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/objective', 'default.md'),
        `---
type: template
template-for: objective
defaults:
  status: in-progress
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
defaults:
  priority: high
---
`
      );

      const chain = await getDefaultTemplateChain(tempDir, 'task', schema);

      expect(chain).toHaveLength(3);
      // Should be root-first order
      expect(chain[0]?.templateFor).toBe('meta');
      expect(chain[0]?.inheritedFrom).toBe('meta');
      expect(chain[1]?.templateFor).toBe('objective');
      expect(chain[1]?.inheritedFrom).toBe('objective');
      expect(chain[2]?.templateFor).toBe('task');
      expect(chain[2]?.inheritedFrom).toBeUndefined(); // Own template
    });

    it('skips levels without templates', async () => {
      // Only create meta and task templates, not objective
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "@today"
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
defaults:
  priority: high
---
`
      );

      const chain = await getDefaultTemplateChain(tempDir, 'task', schema);

      expect(chain).toHaveLength(2);
      expect(chain[0]?.templateFor).toBe('meta');
      expect(chain[1]?.templateFor).toBe('task');
    });
  });

  describe('mergeTemplateDefaults', () => {
    it('merges defaults from chain with child overriding parent', () => {
      const templates = [
        { 
          name: 'default', 
          templateFor: 'meta', 
          path: '/path/meta/default.md', 
          body: '', 
          defaults: { creation_date: '2025-01-01', status: 'draft' },
          inheritedFrom: 'meta',
        },
        { 
          name: 'default', 
          templateFor: 'task', 
          path: '/path/task/default.md', 
          body: '', 
          defaults: { status: 'not-started', priority: 'high' },
          inheritedFrom: undefined,
        },
      ];

      const merged = mergeTemplateDefaults(templates, 'YYYY-MM-DD');

      expect(merged.creation_date).toBe('2025-01-01');
      expect(merged.status).toBe('not-started'); // Child overrides parent
      expect(merged.priority).toBe('high');
    });

    it('returns empty object for empty chain', () => {
      const merged = mergeTemplateDefaults([], 'YYYY-MM-DD');
      expect(merged).toEqual({});
    });

    it('evaluates @today offset date expressions in defaults', () => {
      const originalDate = Date;
      const fixedDate = new Date('2025-06-15T10:30:00.000Z');
      global.Date = class extends originalDate {
        constructor(...args: [] | [string | number | Date]) {
          if (args.length === 0) super(fixedDate.getTime());
          else super(args[0]);
        }
        static now() { return fixedDate.getTime(); }
      } as DateConstructor;

      try {
        const templates = [
          {
            name: 'default',
            templateFor: 'task',
            path: '/path/task/default.md',
            body: '',
            // @today shorthand (#603) alongside the legacy today() form and a
            // plain non-date string that must pass through untouched.
            defaults: {
              deadline: '@today+3d',
              start: 'today()',
              status: 'not-started',
            },
            inheritedFrom: undefined,
          },
        ];

        const merged = mergeTemplateDefaults(templates, 'YYYY-MM-DD', {
          deadline: { prompt: 'date' },
          start: { prompt: 'date' },
          status: { prompt: 'select' },
        });

        expect(merged.deadline).toBe('2025-06-18');
        expect(merged.start).toBe('2025-06-15');
        expect(merged.status).toBe('not-started');
      } finally {
        global.Date = originalDate;
      }
    });

    it('staggers multiple @today offsets across fields', () => {
      const originalDate = Date;
      const fixedDate = new Date('2025-06-15T10:30:00.000Z');
      global.Date = class extends originalDate {
        constructor(...args: [] | [string | number | Date]) {
          if (args.length === 0) super(fixedDate.getTime());
          else super(args[0]);
        }
        static now() { return fixedDate.getTime(); }
      } as DateConstructor;

      try {
        const merged = mergeTemplateDefaults(
          [
            {
              name: 'default',
              templateFor: 'task',
              path: '/path/task/default.md',
              body: '',
              defaults: { d1: '@today+1d', d2: '@today+1w', d3: '@today+1m' },
              inheritedFrom: undefined,
            },
          ],
          'YYYY-MM-DD',
          { d1: { prompt: 'date' }, d2: { prompt: 'date' }, d3: { prompt: 'date' } }
        );

        expect(merged.d1).toBe('2025-06-16');
        expect(merged.d2).toBe('2025-06-22');
        expect(merged.d3).toBe('2025-07-15');
      } finally {
        global.Date = originalDate;
      }
    });

    it('passes through non-date field defaults that look like date expressions (regression #629)', () => {
      // A text/select field whose default merely *starts* with @today/@now/today(/now(
      // must be stored verbatim — never evaluated, never throwing. This is the
      // critical bug: prose like "@today-ish note" blocked note creation.
      const templates = [
        {
          name: 'default',
          templateFor: 'task',
          path: '/path/task/default.md',
          body: '',
          defaults: {
            note: '@today-ish note',
            label: '@today note',
            summary: 'today() later',
          },
          inheritedFrom: undefined,
        },
      ];

      const merged = mergeTemplateDefaults(templates, 'YYYY-MM-DD', {
        note: { prompt: 'text' },
        label: { prompt: 'select' },
        summary: { prompt: 'text' },
      });

      expect(merged.note).toBe('@today-ish note');
      expect(merged.label).toBe('@today note');
      expect(merged.summary).toBe('today() later');
    });

    it('throws on malformed date expression for a date-typed field (typo protection)', () => {
      const templates = [
        {
          name: 'default',
          templateFor: 'task',
          path: '/path/task/default.md',
          body: '',
          defaults: { deadline: '@today+3x' },
          inheritedFrom: undefined,
        },
      ];

      expect(() =>
        mergeTemplateDefaults(templates, 'YYYY-MM-DD', { deadline: { prompt: 'date' } })
      ).toThrow(/Invalid date expression/);
    });
  });

  describe('resolveTemplateWithInheritance', () => {
    it('returns merged defaults from inheritance chain', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "2025-01-01"
  status: draft
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
defaults:
  status: not-started
  priority: high
---
`
      );

      const result = await resolveTemplateWithInheritance(tempDir, 'task', schema, {});

      expect(result.template).not.toBeNull();
      expect(result.template?.inheritedFrom).toBeUndefined(); // Using own template
      expect(result.mergedDefaults.creation_date).toBe('2025-01-01');
      expect(result.mergedDefaults.status).toBe('not-started'); // Child overrides
      expect(result.mergedDefaults.priority).toBe('high');
    });

    it('uses inherited template when child has none', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "2025-01-01"
---
`
      );

      const result = await resolveTemplateWithInheritance(tempDir, 'task', schema, {});

      expect(result.template).not.toBeNull();
      expect(result.template?.inheritedFrom).toBe('meta');
      expect(result.mergedDefaults.creation_date).toBe('2025-01-01');
    });

    it('skips templates when noTemplate is true', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
defaults:
  creation_date: "2025-01-01"
---
`
      );

      const result = await resolveTemplateWithInheritance(tempDir, 'task', schema, { noTemplate: true });

      expect(result.template).toBeNull();
      expect(result.mergedDefaults).toEqual({});
    });

    it('finds specific template by name without inheritance', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'bug-report.md'),
        `---
type: template
template-for: task
defaults:
  priority: critical
---
`
      );

      const result = await resolveTemplateWithInheritance(tempDir, 'task', schema, { 
        templateName: 'bug-report' 
      });

      expect(result.template?.name).toBe('bug-report');
      expect(result.mergedDefaults.priority).toBe('critical');
    });

    it('prompts when multiple templates exist without default', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'alpha.md'),
        `---
type: template
template-for: task
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'beta.md'),
        `---
type: template
template-for: task
---
`
      );

      const result = await resolveTemplateWithInheritance(tempDir, 'task', schema, {});

      expect(result.template).toBeNull();
      expect(result.shouldPrompt).toBe(true);
      expect(result.availableTemplates).toHaveLength(2);
    });
  });

  describe('getInheritedTemplates', () => {
    it('returns empty array when no ancestors have templates', async () => {
      const inherited = await getInheritedTemplates(tempDir, 'task', schema);
      expect(inherited).toEqual([]);
    });

    it('returns default templates from ancestors', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/meta'), { recursive: true });
      await mkdir(join(tempDir, '.bwrb/templates/objective'), { recursive: true });
      
      await writeFile(
        join(tempDir, '.bwrb/templates/meta', 'default.md'),
        `---
type: template
template-for: meta
---
`
      );
      await writeFile(
        join(tempDir, '.bwrb/templates/objective', 'default.md'),
        `---
type: template
template-for: objective
---
`
      );

      const inherited = await getInheritedTemplates(tempDir, 'task', schema);

      expect(inherited).toHaveLength(2);
      expect(inherited[0]?.inheritedFrom).toBe('objective');
      expect(inherited[1]?.inheritedFrom).toBe('meta');
    });

    it('does not include templates from the type itself', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/task'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb/templates/task', 'default.md'),
        `---
type: template
template-for: task
---
`
      );

      const inherited = await getInheritedTemplates(tempDir, 'task', schema);

      expect(inherited).toEqual([]);
    });
  });

  describe('named templates do not inherit', () => {
    it('findDefaultTemplateWithInheritance only finds default.md', async () => {
      await mkdir(join(tempDir, '.bwrb/templates/objective'), { recursive: true });
      // Create a named template (not default.md) in parent
      await writeFile(
        join(tempDir, '.bwrb/templates/objective', 'special.md'),
        `---
type: template
template-for: objective
---
`
      );

      const result = await findDefaultTemplateWithInheritance(tempDir, 'task', schema);

      // Should not find the named template
      expect(result).toBeNull();
    });
  });
});

describe('createEmptyTemplateResolution', () => {
  it('returns all required fields with empty/null defaults', () => {
    const result = createEmptyTemplateResolution();
    expect(result.template).toBeNull();
    expect(result.mergedDefaults).toEqual({});
    expect(result.mergedConstraints).toEqual({});
    expect(result.mergedPromptFields).toEqual([]);
    expect(result.shouldPrompt).toBe(false);
    expect(result.availableTemplates).toEqual([]);
  });

  it('applies overrides while keeping unspecified fields at defaults', () => {
    const result = createEmptyTemplateResolution({ shouldPrompt: true });
    expect(result.shouldPrompt).toBe(true);
    expect(result.template).toBeNull();
    expect(result.mergedDefaults).toEqual({});
    expect(result.mergedConstraints).toEqual({});
    expect(result.mergedPromptFields).toEqual([]);
    expect(result.availableTemplates).toEqual([]);
  });
});

/**
 * End-to-end coverage for #603: a templated `@today+Nd` value must flow through
 * the same normalization (#592) the `new` command applies on write, land as a
 * canonical YYYY-MM-DD date, and pass validation (so `bwrb audit` stays clean).
 */
describe('template date expressions through normalization (#603)', () => {
  const baseSchema: Schema = {
    version: 2,
    types: {
      task: {
        output_dir: 'Tasks',
        fields: {
          title: { prompt: 'text', required: true },
          deadline: { prompt: 'date' },
          // Coarse field: granularity must be respected by normalization.
          quarter: { prompt: 'date', granularity: 'month' },
          status: { prompt: 'select', options: ['todo', 'doing', 'done'], default: 'todo' },
        },
      },
    },
  };

  const fixedDate = new Date('2025-06-15T10:30:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTemplate(defaults: Record<string, unknown>): Parameters<typeof mergeTemplateDefaults>[0][number] {
    return {
      name: 'default',
      templateFor: 'task',
      path: '/path/task/default.md',
      body: '',
      defaults,
      inheritedFrom: undefined,
    };
  }

  it('normalizes a templated @today+3d deadline to canonical ISO and passes validation', () => {
    const schema = resolveSchema(baseSchema);

    const merged = mergeTemplateDefaults(
      [makeTemplate({ title: 'Draft', deadline: '@today+3d' })],
      schema.config.dateFormat,
      getFieldsForType(schema, 'task')
    );

    // Evaluated, but not yet normalized.
    expect(merged.deadline).toBe('2025-06-18');

    const normalized = normalizeDateFields(schema, 'task', merged);
    expect(normalized.deadline).toBe('2025-06-18');

    const result = validateFrontmatter(schema, 'task', normalized);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('normalizes a non-ISO date format back to canonical ISO on write', () => {
    const schema = resolveSchema(baseSchema);
    // Template author runs with a US display format; the evaluated value is
    // MM/DD/YYYY, but normalization must store canonical ISO.
    const merged = mergeTemplateDefaults(
      [makeTemplate({ title: 'Draft', deadline: '@today+3d' })],
      'MM/DD/YYYY',
      getFieldsForType(schema, 'task')
    );
    expect(merged.deadline).toBe('06/18/2025');

    const normalized = normalizeDateFields(schema, 'task', merged);
    expect(normalized.deadline).toBe('2025-06-18');
    expect(validateFrontmatter(schema, 'task', normalized).valid).toBe(true);
  });

  it('respects granularity: a month-granularity field keeps a coarse evaluated value valid', () => {
    const schema = resolveSchema(baseSchema);
    // A full date assigned to a month-granularity field is still a valid full
    // date (granularity is a *minimum* precision), and stays canonical ISO.
    const merged = mergeTemplateDefaults(
      [makeTemplate({ title: 'Plan', quarter: '@today+1m' })],
      schema.config.dateFormat,
      getFieldsForType(schema, 'task')
    );
    expect(merged.quarter).toBe('2025-07-15');

    const normalized = normalizeDateFields(schema, 'task', merged);
    expect(normalized.quarter).toBe('2025-07-15');
    expect(validateFrontmatter(schema, 'task', normalized).valid).toBe(true);
  });

  it('does not mangle non-date string defaults', () => {
    const schema = resolveSchema(baseSchema);
    const merged = mergeTemplateDefaults(
      // status/title carry text that superficially mentions today; they must
      // not be evaluated because they do not match the anchored grammar.
      [makeTemplate({ title: 'todo @today review', status: 'doing' })],
      schema.config.dateFormat,
      getFieldsForType(schema, 'task')
    );

    expect(merged.title).toBe('todo @today review');
    expect(merged.status).toBe('doing');

    const normalized = normalizeDateFields(schema, 'task', merged);
    expect(normalized.title).toBe('todo @today review');
    expect(validateFrontmatter(schema, 'task', normalized).valid).toBe(true);
  });

  it('stores @today-prefixed prose on a non-date field verbatim and passes validation (regression #629)', () => {
    const schema = resolveSchema(baseSchema);
    // title is a text field: "@today-ish note" starts with @today + word
    // boundary, the exact shape that previously raised a hard error and blocked
    // note creation. It must now flow through verbatim and validate cleanly.
    const merged = mergeTemplateDefaults(
      [makeTemplate({ title: '@today-ish note', deadline: '@today+3d' })],
      schema.config.dateFormat,
      getFieldsForType(schema, 'task')
    );

    expect(merged.title).toBe('@today-ish note');
    // The genuine date field still evaluates alongside it.
    expect(merged.deadline).toBe('2025-06-18');

    const normalized = normalizeDateFields(schema, 'task', merged);
    expect(normalized.title).toBe('@today-ish note');
    expect(validateFrontmatter(schema, 'task', normalized).valid).toBe(true);
  });
});
