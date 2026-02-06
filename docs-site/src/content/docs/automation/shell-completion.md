---
title: Shell Completion
description: Tab completion for commands, types, and paths
---

Enable tab completion for faster CLI usage.

## Setup

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

Run once:

```fish
bwrb completion fish > ~/.config/fish/completions/bwrb.fish
```

## What Gets Completed

| Context | Completion |
|---------|------------|
| `bwrb <TAB>` | Commands: `new`, `edit`, `delete`, `list`, `open`, `search`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `config`, `completion` |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`... |
| `bwrb new <TAB>` | Types from schema: `task`, `idea`... |
| `bwrb list --path <TAB>` | Directories: `Ideas/`, `Projects/`... |

## Vault Awareness

Completions are context-aware:

- Types come from your vault's schema
- Paths come from your vault's directory structure
- No hard-coded values

## See Also

- [bwrb completion command](/reference/commands/completion/)
