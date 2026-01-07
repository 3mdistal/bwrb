---
title: Templates Overview
description: Reusable defaults and body structure for note creation
---

Templates provide reusable defaults and body structure for note creation. They live in `.bwrb/templates/`.

## Template Location

Templates are organized by type path:

```
my-vault/
└── .bwrb/
    ├── schema.json
    └── templates/
        ├── idea/
        │   └── default.md
        └── objective/
            └── task/
                ├── default.md
                └── bug-report.md
```

## Template Format

Templates are markdown files with special frontmatter:

```yaml
---
type: template
template-for: objective/task
description: Bug report with reproduction steps
defaults:
  status: backlog
  priority: high
prompt-fields:
  - deadline
---

## Description

[Describe the bug]

## Steps to Reproduce

1. 
2. 
3. 
```

## Using Templates

```bash
# Auto-use default.md if it exists
bwrb new task

# Use specific template
bwrb new task --template bug-report

# Skip templates
bwrb new task --no-template
```

## How Templates Are Selected

When you run `bwrb new <type>`:

1. **With `--template name`** — Uses `.bwrb/templates/{type}/name.md`
2. **With `--no-template`** — Skips templates, uses schema defaults only
3. **Without flags** — Uses `.bwrb/templates/{type}/default.md` if it exists

If both `--template` and `--no-template` are specified, `--no-template` wins.

Templates use **strict type matching**—no inheritance. A template for `task` won't be found when creating `objective/task` unless it's in the correct directory.

## Template Workflow Example

Set up templates for a new note type:

```bash
# 1. Create a default template for tasks
bwrb template new task

# 2. Create a specialized bug report template
bwrb template new task --name bug-report

# 3. Edit the template to customize it
bwrb template edit task bug-report

# 4. List templates to verify
bwrb template list task

# 5. Use the template
bwrb new task --template bug-report

# 6. Validate templates match current schema
bwrb template validate
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **defaults** | Pre-fill field values (skip prompting) |
| **prompt-fields** | Always prompt for these fields, even with defaults |
| **Date expressions** | Dynamic values like `today() + '7d'` |
| **Body variables** | `{fieldName}`, `{date}` replaced at creation |

## Next Steps

- [Creating Templates](/templates/creating-templates/) — Full guide with best practices
- [bwrb template command](/reference/commands/template/) — Command reference
