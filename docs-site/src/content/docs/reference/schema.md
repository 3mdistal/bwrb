---
title: Schema Reference
description: Complete reference for .bwrb/schema.json structure and properties
---

The schema file defines your vault's type system: what kinds of notes exist, what fields they have, and how they relate to each other.

For conceptual overview, see [Schema](/concepts/schema/) and [Types and Inheritance](/concepts/types-and-inheritance/).

## File Location

The schema lives at `.bwrb/schema.json` in your vault root:

```
my-vault/
├── .bwrb/
│   └── schema.json    # Your schema definition
├── Ideas/
├── Objectives/
└── ...
```

## Top-Level Structure

```json
{
  "$schema": "https://bwrb.dev/schema.schema.json",
  "version": 2,
  "schemaVersion": "1.0.0",
  "types": { ... },
  "config": { ... },
  "audit": { ... }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `$schema` | string | No | JSON Schema URI for editor validation |
| `version` | integer | No | Schema format version (default: `2`) |
| `schemaVersion` | string | No | User-controlled version for migrations (semver) |
| `types` | object | **Yes** | Type definitions |
| `config` | object | No | Vault-wide settings |
| `audit` | object | No | Audit command configuration |

---

## Types

Types define categories of notes. Each type has a name (the object key) and a definition.

### Minimal Type

```json
{
  "types": {
    "idea": {
      "fields": {
        "status": { "prompt": "select", "options": ["raw", "developing", "mature"] }
      }
    }
  }
}
```

### Type Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `extends` | string | `"meta"` | Parent type name |
| `fields` | object | `{}` | Field definitions |
| `field_order` | array | — | Order of fields in frontmatter |
| `body_sections` | array | — | Body structure after frontmatter |
| `recursive` | boolean | `false` | Whether type can contain instances of itself |
| `plural` | string | auto | Custom plural for folder naming (e.g., `"research"` instead of `"researchs"`) |

### Inheritance

All types inherit from `meta` (implicitly created if not defined). Types form a single-inheritance tree:

```json
{
  "types": {
    "meta": {
      "fields": {
        "status": { "prompt": "select", "options": ["raw", "active", "done"] },
        "created": { "value": "$NOW" }
      }
    },
    "objective": {
      "extends": "meta",
      "fields": {
        "deadline": { "prompt": "date" }
      }
    },
    "task": {
      "extends": "objective",
      "fields": {
        "status": { "default": "inbox" },
        "assignee": { "prompt": "relation", "source": "person" }
      }
    }
  }
}
```

A `task` inherits:
- `status` and `created` from `meta`
- `deadline` from `objective`
- Adds `assignee`, overrides `status` default to `"inbox"`

**Inheritance rules:**
- Type names must be unique across the entire schema
- No cycles allowed (a type cannot extend its own descendant)
- Child types can only override `default` values, not field structure

### Recursive Types

Types with `recursive: true` can have a `parent` field pointing to the same type:

```json
{
  "task": {
    "extends": "objective",
    "recursive": true,
    "fields": {
      "parent": {
        "prompt": "relation",
        "source": "task"
      }
    }
  }
}
```

This enables subtasks, nested chapters, etc. Cycles are prevented—a note cannot be its own ancestor.

---

## Fields

Fields define the frontmatter properties of a note. Each field has a name (the object key) and a definition specifying how values are collected and stored.

### Field Types Overview

| Type | Prompt | Stored As | Use Case |
|------|--------|-----------|----------|
| Static | — | as defined | Fixed values, computed dates |
| `text` | Single-line input | `string` | Names, descriptions |
| `number` | Numeric input | `number` | Priority, counts |
| `boolean` | Y/n confirm | `true`/`false` | Flags, toggles |
| `date` | Date input | `string` (YYYY-MM-DD) | Deadlines, dates |
| `select` | Picker from options | `string` or `string[]` | Status, category |
| `relation` | Picker from vault | `string` (wikilink) | Links to other notes |
| `list` | Comma-separated input | `string[]` | Tags, aliases |

### Static Fields

Fields with `value` are not prompted—they're computed automatically:

```json
{
  "type": { "value": "task" },
  "created": { "value": "$NOW" },
  "date": { "value": "$TODAY" }
}
```

**Special values:**
- `$NOW` — Current datetime: `2025-01-07 14:30`
- `$TODAY` — Current date: `2025-01-07`

### text

Free-form single-line input.

```json
{
  "description": {
    "prompt": "text",
    "label": "Brief description",
    "required": false
  }
}
```

### number

Numeric input with validation.

```json
{
  "priority": {
    "prompt": "number",
    "default": "3"
  }
}
```

### boolean

Yes/no confirmation prompt.

```json
{
  "archived": {
    "prompt": "boolean",
    "default": "false"
  }
}
```

Stored as `true` or `false` (YAML booleans).

### date

Date input with YYYY-MM-DD format.

```json
{
  "deadline": {
    "prompt": "date",
    "required": false
  }
}
```

### select

Choose from predefined options.

```json
{
  "status": {
    "prompt": "select",
    "options": ["raw", "inbox", "in-flight", "done", "dropped"],
    "default": "raw",
    "required": true
  }
}
```

For multi-select (array output):

```json
{
  "tags": {
    "prompt": "select",
    "options": ["urgent", "blocked", "waiting", "review"],
    "multiple": true
  }
}
```

### relation

Link to other notes in the vault. Shows a picker filtered by type.

```json
{
  "milestone": {
    "prompt": "relation",
    "source": "milestone",
    "required": false
  }
}
```

**Source options:**
- Specific type: `"source": "milestone"` — only milestones
- Type branch: `"source": "objective"` — objectives and all descendants (task, milestone, project, etc.)
- Any note: `"source": "any"` — entire vault

**Filtering results:**

```json
{
  "milestone": {
    "prompt": "relation",
    "source": "milestone",
    "filter": {
      "status": { "not_in": ["done", "dropped"] }
    }
  }
}
```

Filter conditions:
- `equals`: Field must equal value
- `not_equals`: Field must not equal value
- `in`: Field must be one of values
- `not_in`: Field must not be one of values

**Multiple relations:**

```json
{
  "related": {
    "prompt": "relation",
    "source": "any",
    "multiple": true
  }
}
```

**Owned relations:**

When `owned: true`, referenced notes are private to the parent and colocate in the parent's folder:

```json
{
  "chapters": {
    "prompt": "relation",
    "source": "chapter",
    "multiple": true,
    "owned": true
  }
}
```

Owned notes:
- Live in the owner's subfolder (e.g., `drafts/My Novel/chapters/`)
- Cannot be referenced by other notes' frontmatter fields
- Are still discoverable via `bwrb list` and `bwrb search`

### list

Comma-separated input stored as an array.

```json
{
  "aliases": {
    "prompt": "list",
    "label": "Aliases (comma-separated)"
  }
}
```

Output format controlled by `list_format`:
- `yaml-array` (default): `["one", "two", "three"]`
- `comma-separated`: `"one, two, three"`

---

## Field Properties Reference

Complete list of field properties:

| Property | Type | Applies To | Description |
|----------|------|------------|-------------|
| `value` | string | static | Fixed value (mutually exclusive with `prompt`) |
| `prompt` | string | prompted | Prompt type: `text`, `number`, `boolean`, `date`, `select`, `relation`, `list` |
| `label` | string | prompted | Custom label shown during prompting |
| `required` | boolean | prompted | Whether field must have a value (default: `false`) |
| `default` | string | prompted | Default value if user skips prompt |
| `options` | array | `select` | Allowed values for selection |
| `multiple` | boolean | `select`, `relation` | Allow multiple values (default: `false`) |
| `source` | string | `relation` | Type name to filter picker, or `"any"` |
| `filter` | object | `relation` | Filter conditions for source query |
| `owned` | boolean | `relation` | Whether referenced notes are owned/colocated (default: `false`) |
| `list_format` | string | `list` | Output format: `yaml-array` or `comma-separated` |

---

## Body Sections

Define document structure after frontmatter:

```json
{
  "body_sections": [
    {
      "title": "Description",
      "level": 2,
      "content_type": "paragraphs"
    },
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
      "content_type": "bullets",
      "children": [
        { "title": "Blockers", "level": 3 }
      ]
    }
  ]
}
```

### Section Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | string | **Yes** | Section heading text |
| `level` | integer | No | Heading level 2-6 (default: `2`) |
| `content_type` | string | No | Placeholder type: `none`, `paragraphs`, `bullets`, `checkboxes` |
| `prompt` | string | No | If `"list"`, prompts for initial content during creation |
| `prompt_label` | string | No | Label for the content prompt |
| `children` | array | No | Nested subsections |

---

## Config

Vault-wide settings:

```json
{
  "config": {
    "link_format": "wikilink",
    "open_with": "obsidian",
    "editor": "nvim",
    "visual": "code",
    "obsidian_vault": "My Vault"
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `link_format` | string | `"wikilink"` | Link format for relations: `wikilink` (`[[Note]]`) or `markdown` (`[Note](Note.md)`) |
| `open_with` | string | `"visual"` | Default for `--open`: `editor`, `visual`, or `obsidian` |
| `editor` | string | `$EDITOR` | Terminal editor command |
| `visual` | string | `$VISUAL` | GUI editor command |
| `obsidian_vault` | string | auto | Obsidian vault name for URI scheme |

---

## Audit Config

Configure the [`bwrb audit`](/reference/commands/audit/) command:

```json
{
  "audit": {
    "ignored_directories": ["Archive", ".obsidian", "Templates"],
    "allowed_extra_fields": ["aliases", "cssclass", "publish"]
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `ignored_directories` | array | Directories to skip during audit |
| `allowed_extra_fields` | array | Extra frontmatter fields that won't trigger warnings |

---

## IDE Integration

Add `$schema` to your schema file for editor autocomplete and validation:

```json
{
  "$schema": "https://bwrb.dev/schema.schema.json",
  "types": { ... }
}
```

### VS Code

If the URL isn't reachable, configure the schema manually in `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/.bwrb/schema.json"],
      "url": "./node_modules/bwrb/schema.schema.json"
    }
  ]
}
```

Or reference a local copy of `schema.schema.json` from the bwrb repository.

### Neovim

With `nvim-lspconfig` and `jsonls`:

```lua
require('lspconfig').jsonls.setup({
  settings = {
    json = {
      schemas = {
        {
          fileMatch = { "*/.bwrb/schema.json" },
          url = "https://bwrb.dev/schema.schema.json"
        }
      }
    }
  }
})
```

---

## Complete Example

A full schema demonstrating inheritance, relations, body sections, and config:

```json
{
  "$schema": "https://bwrb.dev/schema.schema.json",
  "version": 2,
  "schemaVersion": "1.0.0",
  
  "config": {
    "link_format": "wikilink",
    "open_with": "obsidian"
  },
  
  "audit": {
    "ignored_directories": [".obsidian", "Templates"],
    "allowed_extra_fields": ["aliases", "cssclass"]
  },
  
  "types": {
    "meta": {
      "fields": {
        "status": {
          "prompt": "select",
          "options": ["raw", "active", "settled", "dropped"],
          "default": "raw"
        },
        "created": { "value": "$NOW" }
      }
    },
    
    "idea": {
      "fields": {
        "tags": {
          "prompt": "select",
          "options": ["shower-thought", "research", "project-idea"],
          "multiple": true
        }
      },
      "body_sections": [
        { "title": "Description", "level": 2, "content_type": "paragraphs" }
      ]
    },
    
    "objective": {
      "fields": {
        "deadline": { "prompt": "date" }
      }
    },
    
    "task": {
      "extends": "objective",
      "recursive": true,
      "fields": {
        "status": { "default": "inbox" },
        "priority": {
          "prompt": "select",
          "options": ["low", "medium", "high"],
          "default": "medium"
        },
        "milestone": {
          "prompt": "relation",
          "source": "milestone",
          "filter": {
            "status": { "not_in": ["settled", "dropped"] }
          }
        },
        "parent": {
          "prompt": "relation",
          "source": "task"
        }
      },
      "body_sections": [
        {
          "title": "Steps",
          "level": 2,
          "content_type": "checkboxes",
          "prompt": "list",
          "prompt_label": "Steps (comma-separated)"
        },
        { "title": "Notes", "level": 2, "content_type": "bullets" }
      ]
    },
    
    "milestone": {
      "extends": "objective",
      "fields": {
        "project": {
          "prompt": "relation",
          "source": "project"
        }
      }
    },
    
    "project": {
      "extends": "objective"
    },
    
    "draft": {
      "fields": {
        "draft-status": {
          "prompt": "select",
          "options": ["idea", "outlining", "drafting", "revising", "done"],
          "default": "idea"
        },
        "chapters": {
          "prompt": "relation",
          "source": "chapter",
          "multiple": true,
          "owned": true
        }
      }
    },
    
    "chapter": {
      "extends": "draft",
      "recursive": true,
      "fields": {
        "word-count": { "prompt": "number" }
      }
    },
    
    "person": {
      "fields": {
        "email": { "prompt": "text" },
        "company": { "prompt": "text" }
      }
    }
  }
}
```

---

## See Also

- [Schema concept](/concepts/schema/) — Why schema matters
- [Types and Inheritance](/concepts/types-and-inheritance/) — Mental model for type hierarchies
- [Validation and Audit](/concepts/validation-and-audit/) — Keeping notes in sync
- [`bwrb schema`](/reference/commands/schema/) — Schema management commands
- [`bwrb audit`](/reference/commands/audit/) — Validate notes against schema
