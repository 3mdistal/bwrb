---
title: Quick Start
description: Create your first schema-validated note in 5 minutes
---

This guide walks you through creating a vault with a schema and your first note.

## 1. Create a Vault

A vault is any directory with a `.bwrb/schema.json` file:

```bash
mkdir my-vault
cd my-vault
mkdir -p .bwrb
```

## 2. Define a Schema

Create `.bwrb/schema.json` with a simple type:

```json
{
  "types": {
    "idea": {
      "output_dir": "Ideas",
      "frontmatter": {
        "type": { "value": "idea" },
        "created": { "value": "$NOW" },
        "status": {
          "prompt": "select",
          "options": ["raw", "developing", "mature"],
          "default": "raw"
        }
      }
    }
  }
}
```

## 3. Create a Note

```bash
bwrb new idea
```

Bowerbird prompts you for:
1. A title (becomes the filename)
2. Status (select from options)

The result is a properly-structured markdown file in `Ideas/`.

## 4. List Your Notes

```bash
bwrb list idea
bwrb list idea --fields=status
```

## 5. Audit for Drift

If you manually edit a file and break the schema:

```bash
bwrb audit
```

Bowerbird reports any violations.

## Next Steps

- [Schema concepts](/concepts/schema/) — Understand how schemas work
- [CLI Reference](/reference/commands/new/) — Full command documentation
