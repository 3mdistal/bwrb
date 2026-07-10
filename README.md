# bwrb

Short for **bowerbird**, pronounced "birb".

Schema-driven note management for markdown vaults.

> **Pre-release software.** bwrb is under active development. The CLI works and is usable, but the schema format and command surface may change before v1.0. See the [roadmap](https://github.com/3mdistal/bwrb/blob/main/docs/product/roadmap.md) for current status.

## Documentation policy

- User-facing CLI docs are canonical on the docs site: https://bwrb.dev
- Product rationale/internal notes live in `docs/product/`
- Canon policy and routing rules: [`docs/product/canonical-docs-policy.md`](docs/product/canonical-docs-policy.md)

## Overview

`bwrb` creates, queries, migrates, and audits markdown notes against a version 2
type schema. It supports:

- Flat types with inheritance, reusable traits, ownership, and templates
- Dynamic frontmatter prompts, body sections, and instance scaffolding
- Canonical `list` discovery by filters, exact name, fuzzy name, body matches,
  stable ID, or document lineage
- Schema migrations plus conservative audit and repair workflows
- Partial and relative dates, including schema-defined custom calendars
- Native document forks with immutable provenance, lineage inspection, and
  fork-safe deletion
- Command-specific JSON automation and explicit non-interactive safety
- Any markdown vault selected through discovery or the global `--vault` flag

## Prerequisites

- **Node.js** >= 22

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

Initialize each vault you want to use with bwrb:

```sh
mkdir my-vault
cd my-vault
bwrb init --yes
```

This creates a version 2 `.bwrb/schema.json`. See the
[Quick Start](https://bwrb.dev/getting-started/quick-start/) for a runnable first
schema.

## Usage

```sh
# Vault path resolution (in order of precedence):
# 1. --vault=<path> or -v <path> argument
# 2. Find-up: nearest ancestor with .bwrb/schema.json
# 3. BWRB_VAULT environment variable
# 4. Find-down under cwd if not in a vault:
#    - 1 candidate => auto-select
#    - multiple => numbered picker (TTY) or error requiring --vault
#      (non-TTY or --output json)

# Interactive mode - prompts for type selection
bwrb new
bwrb --vault=/path/to/vault new

# Direct creation - specify type
bwrb new objective    # Then select subtype (task/milestone/project/goal)
bwrb new idea         # Creates idea directly (no child-type selection)

# Templates
bwrb new task --template bug-report  # Use specific template
bwrb new task --template default     # Use default.md template explicitly
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
bwrb list --output paths idea                # Show vault-relative paths
bwrb list --fields=status,priority idea      # Show selected frontmatter fields in a table
bwrb list --output paths --fields=status objective  # Combine paths + fields

# Resolve, search, and open through list
bwrb list --name "My Note"                   # Resolve by name, path, or alias
bwrb list --name "My Note" --output link     # Output: [[My Note]]
bwrb list --fuzzy "My Nte" --output json      # Ranked matches with scores
bwrb list --body "TODO" --matches             # Detailed file matches (frontmatter included today)
bwrb list --name "My Note" --open --app editor
bwrb list --id "<uuid>" --open --app print

# Preserve a revision as a native document fork, then inspect its family
bwrb new --fork "Briefs/Launch Brief" --label concise --output json
bwrb list --lineage "Briefs/Launch Brief" --output tree

# Help
bwrb --help
bwrb list --help
```

## Schema Structure

The schema file is expected at `<vault>/.bwrb/schema.json`. It defines:

### Types

Version 2 schemas keep all types in one flat map. A child names its parent with
`extends`:

```json
{
  "version": 2,
  "types": {
    "objective": {
      "output_dir": "Objectives",
      "fields": {
        "type": { "value": "objective" },
        "status": {
          "prompt": "select",
          "options": ["planned", "active", "done"],
          "default": "planned"
        }
      }
    },
    "task": {
      "extends": "objective",
      "output_dir": "Objectives/Tasks",
      "fields": {
        "type": { "value": "task" },
        "priority": {
          "prompt": "select",
          "options": ["low", "medium", "high"],
          "default": "medium"
        }
      },
      "field_order": ["type", "status", "priority"]
    }
  }
}
```

### Type Definition

Type properties include:

| Field | Required | Description |
|-------|----------|-------------|
| `extends` | No | Parent type name; defaults to the implicit `meta` root |
| `output_dir` | Yes for `new` | Directory relative to vault root. Schema inspection can report a computed fallback, but current note creation still requires an explicit value ([#811](https://github.com/3mdistal/bwrb/issues/811)) |
| `fields` | No | Field definitions, merged with inherited fields |
| `field_order` | No | Array specifying effective field order |
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

Special values: `$NOW` (local datetime, `YYYY-MM-DD HH:mm`), `$TODAY` (local date, `YYYY-MM-DD`)

**Select from options:**
```json
{
  "status": {
    "prompt": "select",
    "options": ["raw", "backlog", "planned", "in-flight", "settled"],
    "default": "raw"
  }
}
```

**Text input:**
```json
{
  "deadline": {
    "prompt": "text",
    "label": "Deadline (YYYY-MM-DD)",
    "required": false
  }
}
```

**Dynamic (vault query):**

Query notes of a specific type to populate field options:

```json
{
  "milestone": {
    "prompt": "relation",
    "source": "milestone",
    "filter": { "status": { "not_in": ["settled", "ghosted"] } },
    "required": false
  }
}
```

- `source` - Type name to query (e.g., `"milestone"`)
- `filter` - Optional per-field condition object for filtering candidates
- Relation link formatting is vault-wide through `config.link_format`

### Body Sections

Define document structure after frontmatter:

```json
{
  "body_sections": [
    {
      "title": "Steps",
      "level": 2,
      "content_type": "checkboxes",
      "prompt": "list",
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
| `instances` | No | Related notes/tasks to scaffold with the parent |

### Template Defaults and Dates

Template defaults can use date expressions such as `@today+3d` or
`today() + '7d'` for fields whose schema prompt is `date`. Those expressions are
evaluated when the note is created and normalized to the schema's date format.
Defaults on scaffolded `instances` use the same behavior, so child task fields
like `scheduled` or `deadline` can be relative to the creation date.

Non-date fields pass date-looking strings through literally. For example, a text
field default of `@today+3d` is written as `@today+3d`, not evaluated.

### Template Body

The template body becomes the note body, with variable substitution:
- `{fieldName}` - Replaced with frontmatter value
- `{date}` - Today's date (YYYY-MM-DD)
- `{date:FORMAT}` - Formatted date (e.g., `{date:YYYY-MM}`)

### Instance Scaffolding

Templates can define `instances` to create related notes when the parent is
created. Instances may use any configured type, including the same type as the
parent, so a `task` template can scaffold additional `task` notes.

Each instance is filed into the child type's configured `output_dir`, not beside
the parent unless both types use the same output directory. Existing instance
files are skipped rather than overwritten.

```yaml
---
type: template
template-for: task
description: Builder article production checklist
defaults:
  status: planned
  scheduled: "@today+1d"
  deadline: "@today+7d"
instances:
  - type: task
    defaults:
      name: "Outline article"
      scheduled: "@today+1d"
  - type: task
    defaults:
      name: "Draft article"
      scheduled: "@today+3d"
  - type: task
    defaults:
      name: "Review and publish article"
      scheduled: "@today+5d"
---
```

Instance `defaults` and explicit child `filename` values do not interpolate
parent placeholders like `{name}`. Use literal child names/filenames, rely on
the child type's own filename pattern, or generate article-specific child names
with a wrapper script. Avoid braces in explicit child filenames unless you want
the braces to be part of the actual filename.

### CLI Usage

```sh
# Auto-use default.md if it exists
bwrb new task

# Use specific template
bwrb new task --template bug-report

# Require default template (error if not found)
bwrb new task --template default

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
bwrb template list idea default      # Show specific template details

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

# Delete a template
bwrb template delete idea quick
```

## Adding a New Type

1. Add type definition under `types`:
   ```json
   {
     "types": {
       "my-type": {
         "output_dir": "My/Output/Dir",
         "fields": {
           "type": { "value": "my-type" },
           "status": { "prompt": "select", "options": ["raw", "active", "done"] }
         },
         "field_order": ["type", "status"],
         "body_sections": []
       }
     }
   }
   ```

2. Validate schema (optional):
   ```sh
   ./validate_schema.sh
   ```

## Schema Validation

The schema structure is defined by `schema.schema.json` (JSON Schema draft-07). To validate:

```sh
./validate_schema.sh
```

> **Contributors:** `schema.schema.json` and `docs-site/public/schema.json` are
> **generated** from the Zod source of truth in `src/types/schema.ts` — do not
> edit them by hand. After changing the Zod schema run `pnpm schema:gen` and
> commit the result. CI (`pnpm schema:check`, part of `pnpm qa`) fails if the
> committed files are stale.

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
│   ├── types/
│   │   └── schema.ts         # Zod schema definitions (source of truth)
│   └── tools/
│       └── schema/
│           └── generate-json-schema.ts  # Generates the JSON Schema from Zod
├── tests/
│   └── ts/                   # TypeScript test suite
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── schema.schema.json        # GENERATED JSON Schema (run `pnpm schema:gen`)
└── README.md
```

**Each vault:**
```
my-vault/
└── .bwrb/
    └── schema.json     # Vault-specific type definitions
```

## Finding and Opening Notes

### `bwrb list`

`list` is the canonical query, search, and opening surface. Resolve by name,
path, alias, or stable ID; run fuzzy or body searches; and optionally open the
selected result.

```sh
bwrb list --name "My Note"                             # Case-insensitive resolution
bwrb list --name "Ideas/My Note.md" --output link      # [[My Note]]
bwrb list --fuzzy "My Nte" --output json               # Ranked candidates
bwrb list --body "TODO" --matches --context 0          # Detailed file matches
bwrb list --name "My Note" --open --app editor         # Open in editor
bwrb list --id "<uuid>" --open --app print             # Stable-id path lookup
```

**App modes:**
- `obsidian` - Open in Obsidian via URI scheme
- `editor` - Open in `$VISUAL` or `$EDITOR`
- `system` - Open with system default handler (default)
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
bwrb list --name "My Note" --open --app print --output json
```

Name resolution uses the shortest unambiguous wikilink form:
- Basename if unique across vault: `[[My Note]]`
- Full path if ambiguous: `[[Ideas/My Note]]`

```sh
bwrb list --name "My Note" --output link --picker none
bwrb list --name "Amb" --picker none --output json
```

**Neovim/scripting example:**
```sh
# Copy wikilink to clipboard (macOS)
bwrb list --name "My Note" --output link --picker none | pbcopy

# Use in a Lua script
local link = vim.fn.system("bwrb list --name 'My Note' --output link --picker none")
```

The older `bwrb search` and `bwrb open` commands remain callable for script
compatibility, but are hidden from the canonical top-level help and completion
lists.

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

- **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `recent`, `audit`,
  `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, and `config`.
  `init` appears in `bwrb --help` but is currently missing from generated root
  completion candidates ([#810](https://github.com/3mdistal/bwrb/issues/810)).
- **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
- **Types**: `bwrb list --type <TAB>` shows types from your schema (task, idea, etc.)
- **Paths**: `bwrb list --path <TAB>` shows vault directories (Ideas/, Objectives/, etc.)

## Running Tests

```sh
pnpm test              # Run tests
pnpm test:coverage     # Run with coverage report
pnpm typecheck         # Type checking
pnpm docs:lint         # Verify canonical docs concept links
```

## Docs Site

Run docs-site workflows from the repository root:

```sh
pnpm docs:install      # Install docs-site dependencies
pnpm docs:dev          # Start docs dev server
pnpm docs:build        # Build docs site
pnpm docs:preview      # Preview built docs site
```

For docs-site details and deployment notes, see `docs-site/README.md`.

If you hit local docs contributor setup quirks (ignored build scripts or transient TS diagnostics), see `docs-site/README.md#contributor-troubleshooting`.
