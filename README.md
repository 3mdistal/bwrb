# bwrb

Schema-driven note management for markdown vaults.

## Overview

`bwrb` is a CLI tool that creates and edits markdown files based on a hierarchical type schema. It supports:

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
cd ~/Developer/bwrb
pnpm install
pnpm build
pnpm link --global  # Makes 'bwrb' available globally
```

### Development mode

```sh
pnpm dev -- new idea  # Run without building
```

## Setup

Create a `.bwrb/schema.json` in each vault you want to use with bwrb.

## Usage

```sh
# Vault path resolution (in order of precedence):
# 1. --vault=<path> or -v <path> argument
# 2. BWRB_VAULT environment variable  
# 3. Current working directory

# Interactive mode - prompts for type selection
bwrb new
bwrb --vault=/path/to/vault new

# Direct creation - specify type
bwrb new objective    # Then select subtype (task/milestone/project/goal)
bwrb new idea         # Creates idea directly (no subtypes)

# Templates
bwrb new task --template bug-report  # Use specific template
bwrb new task --default              # Use default.md template  
bwrb new task --no-template          # Skip templates, use schema only

# Edit existing file
bwrb edit path/to/file.md
bwrb edit Objectives/Tasks/My\ Task.md

# List objects by type
bwrb list idea                 # List all ideas (names only)
bwrb list objective            # List all objectives (tasks, milestones, etc.)
bwrb list objective/task       # List only tasks
bwrb list objective/milestone  # List only milestones

# List output options
bwrb list --paths idea                       # Show vault-relative paths
bwrb list --fields=status,priority idea      # Show selected frontmatter fields in a table
bwrb list --paths --fields=status objective  # Combine paths + fields

# Open a note by query (or browse all)
bwrb open                                    # Browse all notes with picker
bwrb open "My Note"                          # Open in Obsidian (default)
bwrb open "My Note" --app editor             # Open in $EDITOR
bwrb open "My Note" --app print              # Just print the path
bwrb open "Amb" --picker fzf                 # Use fzf for ambiguous matches

# Generate a wikilink (or browse all)
bwrb search                                  # Browse all notes with picker
bwrb search "My Note" --wikilink             # Output: [[My Note]]
bwrb search "My Note"                        # Output: My Note (name only)
bwrb search "Amb" --output json              # JSON output for scripting

# Help
bwrb help
```

## Schema Structure

The schema file is expected at `<vault>/.bwrb/schema.json`. It defines:

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

Templates provide reusable defaults and body structure for note creation. They're stored in `.bwrb/templates/`, organized by type path.

### Template Location

```
my-vault/
└── .bwrb/
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
bwrb new task

# Use specific template
bwrb new task --template bug-report

# Require default template (error if not found)
bwrb new task --default

# Skip template system
bwrb new task --no-template

# JSON mode with templates
bwrb new task --json '{"name": "Fix bug"}' --template bug-report
```

### Template Discovery

Templates use **strict matching** - only templates in the exact type path directory are considered:
- `objective/task` -> `.bwrb/templates/objective/task/*.md`
- `idea` -> `.bwrb/templates/idea/*.md`

There is no inheritance from parent types.

### Template Management

Use the `template` command to manage templates:

```sh
# List all templates
bwrb template list
bwrb template list objective/task    # Filter by type

# Show template details
bwrb template show idea default

# Validate templates against schema
bwrb template validate               # All templates
bwrb template validate idea          # Templates for specific type

# Create new template interactively
bwrb template new idea
bwrb template new objective/task --name bug-report

# Create template from JSON
bwrb template new idea --name quick --json '{"defaults": {"status": "raw"}}'

# Edit template interactively
bwrb template edit idea default

# Edit template from JSON
bwrb template edit idea default --json '{"defaults": {"priority": "high"}}'
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

**bwrb repo:**
```
bwrb/
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
└── .bwrb/
    └── schema.json     # Vault-specific type definitions
```

## Navigation Commands

### `bwrb open [query]`

Open a note by name or path query. If no query is provided, shows a picker to browse all notes.

```sh
bwrb open                              # Browse all notes with picker
bwrb open "My Note"                    # Open in Obsidian (default)
bwrb open "my note"                    # Case-insensitive
bwrb open "Ideas/My Note"              # By path
bwrb open "My Note" --app editor       # Open in $VISUAL or $EDITOR
bwrb open "My Note" --app system       # Open with system default
bwrb open "My Note" --app print        # Just print the resolved path
```

**App modes:**
- `obsidian` - Open in Obsidian via URI scheme (default)
- `editor` - Open in `$VISUAL` or `$EDITOR`
- `system` - Open with system default handler
- `print` - Just print the resolved path

**Environment variable:** Set `BWRB_DEFAULT_APP` to change the default app mode:
```sh
export BWRB_DEFAULT_APP=editor  # Always open in $EDITOR by default
```

**Picker modes** (when query matches multiple files or no query):
- `--picker auto` - Use fzf if available, else numbered select (default)
- `--picker fzf` - Force fzf
- `--picker numbered` - Force numbered select
- `--picker none` - Error on ambiguity (for scripting)

**JSON output** (implies `--picker none`):
```sh
bwrb open "My Note" --app print --output json
```

### `bwrb search [query]`

Find notes and generate wikilinks. If no query is provided, shows a picker to browse all notes. Uses shortest unambiguous form:
- Basename if unique across vault: `[[My Note]]`
- Full path if ambiguous: `[[Ideas/My Note]]`

```sh
bwrb search                              # Browse all notes with picker
bwrb search "My Note" --wikilink         # Output: [[My Note]]
bwrb search "My Note"                    # Output: My Note
bwrb search "Amb" --picker none --output json  # Scripting mode
```

**Neovim/scripting example:**
```sh
# Copy wikilink to clipboard (macOS)
bwrb search "My Note" --wikilink | pbcopy

# Use in a Lua script
local link = vim.fn.system("bwrb search 'My Note' --picker none")
```

## Shell Completion

Enable tab completion for commands, types, and paths.

### Bash

Add to `~/.bashrc`:

```bash
eval "$(bwrb completion bash)"
```

### Zsh

Add to `~/.zshrc`:

```zsh
eval "$(bwrb completion zsh)"
```

### Fish

Run once to install:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

### What Gets Completed

- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `open`, etc.
- **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
- **Types**: `bwrb list --type <TAB>` shows types from your schema (task, idea, etc.)
- **Paths**: `bwrb list --path <TAB>` shows vault directories (Ideas/, Objectives/, etc.)

## Running Tests

```sh
pnpm test              # Run tests
pnpm test:coverage     # Run with coverage report
pnpm typecheck         # Type checking
```
