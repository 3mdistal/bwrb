# Template System

> Reusable note templates with defaults, constraints, and project scaffolding

---

## Overview

Templates are markdown files that define:

1. **Default field values** — Pre-fill frontmatter
2. **Body structure** — Headings, sections, checklists
3. **Constraints** — Validation rules stricter than schema
4. **Instance scaffolding** — Create multiple related notes at once

Templates are stored in the vault and managed in Obsidian like any other note.

---

## Template Location

Templates live in `Templates/{type}/{subtype}/`:

```
Templates/
  objective/
    task/
      default.md           ← Default template for tasks
      bug-report.md        ← Bug report template
      feature-request.md   ← Feature request template
    milestone/
      default.md
  idea/
    default.md
  draft/
    default.md             ← Default template for draft parent
    builder-blog.md        ← Builder.io blog post scaffold
    version/
      default.md
    research/
      default.md
      seo.md               ← SEO research template
      competitor.md
```

---

## Template Format

Templates are markdown files with special frontmatter:

```yaml
---
type: template
template-for: objective/task
description: "Bug report with reproduction steps"
defaults:
  status: inbox
  priority: high
  tags:
    - bug
constraints:
  deadline:
    required: true
    validate: "this < today() + '14d'"
    error: "Bugs should be fixed within 2 weeks"
filename-pattern: "Bug - {title}"
---

# {title}

## Description

[Describe the bug]

## Steps to Reproduce

1. 
2. 
3. 

## Expected Behavior

## Actual Behavior

## Environment

- OS: 
- Version: 

## Screenshots

## Additional Context
```

---

## Frontmatter Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Must be `template` |
| `template-for` | Yes | Target type/subtype (e.g., `objective/task`) |
| `description` | No | Human-readable description |
| `defaults` | No | Default field values |
| `constraints` | No | Validation rules |
| `filename-pattern` | No | Override default filename |
| `instances` | No | Subtype scaffolding (for instance-grouped types) |
| `prompt-fields` | No | Fields to always prompt for (even with defaults) |

---

## Default Values

Templates can set defaults for any field:

```yaml
defaults:
  status: inbox
  priority: high
  tags:
    - bug
    - urgent
  milestone: "[[Q1 Release]]"
```

**Behavior:**
- Fields with defaults are **skipped** during prompting
- Use `prompt-fields` to force prompting even with defaults
- Defaults override schema defaults

---

## Constraints

Templates can enforce rules stricter than the schema:

```yaml
constraints:
  deadline:
    required: true                      # Make optional field required
    validate: "this < today() + '5d'"   # Must be within 5 days
    error: "Deadline must be within 5 days for urgent tasks"
  
  priority:
    validate: "this == 'critical' || this == 'high'"
    error: "Priority must be critical or high for this template"
  
  status:
    validate: "this != 'done'"
    error: "Can't use this template for completed tasks"
```

### Constraint Properties

| Property | Description |
|----------|-------------|
| `required` | Make an optional field required |
| `validate` | Expression that must evaluate to true |
| `error` | Custom error message |

### Constraint Expressions

Constraints use the same expression syntax as queries:

- `this` refers to the field value
- All query operators available (`==`, `!=`, `<`, `>`, etc.)
- All query functions available (`contains()`, `isEmpty()`, etc.)

**Examples:**

```yaml
# String constraints
title:
  validate: "!isEmpty(this) && this.length > 5"
  error: "Title must be at least 5 characters"

# Date constraints
deadline:
  validate: "this >= today()"
  error: "Deadline cannot be in the past"

# Enum constraints (narrowing)
priority:
  validate: "this == 'critical' || this == 'high'"
  error: "Only critical or high priority allowed"

# List constraints
tags:
  validate: "contains(this, 'bug')"
  error: "Bug reports must have 'bug' tag"
```

---

## Filename Patterns

Override the default filename:

