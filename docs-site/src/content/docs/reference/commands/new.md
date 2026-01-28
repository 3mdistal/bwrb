---
title: bwrb new
description: Create new notes with schema-driven prompts
---

Create a new note with interactive prompts based on your schema.

## Synopsis

```bash
bwrb new [options] [type]
```

## Options

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Type of note to create (alternative to positional argument) |
| `-o, --open` | Open the note after creation |
| `--json <frontmatter>` | Create note non-interactively with JSON frontmatter |
| `--template <name>` | Use a specific template (use "default" for default.md) |
| `--no-template` | Skip template selection, use schema only |
| `--no-instances` | Skip instance scaffolding (when template has instances) |
| `--owner <wikilink>` | Owner note for owned types (e.g., `"[[My Novel]]"`) |
| `--standalone` | Create as standalone (skip owner selection for ownable types) |

## Examples

### Basic Creation

```bash
# Interactive type selection
bwrb new

# Direct creation by type
bwrb new idea
bwrb new objective/task

# Create and open immediately
bwrb new draft --open
```

### Templates

```bash
# Use specific template
bwrb new task --template bug-report

# Use default.md template explicitly
bwrb new task --template default

# Skip templates, use schema only
bwrb new task --no-template
```

### Ownership

Some types support ownership relationships. When creating an owned type:

```bash
# Prompted: standalone or owned?
bwrb new research

# Create in shared location (standalone)
bwrb new research --standalone

# Create owned by specific note
bwrb new research --owner "[[My Novel]]"
```

### Instance Scaffolding

Some templates define child instances that are automatically created with the parent note:

```bash
# Create project with scaffolded research notes
bwrb new project --template with-research

# Skip instance creation
bwrb new project --template with-research --no-instances
```

When a template defines instances, the CLI displays what files were created:

```
✓ Created: Projects/My Project.md

Instances created:
  ✓ Projects/Background Research.md
  ✓ Projects/Competitor Analysis.md

✓ Created 3 files (1 parent + 2 instances)
```

### Non-interactive (JSON) Mode

For scripting and automation:

```bash
# Basic JSON creation
bwrb new idea --json '{"name": "My Idea", "status": "raw"}'

# With template
bwrb new task --json '{"name": "Bug"}' --template bug-report

# With body sections
bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'

# With instance scaffolding (JSON output includes instances)
bwrb new project --json '{"name": "My Project"}' --template with-research
```

The `_body` field accepts section names as keys, with string or string array values.

JSON output for templates with instances includes an `instances` object:

```json
{
  "success": true,
  "path": "Projects/My Project.md",
  "instances": {
    "created": ["Projects/Background Research.md", "Projects/Competitor Analysis.md"],
    "skipped": [],
    "errors": []
  }
}
```

## Behavior

1. **Type resolution**: Prompts for type if not specified (with subtype navigation)
2. **Template loading**: Loads matching template if available (unless `--no-template`)
3. **Field prompts**: Prompts for each field defined in schema/template
4. **File creation**: Creates file in the type's `output_dir`
5. **System fields**: Writes `id` and `name` as bwrb-managed frontmatter fields
6. **Output**: Returns path to created file

## Template Discovery

Templates are stored in `.bwrb/templates/{type}/{subtype}/*.md`:
- If `default.md` exists, it's used automatically
- If multiple templates exist without `default.md`, you'll be prompted to select
- Use `--no-template` to skip template system entirely

## See Also

- [Templates Overview](/templates/overview/) — Template system concepts
- [bwrb template](/reference/commands/template/) — Template management
- [Schema](/concepts/schema/) — Schema structure and field types
