import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import { parseFrontmatter } from '../../../src/lib/frontmatter.js';

describe('template command', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('template list', () => {
    it('should list all templates', async () => {
      const result = await runCLI(['template', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Templates');
      expect(result.stdout).toContain('idea');
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('default');
    });

    it('should filter by type', async () => {
      const result = await runCLI(['template', 'list', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('task');
      expect(result.stdout).toContain('default');
      expect(result.stdout).toContain('bug-report');
      // Should not contain idea templates
      expect(result.stdout).not.toMatch(/^idea\s/m);
    });

    it('should output JSON format', async () => {
      const result = await runCLI(['template', 'list', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.templates).toBeInstanceOf(Array);
      expect(json.data.templates.length).toBeGreaterThan(0);
      expect(json.data.templates[0]).toHaveProperty('type');
      expect(json.data.templates[0]).toHaveProperty('name');
      expect(json.data.templates[0]).toHaveProperty('status');
      expect(json.data.templates[0]).toHaveProperty('valid');
      expect(json.data.templates[0]).toHaveProperty('issues');
    });

    it('should mark invalid templates with status', async () => {
      await writeFile(
        join(vaultDir, '.bwrb/templates/idea', 'bad-default.md'),
        `---
type: template
template-for: idea
defaults:
  unknown-field: yep
---
Body
`
      );

      const result = await runCLI(['template', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toMatch(/idea\s+bad-default\s+invalid/);
    });

    it('should error on unknown type', async () => {
      const result = await runCLI(['template', 'list', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('should show message when no templates found', async () => {
      // Remove all templates
      await rm(join(vaultDir, '.bwrb/templates'), { recursive: true, force: true });
      
      const result = await runCLI(['template', 'list'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No templates found');
    });
  });

  describe('template list [type] [name] (show details)', () => {
    it('should show template details when both type and name provided', async () => {
      const result = await runCLI(['template', 'list', 'idea', 'default'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Template: default');
      expect(result.stdout).toContain('Type:');
      expect(result.stdout).toContain('idea');
      expect(result.stdout).toContain('Description:');
      expect(result.stdout).toContain('Default idea template');
      expect(result.stdout).toContain('Defaults:');
    });

    it('should show JSON format for specific template', async () => {
      const result = await runCLI(['template', 'list', 'idea', 'default', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('default');
      expect(json.data.type).toBe('idea');
      expect(json.data.description).toBe('Default idea template');
      expect(json.data.defaults).toHaveProperty('status');
      expect(json.data.valid).toBe(true);
      expect(json.data.status).toBe('valid');
    });

    it('should error on unknown template', async () => {
      const result = await runCLI(['template', 'list', 'idea', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Template not found');
    });

    it('should error on unknown type', async () => {
      const result = await runCLI(['template', 'list', 'nonexistent', 'default'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });
  });

  describe('typed boolean/number defaults downstream', () => {
    it('produces a correctly-typed note that passes audit', async () => {
      // Template stores a real number and boolean default (as #648 ensures the
      // interactive prompts do). A note created from it must have boolean/number
      // frontmatter (not strings) and pass audit.
      await writeFile(
        join(vaultDir, '.bwrb/templates/idea', 'typed.md'),
        `---
type: template
template-for: idea
description: Typed defaults
defaults:
  effort: 5
  archived: true
---

# {title}
`
      );

      const create = await runCLI(
        ['new', 'idea', '--json', '{"name": "Typed Defaults Note"}', '--template', 'typed'],
        vaultDir
      );
      expect(create.exitCode).toBe(0);
      const output = JSON.parse(create.stdout);

      const content = await readFile(join(vaultDir, output.path), 'utf-8');
      // Real number and boolean, not quoted strings.
      expect(content).toMatch(/^effort: 5$/m);
      expect(content).toMatch(/^archived: true$/m);

      const audit = await runCLI(['audit', '--path', output.path], vaultDir);
      expect(audit.exitCode).toBe(0);
    });
  });

  describe('relation defaults downstream (issue #715)', () => {
    it('instantiates a single-relation default as a CLEAN wikilink that passes audit', async () => {
      // A template stores a relation default the way `template new` / `template
      // edit` now do: a CLEAN link (`[[Active Milestone]]`), which the YAML
      // serializer quotes exactly once on disk. Instantiating it must yield a
      // note whose `milestone` frontmatter is a clean `[[Active Milestone]]`
      // wikilink (NO literal quote characters) and passes audit.
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'with-milestone.md'),
        `---
type: template
template-for: task
description: Task with a relation default
defaults:
  milestone: "[[Active Milestone]]"
---

# {title}
`
      );

      const create = await runCLI(
        ['new', 'task', '--json', '{"name": "Relation Default Task"}', '--template', 'with-milestone'],
        vaultDir
      );
      expect(create.exitCode).toBe(0);
      const output = JSON.parse(create.stdout);

      const content = await readFile(join(vaultDir, output.path), 'utf-8');
      // Clean wikilink on disk: `milestone: "[[Active Milestone]]"`, never the
      // double-quoted `milestone: '"[[Active Milestone]]"'` regression.
      expect(content).toMatch(/^milestone: "\[\[Active Milestone\]\]"$/m);
      expect(content).not.toContain(`'"[[`);

      const fm = parseFrontmatter(content);
      expect(fm.milestone).toBe('[[Active Milestone]]');

      const audit = await runCLI(['audit', '--path', output.path], vaultDir);
      expect(audit.exitCode).toBe(0);
    });
  });

  describe('template validate', () => {
    it('should validate all templates', async () => {
      const result = await runCLI(['template', 'validate'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Validating templates');
      expect(result.stdout).toContain('Valid');
    });

    it('should validate templates for specific type', async () => {
      const result = await runCLI(['template', 'validate', 'idea'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('idea');
      expect(result.stdout).toContain('Valid');
    });

    it('should detect invalid type path', async () => {
      // Create a template with invalid type
      await writeFile(
        join(vaultDir, '.bwrb/templates/idea', 'invalid.md'),
        `---
type: template
template-for: nonexistent/type
---
Body
`
      );

      const result = await runCLI(['template', 'validate'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid');
      expect(result.stdout).toContain('not found in schema');
    });

    it('should detect invalid default values', async () => {
      // Create a template with invalid enum value
      await writeFile(
        join(vaultDir, '.bwrb/templates/idea', 'bad-enum.md'),
        `---
type: template
template-for: idea
defaults:
  status: invalid-status
  priority: super-high
---
Body
`
      );

      const result = await runCLI(['template', 'validate'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid');
      expect(result.stdout).toContain("Invalid value 'invalid-status'");
      expect(result.stdout).toContain("Invalid value 'super-high'");
      expect(result.stdout).toContain("Update 'status' in defaults for 'idea' to an allowed value");
    });

    it('should suggest actionable typo corrections', async () => {
      // Create a template with typo in field name
      await writeFile(
        join(vaultDir, '.bwrb/templates/idea', 'typo.md'),
        `---
type: template
template-for: idea
defaults:
  staus: raw
  priorty: medium
---
Body
`
      );

      const result = await runCLI(['template', 'validate'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Type: idea');
      expect(result.stdout).toContain("Unknown field 'staus'");
      expect(result.stdout).toContain("Did you mean 'status'");
      expect(result.stdout).toContain("Remove 'staus' from defaults");
      expect(result.stdout).toContain("add 'staus' to the 'idea' schema");
    });

    it('should accept valid date expressions in defaults', async () => {
      // Create a template with valid date expression - use status which is a valid field
      // Date expressions are valid values even for non-date fields
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'dated.md'),
        `---
type: template
template-for: task
defaults:
  status: backlog
  deadline: "today() + '7d'"
---
Body
`
      );

      const result = await runCLI(['template', 'validate'], vaultDir);

      // The dated.md template should be marked as valid
      expect(result.stdout).toContain('dated.md');
      expect(result.stdout).toContain('Valid');
      // Overall validation should pass
      expect(result.exitCode).toBe(0);
    });

    it('should reject invalid date expressions in defaults', async () => {
      // Create a template with invalid date expression syntax
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'bad-date.md'),
        `---
type: template
template-for: task
defaults:
  status: backlog
  deadline: "today( + 7d"
---
Body
`
      );

      const result = await runCLI(['template', 'validate'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid');
      expect(result.stdout).toContain('Invalid date expression');
    });

    it('should pass non-date field defaults that look like date expressions (regression #629)', async () => {
      // `note` is a text field and `status` is a select field. Values that merely
      // *start* with @today / today() must be treated as literal text by
      // `template validate`, matching how `bwrb new` creates the note. Before the
      // fix, validate ran validateDateExpression on every string default and
      // falsely reported "Invalid date expression".
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'prose.md'),
        `---
type: template
template-for: task
defaults:
  status: backlog
  note: "@today-ish note"
---
Body
`
      );

      const result = await runCLI(['template', 'validate', 'task'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('prose.md');
      expect(result.stdout).toContain('Valid');
      expect(result.stdout).not.toContain('Invalid date expression');
    });

    it('should reject a malformed date expression on a date field', async () => {
      // `deadline` IS a date field, so a typo like @today+3x must still be
      // caught as a malformed date expression.
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'typo-date.md'),
        `---
type: template
template-for: task
defaults:
  status: backlog
  deadline: "@today+3x"
---
Body
`
      );

      const result = await runCLI(['template', 'validate', 'task'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid date expression');
    });

    it('should accept a valid @today offset on a date field', async () => {
      await writeFile(
        join(vaultDir, '.bwrb/templates/task', 'valid-date.md'),
        `---
type: template
template-for: task
defaults:
  status: backlog
  deadline: "@today+3d"
---
Body
`
      );

      const result = await runCLI(['template', 'validate', 'task'], vaultDir);

      expect(result.stdout).toContain('valid-date.md');
      expect(result.stdout).toContain('Valid');
      expect(result.exitCode).toBe(0);
    });

    it('should output JSON format', async () => {
      const result = await runCLI(['template', 'validate', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty('templates');
      expect(json.data).toHaveProperty('valid');
      expect(json.data).toHaveProperty('invalid');
    });
  });

  describe('template new (JSON mode)', () => {
    it('should create a template from JSON', async () => {
      const result = await runCLI([
        'template', 'new', 'idea',
        '--name', 'quick-idea',
        '--description', 'Quick idea capture',
        '--json', JSON.stringify({
          defaults: { status: 'raw' },
          body: '# {title}\n\nQuick note.',
        }),
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      
      // Verify file was created
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'quick-idea.md');
      expect(existsSync(templatePath)).toBe(true);
      
      const content = await readFile(templatePath, 'utf-8');
      expect(content).toContain('type: template');
      expect(content).toContain('template-for: idea');
      expect(content).toContain('Quick idea capture');
      expect(content).toContain('status: raw');
    });

    it('should error if template already exists', async () => {
      const result = await runCLI([
        'template', 'new', 'idea',
        '--name', 'default',
        '--json', '{}',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('should error on unknown type', async () => {
      const result = await runCLI([
        'template', 'new', 'nonexistent',
        '--name', 'test',
        '--json', '{}',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Unknown type');
    });

    it('should require name', async () => {
      const result = await runCLI([
        'template', 'new', 'idea',
        '--json', '{}',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('name is required');
    });
  });

  describe('template edit (JSON mode)', () => {
    it('should update template defaults', async () => {
      const result = await runCLI([
        'template', 'edit', 'idea', 'default',
        '--json', JSON.stringify({
          defaults: { status: 'backlog' },
        }),
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      
      // Verify file was updated
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'default.md');
      const content = await readFile(templatePath, 'utf-8');
      expect(content).toContain('status: backlog');
    });

    it('should update description', async () => {
      const result = await runCLI([
        'template', 'edit', 'idea', 'default',
        '--json', JSON.stringify({
          description: 'Updated description',
        }),
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'default.md');
      const content = await readFile(templatePath, 'utf-8');
      expect(content).toContain('Updated description');
    });

    it('should merge defaults (not replace)', async () => {
      // First check original
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'default.md');
      const original = await readFile(templatePath, 'utf-8');
      expect(original).toContain('priority: medium');
      expect(original).toContain('status: raw');

      // Update just status
      const result = await runCLI([
        'template', 'edit', 'idea', 'default',
        '--json', JSON.stringify({
          defaults: { status: 'backlog' },
        }),
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      
      const updated = await readFile(templatePath, 'utf-8');
      expect(updated).toContain('status: backlog');
      expect(updated).toContain('priority: medium'); // Still there
    });

    it('should remove field when set to null', async () => {
      const result = await runCLI([
        'template', 'edit', 'idea', 'default',
        '--json', JSON.stringify({
          defaults: { priority: null },
        }),
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'default.md');
      const content = await readFile(templatePath, 'utf-8');
      expect(content).not.toContain('priority:');
      expect(content).toContain('status: raw'); // Still there
    });

    it('should error on unknown template', async () => {
      const result = await runCLI([
        'template', 'edit', 'idea', 'nonexistent',
        '--json', '{}',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Template not found');
    });
  });

  describe('template delete', () => {
    it('should delete a template with --force', async () => {
      // First verify template exists
      const templatePath = join(vaultDir, '.bwrb/templates/idea', 'default.md');
      expect(existsSync(templatePath)).toBe(true);

      const result = await runCLI([
        'template', 'delete', 'idea', 'default', '--force',
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(result.stdout).toContain('.bwrb/templates/idea/default.md');
      
      // Verify file was deleted
      expect(existsSync(templatePath)).toBe(false);
    });

    it('should output JSON format on delete', async () => {
      const result = await runCLI([
        'template', 'delete', 'idea', 'default', '--force', '--output', 'json',
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.path).toContain('.bwrb/templates/idea/default.md');
      expect(json.message).toContain('deleted');
    });

    it('should error on unknown template', async () => {
      const result = await runCLI([
        'template', 'delete', 'idea', 'nonexistent', '--force',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Template not found');
    });

    it('should error on unknown type', async () => {
      const result = await runCLI([
        'template', 'delete', 'nonexistent', 'default', '--force',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type');
    });

    it('should output JSON error for unknown template', async () => {
      const result = await runCLI([
        'template', 'delete', 'idea', 'nonexistent', '--force', '--output', 'json',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Template not found');
    });

    it('should output JSON error for unknown type', async () => {
      const result = await runCLI([
        'template', 'delete', 'nonexistent', 'default', '--force', '--output', 'json',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Unknown type');
    });

    it('should delete nested subtype templates', async () => {
      // Test with task template (nested type)
      const templatePath = join(vaultDir, '.bwrb/templates/task', 'default.md');
      expect(existsSync(templatePath)).toBe(true);

      const result = await runCLI([
        'template', 'delete', 'task', 'default', '--force',
      ], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted');
      expect(existsSync(templatePath)).toBe(false);
    });
  });

  describe('unknown-type "did you mean" suggestions (#670)', () => {
    it('suggests a close type for a typo on template list (text)', async () => {
      const result = await runCLI(['template', 'list', 'taks'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type: taks');
      expect(result.stderr).toContain("Did you mean 'task'?");
    });

    it('suggests a close type for a typo on template new (json)', async () => {
      const result = await runCLI([
        'template', 'new', 'taks',
        '--name', 'test',
        '--json', '{}',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Unknown type: taks');
      expect(json.error).toContain("Did you mean 'task'?");
    });

    it('suggests a close type for a typo on template delete (json)', async () => {
      const result = await runCLI([
        'template', 'delete', 'taks', 'default', '--force', '--output', 'json',
      ], vaultDir);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain("Did you mean 'task'?");
    });

    it('suggests the canonical-case type for a case-only mismatch', async () => {
      const result = await runCLI(['template', 'list', 'TASK'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type: TASK');
      expect(result.stderr).toContain("Did you mean 'task'?");
    });

    it('omits the hint for a far-unknown type', async () => {
      const result = await runCLI(['template', 'list', 'completely-unknown-type'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown type: completely-unknown-type');
      expect(result.stderr).not.toContain('Did you mean');
    });
  });
});
