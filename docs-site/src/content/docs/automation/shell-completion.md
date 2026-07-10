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
| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, `config` |
| `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`... |
| `bwrb new <TAB>` | Types from schema: `task`, `idea`... |
| `bwrb list --path <TAB>` | Directories: `Ideas/`, `Projects/`... |

## Vault Awareness

Completions are context-aware:

- Types come from your vault's schema
- Paths come from your vault's directory structure
- No hard-coded values

`bwrb --help` also shows `init`, but generated root completion currently omits
it ([#810](https://github.com/3mdistal/bwrb/issues/810)). The hidden
compatibility commands `open` and `search` remain callable but are intentionally
not taught as canonical root candidates.

## See Also

- [bwrb completion command](/reference/commands/completion/)
