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

## Next Steps

- [Creating Templates](/templates/creating-templates/)
- [bwrb template command](/reference/commands/template/)
