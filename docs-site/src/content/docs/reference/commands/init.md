---
title: bwrb init
description: Initialize a new Bowerbird vault
---

Create a `.bwrb/` directory and a version 2 `.bwrb/schema.json` in a new vault.
New vaults use distributed `frontmatter-v1` note identity: each note carries
its stable UUID in `id`, and no shared identity registry is authoritative.

## Synopsis

```bash
bwrb init [options] [path]
```

The positional `path` is the directory to initialize. When it is omitted,
`init` uses the global `--vault` target if supplied, otherwise the current
directory. Unlike commands that open an existing vault, `init` does not run
find-up or find-down discovery for its target. The target directory must already
exist; `init` creates `.bwrb/` inside it, not the directory itself.

## Options

| Option | Description |
| --- | --- |
| `-y, --yes` | Skip prompts and use defaults |
| `-f, --force` | Overwrite an existing `.bwrb/` directory |
| `--output <format>` | `text` (default) or `json` |

## Examples

```bash
# Initialize the current directory without prompts
bwrb init --yes

# Initialize a specific path
mkdir -p ~/notes
bwrb init ~/notes --yes

# Use the global vault target
bwrb --vault ~/notes init --yes

# Machine-readable result
bwrb init ~/notes --yes --output json

# Replace existing Bowerbird configuration (destructive)
bwrb init ~/notes --force --yes
```

`--force` can replace the existing `.bwrb/` configuration, so inspect the
target carefully before using it. A normal `init` refuses to overwrite an
existing configuration.

## See Also

- [Quick Start](/getting-started/quick-start/)
- [Schema Reference](/reference/schema/)
- [Installation](/getting-started/installation/)
