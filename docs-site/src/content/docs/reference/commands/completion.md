---
title: bwrb completion
description: Shell completion scripts
---

Generate shell completion scripts for tab completion.

## Synopsis

```bash
bwrb completion <shell>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `shell` | Shell type: `bash`, `zsh`, `fish` |

## Installation

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

## What Gets Completed

| Context | Completions |
|---------|-------------|
| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `open`, etc. |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`, etc. |
| `bwrb new <TAB>` | Types from your schema |
| `bwrb list --type <TAB>` | Types from your schema |
| `bwrb list --path <TAB>` | Directories in your vault |

## Notes

- Completions are generated dynamically from your vault's schema
- Ensure `BWRB_VAULT` is set or run from within a vault directory
- Restart your shell after adding the completion script

## See Also

- [Shell completion guide](/automation/shell-completion/) — Detailed setup