```yaml
filename-pattern: "Bug - {title}"
# Creates: Bug - Login fails on mobile.md

filename-pattern: "{date} - {title}"
# Creates: 2025-01-15 - Login fails on mobile.md

filename-pattern: "Week {date:ww} Review"
# Creates: Week 03 Review.md
```

### Pattern Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{title}` | Note title | `My Task` |
| `{date}` | Today (YYYY-MM-DD) | `2025-01-15` |
| `{date:format}` | Formatted date | `2025-01`, `Week 03` |
| `{field}` | Any frontmatter field | `{priority}` |

---

## Body Structure

The template body becomes the note body, with variable substitution:

```markdown
# {title}

## Description

## Checklist

- [ ] First step
- [ ] Second step
- [ ] Third step

## Notes
```

### Section Markers

Empty sections indicate expected content type:

```markdown
## Steps to Reproduce

1. 

## Checklist

- [ ] 

## Notes

- 
```

---

## CLI Usage

### Single Template

```bash
# Use default template
bwrb new task --template default
# → Uses Templates/objective/task/default.md

# Specify template
bwrb new task --template bug-report
# → Uses Templates/objective/task/bug-report.md

# Interactive selection (if multiple templates)
bwrb new task
# Multiple templates found:
#   1. default
#   2. bug-report
#   3. feature-request
# Select template: [1]
```

### No Template

```bash
# Skip template, use schema only
bwrb new task --no-template
```

### List Templates

```bash
bwrb template list
# TYPE           TEMPLATE         DESCRIPTION
# objective/task default          Standard task
# objective/task bug-report       Bug report with reproduction steps
# objective/task feature-request  Feature request with acceptance criteria
# idea           default          Quick idea capture

bwrb template list task
# TEMPLATE         DESCRIPTION
# default          Standard task
# bug-report       Bug report with reproduction steps
# feature-request  Feature request with acceptance criteria
```

---

## Parent Templates (Instance Scaffolding)

For instance-grouped types, templates can scaffold entire project structures:

### Example: Builder.io Blog Template

```yaml
---
type: template
template-for: draft
description: "Builder.io blog post with full research structure"
defaults:
  status: in-progress
  tags:
    - builder-blog
instances:
  - subtype: version
    filename: "Draft v1.md"
    template: Templates/draft/version/default.md
  
  - subtype: research
    filename: "SEO Research.md"
    template: Templates/draft/research/seo.md
  
  - subtype: research
    filename: "Competitor Analysis.md"
    template: Templates/draft/research/competitor.md
  
  - subtype: notes
    filename: "Colleague Feedback.md"
    defaults:
      status: inbox
  
  - subtype: resources
    filename: "Resources.md"
---

# {title}

## Overview

Blog post for Builder.io about [topic].

## Target Audience

## Key Points

1. 
2. 
3. 

## Links

- [[Draft v1]]
- [[SEO Research]]
- [[Competitor Analysis]]
- [[Colleague Feedback]]
- [[Resources]]
```

### Instance Properties

| Property | Required | Description |
|----------|----------|-------------|
| `subtype` | Yes | Which subtype to create |
| `filename` | No | Override filename |
| `template` | No | Template for this instance |
| `defaults` | No | Additional defaults for this instance |

### CLI Behavior

```bash
bwrb new draft --template builder-blog --set title="Q1 Feature Announcement"

# Creating draft: Q1 Feature Announcement
# 
# Creating: Drafts/Q1 Feature Announcement/Q1 Feature Announcement.md (parent)
# Creating: Drafts/Q1 Feature Announcement/Draft v1.md (version)
# Creating: Drafts/Q1 Feature Announcement/SEO Research.md (research)
# Creating: Drafts/Q1 Feature Announcement/Competitor Analysis.md (research)
# Creating: Drafts/Q1 Feature Announcement/Colleague Feedback.md (notes)
# Creating: Drafts/Q1 Feature Announcement/Resources.md (resources)
# 
# ✓ Created 6 files
```

