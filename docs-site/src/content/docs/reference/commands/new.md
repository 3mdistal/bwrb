---
title: bwrb new
description: Create new notes with schema-driven prompts
---

Create a new note with interactive prompts based on your schema.

## Usage

```bash
bwrb new [type]
```

## Examples

```bash
# Interactive type selection
bwrb new

# Direct creation
bwrb new task
bwrb new objective/milestone

# With template
bwrb new task --template bug-report

# Skip templates
bwrb new task --no-template

# JSON mode (scripting)
bwrb new task --json '{"name": "Fix login", "priority": "high"}'
```

## Options

| Option | Description |
|--------|-------------|
| `--template <name>` | Use specific template |
| `--no-template` | Skip template system |
| `--json <data>` | Provide field values as JSON |
| `--output json` | Output result as JSON |

## Behavior

1. Prompts for type (if not specified)
2. Loads template (if available)
3. Prompts for each required field
4. Creates file in `output_dir`
5. Returns path to created file

## See Also

- [Templates](/templates/overview/)
- [Schema](/concepts/schema/)
