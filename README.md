# ovault

Schema-driven template creation and editing for Obsidian vaults.

## Overview

`ovault` is a CLI tool that creates and edits Obsidian markdown files based on a hierarchical type schema. It supports:

- Interactive type selection with subtype navigation
- Dynamic frontmatter prompts (enums, text input, vault queries)
- Configurable body sections with various content types
- Edit mode for updating existing files
- List and filter notes by type and frontmatter fields
- Works with any vault via the `--vault` flag

## Prerequisites

- **Node.js** >= 18

## Installation

### From source (development)

```sh
cd ~/Developer/ovault
pnpm install
pnpm build
pnpm link --global  # Makes 'ovault' available globally
```

### Development mode

```sh
pnpm dev -- new idea  # Run without building
```

## Setup

Create a `.ovault/schema.json` in each vault you want to use with ovault.

## Usage

```sh
# Vault path resolution (in order of precedence):
# 1. --vault=<path> or -v <path> argument
# 2. OVAULT_VAULT environment variable  
# 3. Current working directory

# Interactive mode - prompts for type selection
ovault new
ovault --vault=/path/to/vault new

# Direct creation - specify type
ovault new objective    # Then select subtype (task/milestone/project/goal)
ovault new idea         # Creates idea directly (no subtypes)

# Templates
ovault new task --template bug-report  # Use specific template
ovault new task --default              # Use default.md template  
ovault new task --no-template          # Skip templates, use schema only

# Edit existing file
ovault edit path/to/file.md
ovault edit Objectives/Tasks/My\ Task.md

# List objects by type
ovault list idea                 # List all ideas (names only)
ovault list objective            # List all objectives (tasks, milestones, etc.)
ovault list objective/task       # List only tasks
ovault list objective/milestone  # List only milestones

# List output options
ovault list --paths idea                       # Show vault-relative paths
ovault list --fields=status,priority idea      # Show selected frontmatter fields in a table
ovault list --paths --fields=status objective  # Combine paths + fields

# Open a note by query (or browse all)
ovault open                                    # Browse all notes with picker
ovault open "My Note"                          # Open in Obsidian (default)
ovault open "My Note" --app editor             # Open in $EDITOR
ovault open "My Note" --app print              # Just print the path
ovault open "Amb" --picker fzf                 # Use fzf for ambiguous matches

# Generate a wikilink (or browse all)
ovault link                                    # Browse all notes with picker
ovault link "My Note"                          # Output: [[My Note]]
ovault link "My Note" --bare                   # Output: My Note (no brackets)
ovault link "Amb" --output json                # JSON output for scripting

# Help
ovault help
```

## Schema Structure

The schema file is expected at `<vault>/.ovault/schema.json`. It defines:

### Enums

Shared value lists for select prompts:

```json
{
  "enums": {
    "status": ["raw", "backlog", "planned", "in-flight", "settled", "ghosted"]
  }
}
```

### Types

Hierarchical type definitions. Types can have subtypes for nested categorization:

```json
{
  "types": {
    "objective": {
      "subtypes": {
        "task": { /* type definition */ },
        "milestone": { /* type definition */ }
      }
    },
    "idea": {
      "output_dir": "Objectives/Ideas",
      "frontmatter": { /* ... */ }
    }
  }
}
```

### Type Definition

Each leaf type requires:

| Field | Required | Description |
|-------|----------|-------------|
| `output_dir` | Yes | Directory relative to vault root |
| `frontmatter` | Yes | Field definitions |
| `name_field` | No | Label for name prompt (default: "Name") |
| `frontmatter_order` | No | Array specifying field order |
| `body_sections` | No | Array of section definitions |

### Frontmatter Fields

Fields can be static or prompted:

**Static value:**
```json
{
  "type": { "value": "objective" },
  "creation-date": { "value": "$NOW" }
}
```

Special values: `$NOW` (datetime), `$TODAY` (date)

**Select from enum:**
```json
{
  "status": {
    "prompt": "select",
    "enum": "status",
    "default": "raw"
  }
}
```

**Text input:**
```json
{
  "deadline": {
    "prompt": "input",
    "label": "Deadline (YYYY-MM-DD)",
    "required": false
  }
}
```

**Dynamic (vault query):**
```json
{
  "milestone": {
    "prompt": "dynamic",
    "source": "active_milestones",
    "format": "quoted-wikilink"
  }
}
```

Formats: `plain`, `wikilink` (`[[value]]`), `quoted-wikilink` (`"[[value]]"`)

### Dynamic Sources

Query the vault for options:

```json
{
  "dynamic_sources": {
    "active_milestones": {
      "dir": "Objectives/Milestones",
      "filter": {
        "status": { "not_in": ["settled", "ghosted"] }
      }
    }
  }
}
```

Filter conditions: `equals`, `not_equals`, `in`, `not_in`

### Body Sections

Define document structure after frontmatter:

```json
{
  "body_sections": [
    {
      "title": "Steps",
      "level": 2,
      "content_type": "checkboxes",
      "prompt": "multi-input",
      "prompt_label": "Steps (comma-separated)"
    },
    {
      "title": "Notes",
      "level": 2,
      "content_type": "paragraphs",
      "children": [
        { "title": "Subsection", "level": 3, "content_type": "bullets" }
      ]
    }
  ]
}
```

Content types: `none`, `paragraphs`, `bullets`, `checkboxes`

## Templates

Templates provide reusable defaults and body structure for note creation. They're stored in `.ovault/templates/`, organized by type path.

### Template Location

```
my-vault/
└── .ovault/
    ├── schema.json
    └── templates/
        ├── idea/
        │   └── default.md           # Default template for ideas
        └── objective/
            └── task/
                ├── default.md       # Default template for tasks
                └── bug-report.md    # Bug report template
```