---

## Template Discovery

### Search Order

1. `Templates/{type}/{subtype}/{name}.md` — Exact match
2. `Templates/{type}/{subtype}/default.md` — Subtype default
3. `Templates/{type}/default.md` — Type default
4. No template (use schema only)

### Discovery Logic

```typescript
function findTemplates(vaultPath: string, typePath: string): Template[] {
  const [type, subtype] = typePath.split('/');
  const templatesDir = path.join(vaultPath, 'Templates');
  
  const searchPaths = subtype
    ? [
        path.join(templatesDir, type, subtype),
        path.join(templatesDir, type),
      ]
    : [path.join(templatesDir, type)];
  
  const templates: Template[] = [];
  
  for (const searchPath of searchPaths) {
    const files = glob.sync('*.md', { cwd: searchPath });
    for (const file of files) {
      const template = parseTemplate(path.join(searchPath, file));
      if (template.templateFor === typePath) {
        templates.push(template);
      }
    }
  }
  
  return templates;
}
```

---

## Prompt Fields

Force prompting for fields even when defaults exist:

```yaml
defaults:
  status: inbox
  priority: high
  deadline: "today() + '7d'"

prompt-fields:
  - title      # Always prompt (no default anyway)
  - deadline   # Prompt despite default
```

This is useful when:
- Default is a suggestion, not a fixed value
- You want user confirmation of critical fields

---

## Relationship to Schema

### Schema vs Template

| Aspect | Schema | Template |
|--------|--------|----------|
| Field definitions | ✓ | — |
| Enum values | ✓ | — |
| Required fields | ✓ (base) | Can narrow |
| Default values | ✓ (base) | Can override |
| Validation | ✓ (type-based) | Can add constraints |
| Body structure | — | ✓ |
| Filename pattern | ✓ (base) | Can override |

### Constraint Rules

Templates can **narrow** but not **loosen** schema requirements:

| Schema Says | Template Can | Template Cannot |
|-------------|--------------|-----------------|
| `required: true` | Keep required | Make optional |
| `required: false` | Make required | — |
| `enum: [a, b, c]` | Narrow to `[a, b]` | Add `d` |
| `default: "x"` | Change to `"y"` | — |

---

## Template Validation

### On Load

```bash
bwrb template validate

# Validating templates...
# 
# Templates/objective/task/bug-report.md
#   ✓ Valid
# 
# Templates/objective/task/broken.md
#   ✗ Invalid constraint expression: "this <> 5" (line 12)
#   ✗ Unknown field in defaults: "priorty" (did you mean "priority"?)
# 
# 2 templates, 1 valid, 1 invalid
```

### On Use

If a template has validation errors, `bwrb new` will:
1. Warn about the errors
2. Offer to continue without template
3. Or abort

---

## Managing Templates

### Create Template

```bash
bwrb template new task
# Template name: quick-task
# Description: Fast task capture with minimal fields
# 
# Set defaults? [Y/n] y
# Status: inbox
# Priority: medium
# 
# Add constraints? [y/N] n
# 
# ✓ Created Templates/objective/task/quick-task.md
```

### Edit Template

Templates are just markdown files — edit in Obsidian or any editor.

### Audit Templates

```bash
bwrb audit --templates

# Template Issues:
#   Templates/draft/version/old.md
#     - template-for type 'draft/version' doesn't exist in schema
#   
#   Templates/objective/task/bug-report.md
#     - Default for 'priority' uses unknown value: 'urgent'
```

---

## Success Criteria

1. **Discoverability** — Templates found automatically based on type
2. **Flexibility** — Defaults, constraints, body structure all customizable
3. **Scaffolding** — Parent templates can create entire project structures
4. **Validation** — Templates validate against schema, constraints validate at creation
5. **User-friendly** — Templates are markdown files, editable in Obsidian
