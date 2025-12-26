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

## Running Tests

```sh
pnpm test              # Run tests
pnpm test:coverage     # Run with coverage report
pnpm typecheck         # Type checking
```
