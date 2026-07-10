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
| `--fork <target>` | Create a sibling document forked from an exact path, name, alias, or stable UUID |
| `--label <label>` | Name the fork `<source> — <label>` |
| `--name <name>` | Set the fork's frontmatter name and filename explicitly |
| `--output <text\|json>` | Set fork output format (default: `text`; only valid with `--fork`) |

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
  ✓ Research/Background Research.md
  ✓ Research/Competitor Analysis.md

✓ Created 3 files (1 parent + 2 instances)
```

Instances are written to each child type's configured `output_dir`, not beside
the parent unless the schema points both types at the same directory. Templates
may scaffold same-type children, such as a `task` template that creates more
`task` notes. Date expressions in instance defaults evaluate for date fields;
non-date fields remain literal. Instance defaults and explicit instance
filenames do not interpolate parent placeholders like `{name}`.

### Non-interactive (JSON) Mode

For scripting and automation:

```bash
# Basic JSON creation
bwrb new idea --json '{"name": "My Idea", "status": "raw"}'

# With template
bwrb new task --json '{"name": "Bug"}' --template bug-report

# With body sections
bwrb new task --json '{"name": "Fix bug", "_body": {"Steps": ["Step 1", "Step 2"]}}'

# With raw markdown body
bwrb new task --json '{"name": "Quick capture", "_body": "## Notes\n\n- Captured from a script."}'

# With instance scaffolding (JSON output includes instances)
bwrb new project --json '{"name": "My Project"}' --template with-research
```

`--json` mode validates the merged frontmatter before writing. Unknown fields in the JSON input or selected template defaults are rejected unless they are built-in bwrb fields such as `name`.

The `_body` field accepts either a raw Markdown string or an object whose keys are schema body section names. Section-object values may be strings or string arrays. A raw string is written as the note body as-is and bypasses template/body-section generation.

If the note name or resolved filename pattern contains characters that are not portable in filenames, `bwrb new` normalizes the filename by removing invalid characters, collapsing doubled whitespace, and trimming the result. Interactive creation prints a warning. JSON mode includes `nameTransformed` metadata:

```json
{
  "success": true,
  "path": "Ideas/What if we used slashes.md",
  "nameTransformed": {
    "original": "What if we used / slashes?",
    "sanitized": "What if we used slashes",
    "filename": "What if we used slashes.md"
  }
}
```

Paths longer than 200 characters include `pathLengthWarning` in JSON mode and print a warning in interactive mode. Paths longer than 260 characters are rejected.

JSON output for templates with instances includes an `instances` object:

```json
{
  "success": true,
  "path": "Projects/My Project.md",
  "instances": {
    "created": ["Research/Background Research.md", "Research/Competitor Analysis.md"],
    "skipped": [],
    "errors": []
  }
}
```

### Document forks

Forks are ordinary Markdown notes with a small lineage marker. They live beside
their immediate source, receive a fresh `id`, and store the source UUID in
`forked-from`:

```bash
# Creates "Launch Brief — concise.md" beside the source
bwrb new --fork "Launch Brief" --label concise

# Exact paths and stable UUIDs are accepted too
bwrb new --fork "Briefs/Launch Brief.md" --name "Launch Brief v2"
bwrb new --fork 8f48f6a8-55c1-4ea7-9f4b-96735ed24af3 --label alternate

# Script-friendly output
bwrb new --fork "Launch Brief" --label alternate --output json
```

Targets are exact: bwrb never substitutes a fuzzy near-match. Duplicate names
or aliases must be disambiguated with a path or UUID. A legacy source without an
`id` receives one before the fork is written; an invalid existing ID is rejected
without modification.

The child copies the source body and frontmatter, then:

- replaces `id`, `name`, and any inherited `forked-from`;
- removes `prev` and `next` navigation fields;
- resets schema fields marked `reset_on_fork` and applies their defaults;
- clears the type's alias-role field so two notes do not claim one identity;
- preserves unknown schema-drift fields and reports them as warnings.

Without `--name`, `--label` supplies the suffix in `<source> — <label>`. In an
interactive terminal, omitting both prompts with `<source> (fork)` as the
default. `--non-interactive` and `--output json` require `--name` or `--label`.
Fork mode cannot be combined with a positional type, `--type`, templates,
`--json`, instance scaffolding, or ownership-selection flags. An owned note can
only be forked when its owner's field permits multiple children.

## Behavior

1. **Type resolution**: Prompts for type if not specified (with subtype navigation)
2. **Template loading**: Loads matching template if available (unless `--no-template`)
3. **Field prompts**: Prompts for each field defined in schema/template
4. **File creation**: Creates file in the type's `output_dir`
5. **Built-in fields**: Writes system-managed `id`. JSON creation also persists
   its input `name`; interactive creation currently derives the effective name
   from the filename without writing that key
   ([#813](https://github.com/3mdistal/bwrb/issues/813)). The reserved
   `forked-from` provenance field cannot be supplied through `--json`, templates,
   or schema fields/defaults; `new --fork` creates new lineage, while
   [`lineage adopt`](/reference/commands/lineage/) is the guarded in-place path
   for two existing documents
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
- [bwrb lineage](/reference/commands/lineage/) — Adopt existing notes into lineage
