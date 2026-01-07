---
title: bwrb delete
description: Remove notes with backlink warnings
---

Delete notes from your vault with safety checks.

## Usage

```bash
bwrb delete <query>
```

## Examples

```bash
# Delete with confirmation
bwrb delete "Old Note"

# Skip confirmation
bwrb delete "Old Note" --execute

# JSON mode
bwrb delete "Old Note" --output json
```

## Options

| Option | Description |
|--------|-------------|
| `-x, --execute` | Skip confirmation prompt |
| `--picker <mode>` | Picker for ambiguous matches |
| `--output json` | JSON output |

## Safety Features

- **Backlink warnings** — Shows notes that link to the target
- **Confirmation prompt** — Requires explicit confirmation
- **Dry-run by default** — Shows what would be deleted

## See Also

- [bwrb bulk](/reference/commands/bulk/)