### Template Format

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

## Expected Behavior

## Actual Behavior
```

### Template Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Must be `template` |
| `template-for` | Yes | Type path (e.g., `objective/task`) |
| `description` | No | Human-readable description |
| `defaults` | No | Default field values (skip prompting) |
| `prompt-fields` | No | Fields to always prompt for, even with defaults |
| `filename-pattern` | No | Override default filename |

### Template Body

The template body becomes the note body, with variable substitution:
- `{fieldName}` - Replaced with frontmatter value
- `{date}` - Today's date (YYYY-MM-DD)
- `{date:FORMAT}` - Formatted date (e.g., `{date:YYYY-MM}`)

### CLI Usage

```sh
# Auto-use default.md if it exists
ovault new task

# Use specific template
ovault new task --template bug-report

# Require default template (error if not found)
ovault new task --default

# Skip template system
ovault new task --no-template

# JSON mode with templates
ovault new task --json '{"Task name": "Fix bug"}' --template bug-report
```

### Template Discovery

Templates use **strict matching** - only templates in the exact type path directory are considered:
- `objective/task` → `.ovault/templates/objective/task/*.md`
- `idea` → `.ovault/templates/idea/*.md`

There is no inheritance from parent types.

### Template Management

Use the `template` command to manage templates:

```sh
# List all templates
ovault template list
ovault template list objective/task    # Filter by type

# Show template details
ovault template show idea default

# Validate templates against schema
ovault template validate               # All templates
ovault template validate idea          # Templates for specific type

# Create new template interactively
ovault template new idea
ovault template new objective/task --name bug-report

# Create template from JSON
ovault template new idea --name quick --json '{"defaults": {"status": "raw"}}'

# Edit template interactively
ovault template edit idea default

# Edit template from JSON
ovault template edit idea default --json '{"defaults": {"priority": "high"}}'
```

## Adding a New Type

1. Add enum values if needed:
   ```json
   { "enums": { "my-enum": ["option1", "option2"] } }
   ```

2. Add type definition under `types`:
   ```json
   {
     "types": {
       "my-type": {
         "output_dir": "My/Output/Dir",
         "name_field": "Item name",
         "frontmatter": {
           "type": { "value": "my-type" },
           "status": { "prompt": "select", "enum": "status" }
         },
         "frontmatter_order": ["type", "status"],
         "body_sections": []
       }
     }
   }
   ```

3. Validate schema (optional):
   ```sh
   ./validate_schema.sh
   ```

## Schema Validation

The schema structure is defined by `schema.schema.json` (JSON Schema draft-07). To validate:

```sh
./validate_schema.sh
```

## File Structure

**ovault repo:**
```
ovault/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/
│   │   ├── new.ts            # Create new notes
│   │   ├── edit.ts           # Edit existing notes
│   │   └── list.ts           # List and filter notes
│   ├── lib/
│   │   ├── schema.ts         # Schema loading & validation
│   │   ├── frontmatter.ts    # Frontmatter parsing & writing
│   │   ├── query.ts          # Filter parsing & evaluation
│   │   ├── vault.ts          # Vault operations
│   │   └── prompt.ts         # Interactive prompts
│   └── types/
│       └── schema.ts         # Zod schema definitions
├── tests/
│   └── ts/                   # TypeScript test suite
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── schema.schema.json        # JSON Schema for validating vault schemas
└── README.md
```

**Each vault:**
```
my-vault/
└── .ovault/
    └── schema.json     # Vault-specific type definitions
```

## Navigation Commands

### `ovault open [query]`

Open a note by name or path query. If no query is provided, shows a picker to browse all notes.

```sh
ovault open                              # Browse all notes with picker
ovault open "My Note"                    # Open in Obsidian (default)
ovault open "my note"                    # Case-insensitive
ovault open "Ideas/My Note"              # By path
ovault open "My Note" --app editor       # Open in $VISUAL or $EDITOR
ovault open "My Note" --app system       # Open with system default
ovault open "My Note" --app print        # Just print the resolved path
```

**App modes:**
- `obsidian` - Open in Obsidian via URI scheme (default)
- `editor` - Open in `$VISUAL` or `$EDITOR`
- `system` - Open with system default handler
- `print` - Just print the resolved path

**Environment variable:** Set `OVAULT_DEFAULT_APP` to change the default app mode:
```sh
export OVAULT_DEFAULT_APP=editor  # Always open in $EDITOR by default
```

**Picker modes** (when query matches multiple files or no query):
- `--picker auto` - Use fzf if available, else numbered select (default)
- `--picker fzf` - Force fzf
- `--picker numbered` - Force numbered select
- `--picker none` - Error on ambiguity (for scripting)

**JSON output** (implies `--picker none`):
```sh
ovault open "My Note" --app print --output json
```

### `ovault link [query]`

Generate a wikilink to a note. If no query is provided, shows a picker to browse all notes. Uses shortest unambiguous form:
- Basename if unique across vault: `[[My Note]]`
- Full path if ambiguous: `[[Ideas/My Note]]`

```sh
ovault link                              # Browse all notes with picker
ovault link "My Note"                    # Output: [[My Note]]
ovault link "My Note" --bare             # Output: My Note
ovault link "Amb" --picker none --output json  # Scripting mode
```

**Neovim/scripting example:**
```sh
# Copy wikilink to clipboard (macOS)
ovault link "My Note" | pbcopy

# Use in a Lua script
local link = vim.fn.system("ovault link 'My Note' --picker none --bare")
```

## Running Tests

```sh
pnpm test              # Run tests
pnpm test:coverage     # Run with coverage report
pnpm typecheck         # Type checking
```
